import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { enforceContentBudget } from '../common/content-budget';
import { describeSkipReason, fetchFileContent } from '../common/github-content';
import { withRetry } from '../common/retry';
import { maskChangedFiles, maskSecrets } from '../common/secret-mask';
import { isSecretPath } from '../common/secret-path';
import { UnreviewedFilesStore } from '../redis/unreviewed-files.store';
import { ReviewSettingsStore } from '../redis/review-settings.store';
import { LastReviewedShaStore } from '../redis/last-reviewed-sha.store';
import {
  DEFAULT_REVIEW_SETTINGS,
  isReviewTarget,
  parseReviewSettings,
} from '../common/review-settings';
import type { ReviewSettings } from '../common/review-settings';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { sortByReviewPriority } from './changed-file-priority';
import { shouldSendContent } from './content-eligibility';
import type { CollectPrDataCommand } from './dto/collect-pr-data.command';
import type { UnreviewedFile } from './dto/unreviewed-file';
import type {
  ChangedFile,
  ChangedFileStatus,
  ContextFile,
  ReviewRequestPayload,
} from './dto/review-request.payload';

const DIFF_SIZE_LIMIT = 20 * 1024 * 1024;
const SUPPORTED_FILE_STATUSES = new Set<ChangedFileStatus>([
  'added',
  'modified',
  'removed',
  'renamed',
]);

// DOVI.md는 프로젝트 컨텍스트의 최우선 진입점이며 (노션 기획 7.2절), 나머지는 있을 때만 사용한다.
const CONTEXT_ROOT_CANDIDATES = [
  'DOVI.md',
  'README.md',
  'openapi.yaml',
  'openapi.yml',
  'swagger.json',
];
const CONTEXT_DOCS_PREFIX = 'docs/';
const CONTEXT_FILE_SIZE_LIMIT = 200 * 1024;

// 팀 규칙 문서. "이 프로젝트 규칙을 따른 코드"를 지적하는 오탐을 줄이려고 리뷰 기준으로
// 함께 보낸다. 순서가 우선순위다(총량 예산을 넘으면 뒤쪽부터 뺀다).
const RULE_DOC_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
];
// 규칙 문서는 모델에게 지시로 읽히는 텍스트라 일반 컨텍스트 파일(200KB)보다 훨씬 작게 둔다.
const RULE_DOC_SIZE_LIMIT = 50 * 1024;
const RULE_DOCS_TOTAL_BUDGET = 64 * 1024;

// ai-server가 함수 경계/줄 윈도우 컨텍스트를 만들 원본 파일 크기 상한.
const CHANGED_FILE_CONTENT_SIZE_LIMIT = 200 * 1024;
// Kafka 브로커의 기본 message.max.bytes(~1MB)를 넘기지 않도록, PR 하나에서 보내는
// changedFiles[].content 총합에 두는 예산. 파일 하나당 최대 200KB라 파일 수가 많은
// PR은 개별 상한만으로는 부족하다.
const CHANGED_FILE_CONTENT_TOTAL_BUDGET = 512 * 1024;
// content + patch 총합 상한. patch는 content 예산에 안 잡혀서 파일 수가 많은 PR은
// patch만으로 메시지 크기를 넘길 수 있다. contextFiles/메타데이터 몫을 남겨 둔다.
const CHANGED_FILE_TOTAL_BUDGET = 768 * 1024;

// 비교 API 응답은 한 페이지(여기서는 100개)까지만 읽는다. 그보다 크면 증분의 이득이 작고 누락 위험이 커서 전체 리뷰로 간다.
const COMPARE_FILES_PAGE_SIZE = 100;

@Injectable()
export class PrDataCollectorService {
  private readonly logger = new Logger(PrDataCollectorService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly unreviewedFilesStore: UnreviewedFilesStore,
    private readonly reviewSettingsStore: ReviewSettingsStore,
    private readonly lastReviewedShaStore: LastReviewedShaStore,
  ) {}

  async collect(
    command: CollectPrDataCommand,
  ): Promise<ReviewRequestPayload | null> {
    const {
      installationId,
      owner,
      repo,
      prNumber,
      prTitle,
      prBody,
      headSha,
      baseSha,
      repositoryId,
    } = command;

    const octokit =
      await this.installationTokenManager.getOctokit(installationId);

    // include/exclude는 어떤 파일을 가져올지 정하므로 다른 수집보다 먼저 읽는다.
    const settings = await this.loadReviewSettings(
      octokit,
      owner,
      repo,
      baseSha,
      prNumber,
    );
    await this.saveReviewSettings(repositoryId, prNumber, headSha, settings);

    // opt-in(incrementalReview). 기준점을 못 찾거나 비교에 실패하면 null → 전체 리뷰로 폴백한다.
    const incremental = settings.incrementalReview
      ? await this.resolveIncremental(
          octokit,
          owner,
          repo,
          repositoryId,
          prNumber,
          headSha,
        )
      : null;

    const [diffResult, changedFilesResult, contextFilesResult, ruleDocs] =
      await Promise.allSettled([
        this.fetchDiff(octokit, owner, repo, prNumber),
        this.fetchChangedFiles(
          octokit,
          owner,
          repo,
          prNumber,
          headSha,
          settings,
          incremental?.paths,
        ),
        this.fetchContextFiles(octokit, owner, repo, headSha),
        this.fetchRuleDocs(octokit, owner, repo, baseSha),
      ]);

    if (diffResult.status === 'rejected') throw diffResult.reason;
    if (changedFilesResult.status === 'rejected')
      throw changedFilesResult.reason;
    if (contextFilesResult.status === 'rejected')
      throw contextFilesResult.reason;

    const diff = diffResult.value;
    if (diff === null) return null;

    const { changedFiles, unreviewed } = changedFilesResult.value;

    // 리뷰하지 못한 파일은 게시 단계가 리뷰 본문에 안내할 수 있게 넘겨 둔다. 안내는 보조
    // 기능이라 저장에 실패해도 리뷰를 막지 않는다.
    await this.saveUnreviewed(repositoryId, prNumber, headSha, unreviewed);

    // 규칙 문서는 보조 정보라 읽기에 실패해도(fetchRuleDocs는 던지지 않지만) 리뷰를 막지 않는다.
    const contextFiles = [
      ...contextFilesResult.value,
      ...(ruleDocs.status === 'fulfilled' ? ruleDocs.value : []),
    ];

    return {
      reviewJobId: `${repositoryId}:${prNumber}:${headSha}`,
      repositoryId,
      prNumber,
      prTitle,
      prBody,
      headSha,
      baseSha,
      contextFiles,
      changedFiles,
      ...(incremental
        ? { incremental: true, previousHeadSha: incremental.previousHeadSha }
        : {}),
    };
  }

  // /dovi review 같은 PR 대화창 명령은 웹훅 payload에 head/base sha가 없으므로
  // PR 번호만으로 조회해 최신 sha 기준으로 collect()를 실행한다.
  async collectByPrNumber(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
    repositoryId: number,
  ): Promise<ReviewRequestPayload | null> {
    const octokit =
      await this.installationTokenManager.getOctokit(installationId);
    const { data: pr } = await withRetry(() =>
      octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    );

    return this.collect({
      installationId,
      owner,
      repo,
      prNumber,
      prTitle: pr.title,
      prBody: pr.body ?? '',
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      repositoryId,
    });
  }

  private async fetchDiff(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string | null> {
    const response = await withRetry(() =>
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      }),
    );

    const diff = response.data as unknown;
    if (typeof diff !== 'string') {
      this.logger.error(`PR #${prNumber} diff response is not a string.`);
      return null;
    }
    const diffBytes = Buffer.byteLength(diff, 'utf-8');

    if (diffBytes > DIFF_SIZE_LIMIT) {
      this.logger.warn(
        `PR #${prNumber} diff size (${diffBytes} bytes) exceeds 20MB limit. Skipping.`,
      );
      return null;
    }

    return diff;
  }

  private async fetchChangedFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    settings: ReviewSettings,
    onlyPaths?: Set<string>,
  ): Promise<{ changedFiles: ChangedFile[]; unreviewed: UnreviewedFile[] }> {
    const allFiles = await withRetry(() =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    );

    // 레포 설정(include/exclude)으로 제외한 파일은 사용자가 의도한 것이라 미검토로 안내하지 않는다.
    // AI 호출·토큰을 아끼려고 content/patch를 가져오기 전에 거른다.
    const targets = allFiles.filter((file) =>
      isReviewTarget(file.filename, settings),
    );
    // 증분 리뷰면 마지막 리뷰 이후 바뀐 파일만 남긴다. patch는 PR 전체 기준 그대로라 줄 번호가 맞는다.
    const files =
      onlyPaths === undefined
        ? targets
        : targets.filter((file) => onlyPaths.has(file.filename));
    if (files.length < allFiles.length) {
      this.logger.log(
        `PR #${prNumber} 레포 설정(include/exclude)으로 ${allFiles.length - files.length}개 파일 제외`,
      );
    }

    // GitHub는 너무 큰 파일에는 patch를 주지 않는다. 바이너리·순수 이름 변경도 patch가 없지만
    // 그때는 변경 줄 수(changes)가 0이라 "리뷰할 내용이 없는 것"이므로 미검토로 보지 않는다.
    const unreviewed: UnreviewedFile[] = files
      .filter(
        (file) =>
          SUPPORTED_FILE_STATUSES.has(file.status as ChangedFileStatus) &&
          file.status !== 'removed' &&
          file.patch === undefined &&
          file.changes > 0,
      )
      .map((file) => ({
        filePath: file.filename,
        reason: 'no-patch' as const,
      }));

    const changedFiles = files
      .filter((file): file is typeof file & { status: ChangedFileStatus } =>
        SUPPORTED_FILE_STATUSES.has(file.status as ChangedFileStatus),
      )
      .map(
        (file): ChangedFile => ({
          filePath: file.filename,
          status: file.status,
          patch: file.patch,
        }),
      );

    // content 를 실지 못한 파일은 이유를 남긴다. 파일이 리뷰 컨텍스트에서 빠지면 모델은 그
    // 사실만 알고 이유는 모르기 때문에, 로그가 없으면 "왜 이 파일이 리뷰에 없나"를 추적할 수단이
    // 사라진다 (실제로 175바이트 파일 누락 원인을 찾느라 API 를 직접 호출해봐야 했다).
    const skipped: string[] = [];

    await Promise.all(
      changedFiles.map(async (file) => {
        if (file.status === 'removed') return;
        if (!shouldSendContent(file.filePath)) {
          skipped.push(
            `${file.filePath} (텍스트 소스가 아니거나 생성·minified 파일)`,
          );
          return;
        }
        if (isSecretPath(file.filePath)) {
          skipped.push(`${file.filePath} (시크릿 경로)`);
          return;
        }

        const result = await fetchFileContent(
          octokit,
          owner,
          repo,
          headSha,
          file.filePath,
          CHANGED_FILE_CONTENT_SIZE_LIMIT,
        );
        file.content = result.content ?? undefined;
        if (result.skipReason) {
          skipped.push(
            `${file.filePath} (${describeSkipReason(
              result.skipReason,
              CHANGED_FILE_CONTENT_SIZE_LIMIT,
              result.size,
            )})`,
          );
        }
      }),
    );

    if (skipped.length > 0) {
      this.logger.log(
        `PR #${prNumber} changedFiles content 제외 ${skipped.length}건 (hunk 만으로 리뷰): ${skipped.join(', ')}`,
      );
    }

    // LLM으로 가기 전에 하드코딩된 시크릿을 가린다. 예산 계산 전에 해야 가려진 길이 기준으로
    // 맞춰진다. 건수와 파일 경로만 로그에 남기고 값은 절대 남기지 않는다.
    const masked = maskChangedFiles(changedFiles);
    if (masked.length > 0) {
      this.logger.warn(
        `PR #${prNumber} 시크릿 마스킹 ${masked.reduce((sum, r) => sum + r.count, 0)}건: ${masked.map((r) => `${r.filePath}(${r.count})`).join(', ')}`,
      );
    }

    // 예산을 넘으면 큰 파일부터 content를 비워 hunk 기반 리뷰로 fallback시킨다
    // (ai-server는 content가 없으면 hunk만으로 리뷰를 진행한다). content+patch
    // 총합이 상한을 넘으면 patch까지 비운다 — 그 파일은 리뷰 대상에서 사실상 빠진다.
    const { droppedContent, droppedPatch } = enforceContentBudget(
      changedFiles,
      CHANGED_FILE_CONTENT_TOTAL_BUDGET,
      CHANGED_FILE_TOTAL_BUDGET,
    );
    if (droppedContent.length > 0) {
      this.logger.warn(
        `PR #${prNumber} changedFiles content 예산(${CHANGED_FILE_CONTENT_TOTAL_BUDGET} bytes) 또는 ` +
          `총합(content+patch) 상한(${CHANGED_FILE_TOTAL_BUDGET} bytes) 초과, ` +
          `${droppedContent.length}개 파일 content 제외 (hunk만 전송): ${droppedContent.join(', ')}`,
      );
    }
    if (droppedPatch.length > 0) {
      this.logger.warn(
        `PR #${prNumber} changedFiles 총합(content+patch) 상한(${CHANGED_FILE_TOTAL_BUDGET} bytes) 초과, ` +
          `${droppedPatch.length}개 파일 patch까지 제외 (리뷰 대상에서 빠짐): ${droppedPatch.join(', ')}`,
      );
    }

    unreviewed.push(
      ...droppedPatch.map((filePath) => ({
        filePath,
        reason: 'patch-budget' as const,
      })),
    );

    return { changedFiles: sortByReviewPriority(changedFiles), unreviewed };
  }

  // 증분 리뷰(#94): 이 PR에 마지막으로 게시된 리뷰의 커밋과 현재 head를 비교해 그 사이 바뀐 파일 경로를 돌려준다.
  // 첫 리뷰, 같은 커밋 재리뷰(사용자가 명시적으로 다시 돌린 것), 강제 푸시나 리베이스(ahead가 아님),
  // 큰 변경(비교 응답이 한 페이지를 넘을 수 있음), 조회 실패는 모두 null — 호출부가 전체 리뷰로 진행한다.
  private async resolveIncremental(
    octokit: Octokit,
    owner: string,
    repo: string,
    repositoryId: number,
    prNumber: number,
    headSha: string,
  ): Promise<{ previousHeadSha: string; paths: Set<string> } | null> {
    try {
      const previous = await this.lastReviewedShaStore.get(
        repositoryId,
        prNumber,
      );
      if (previous === null || previous === headSha) return null;

      const { data } = await withRetry(() =>
        octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${previous}...${headSha}`,
          per_page: COMPARE_FILES_PAGE_SIZE,
        }),
      );
      if (data.status !== 'ahead') {
        this.logger.log(
          `PR #${prNumber} 증분 리뷰 불가(비교 상태=${data.status}), 전체 리뷰로 진행`,
        );
        return null;
      }
      const files = data.files ?? [];
      if (files.length >= COMPARE_FILES_PAGE_SIZE) {
        this.logger.log(
          `PR #${prNumber} 변경 파일이 ${COMPARE_FILES_PAGE_SIZE}개 이상이라 전체 리뷰로 진행`,
        );
        return null;
      }
      this.logger.log(
        `PR #${prNumber} 증분 리뷰: ${previous.slice(0, 7)}...${headSha.slice(0, 7)} 사이 ${files.length}개 파일`,
      );
      return {
        previousHeadSha: previous,
        paths: new Set(files.map((file) => file.filename)),
      };
    } catch (err) {
      this.logger.warn(
        `증분 리뷰 기준 조회 실패, 전체 리뷰로 진행: PR #${prNumber}`,
        err,
      );
      return null;
    }
  }

  // 레포 설정은 PR이 바꿀 수 없는 **base 커밋**의 DOVI.md에서 읽는다. head에서 읽으면 PR 작성자가
  // 같은 PR에서 exclude를 늘려 자기 변경을 리뷰 대상에서 빼거나 minSeverity로 지적을 숨길 수 있다
  // (규칙 문서·프로브 opt-in과 같은 원칙). 읽기·파싱에 실패해도 리뷰는 막지 않고 기본값(설정 없음)으로 진행한다.
  private async loadReviewSettings(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseSha: string,
    prNumber: number,
  ): Promise<ReviewSettings> {
    const result = await fetchFileContent(
      octokit,
      owner,
      repo,
      baseSha,
      'DOVI.md',
      CONTEXT_FILE_SIZE_LIMIT,
    );
    if (result.content === null) {
      // DOVI.md가 없는 레포가 대부분이라 404는 조용히 넘긴다.
      if (result.skipReason && result.skipReason !== 'not-found') {
        this.logger.warn(
          `PR #${prNumber} DOVI.md를 읽지 못해 레포 설정 없이 진행: ${describeSkipReason(
            result.skipReason,
            CONTEXT_FILE_SIZE_LIMIT,
            result.size,
          )}`,
        );
      }
      return DEFAULT_REVIEW_SETTINGS;
    }

    const { settings, warnings } = parseReviewSettings(result.content);
    if (warnings.length > 0) {
      this.logger.warn(
        `PR #${prNumber} DOVI.md Review Settings 경고: ${warnings.join(' / ')}`,
      );
    }
    return settings;
  }

  private async saveReviewSettings(
    repositoryId: number,
    prNumber: number,
    headSha: string,
    settings: ReviewSettings,
  ): Promise<void> {
    try {
      await this.reviewSettingsStore.set(repositoryId, prNumber, headSha, {
        minSeverity: settings.minSeverity,
        maxInlineComments: settings.maxInlineComments,
      });
    } catch (err) {
      this.logger.warn(
        `레포 설정 저장 실패, minSeverity/maxInlineComments 없이 게시: PR #${prNumber}`,
        err,
      );
    }
  }

  private async saveUnreviewed(
    repositoryId: number,
    prNumber: number,
    headSha: string,
    unreviewed: UnreviewedFile[],
  ): Promise<void> {
    try {
      await this.unreviewedFilesStore.set(
        repositoryId,
        prNumber,
        headSha,
        unreviewed,
      );
    } catch (err) {
      this.logger.warn(
        `미검토 파일 목록 저장 실패, 리뷰 본문 안내 없이 진행: PR #${prNumber}`,
        err,
      );
    }
  }

  // 규칙 문서는 **PR의 base 커밋** 기준으로 읽는다. 문서 내용은 모델에게 지시로 읽히는데, PR
  // head에서 읽으면 PR 작성자가 같은 PR에서 규칙 문서를 고쳐 리뷰 지시를 조작할 수 있다(프롬프트
  // 주입 경로). base는 이 PR이 바꿀 수 없는, 이미 병합된 신뢰 가능한 버전이다. DOVI.md의 opt-in을
  // default_branch 기준으로 읽는 것과 같은 원칙이다.
  private async fetchRuleDocs(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseSha: string,
  ): Promise<ContextFile[]> {
    const docs = await Promise.all(
      RULE_DOC_CANDIDATES.map(async (path): Promise<ContextFile | null> => {
        const result = await fetchFileContent(
          octokit,
          owner,
          repo,
          baseSha,
          path,
          RULE_DOC_SIZE_LIMIT,
        );
        if (result.content === null) {
          // 대부분의 레포에는 없는 파일이라 404는 조용히 넘긴다.
          if (result.skipReason && result.skipReason !== 'not-found') {
            this.logger.warn(
              `규칙 문서 ${path} 제외: ${describeSkipReason(
                result.skipReason,
                RULE_DOC_SIZE_LIMIT,
                result.size,
              )}`,
            );
          }
          return null;
        }
        const masked = maskSecrets(result.content);
        if (masked.count > 0) {
          this.logger.warn(`규칙 문서 ${path} 시크릿 마스킹 ${masked.count}건`);
        }
        return { path, content: masked.text, source: 'github' };
      }),
    );

    // 우선순위(후보 순서)대로 총량 예산 안에서만 싣는다.
    const kept: ContextFile[] = [];
    let total = 0;
    for (const doc of docs) {
      if (doc === null) continue;
      const bytes = Buffer.byteLength(doc.content, 'utf-8');
      if (total + bytes > RULE_DOCS_TOTAL_BUDGET) {
        this.logger.warn(
          `규칙 문서 총량 예산(${RULE_DOCS_TOTAL_BUDGET} bytes) 초과로 ${doc.path} 제외`,
        );
        continue;
      }
      total += bytes;
      kept.push(doc);
    }
    return kept;
  }

  private async fetchContextFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<ContextFile[]> {
    const candidatePaths = await this.resolveContextFilePaths(
      octokit,
      owner,
      repo,
      headSha,
    );

    const files = await Promise.all(
      candidatePaths.map((path) =>
        this.fetchContextFileContent(octokit, owner, repo, headSha, path),
      ),
    );

    return files.filter((file): file is ContextFile => file !== null);
  }

  private async resolveContextFilePaths(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<string[]> {
    const paths = [...CONTEXT_ROOT_CANDIDATES];

    try {
      const { data } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: headSha,
        recursive: '1',
      });

      for (const entry of data.tree) {
        if (
          entry.type === 'blob' &&
          entry.path &&
          entry.path.toLowerCase().startsWith(CONTEXT_DOCS_PREFIX)
        ) {
          paths.push(entry.path);
        }
      }
    } catch (err) {
      this.logger.warn(
        `docs/ 디렉터리 조회 실패, root 컨텍스트 후보만 사용: ${owner}/${repo}`,
        err,
      );
    }

    return paths.filter((path) => !isSecretPath(path));
  }

  private async fetchContextFileContent(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
    path: string,
  ): Promise<ContextFile | null> {
    const result = await fetchFileContent(
      octokit,
      owner,
      repo,
      headSha,
      path,
      CONTEXT_FILE_SIZE_LIMIT,
    );
    if (result.content === null) {
      // 404 는 흔한 정상 경로(그 레포에 없는 설정 파일)라 로그를 남기지 않는다.
      if (result.skipReason && result.skipReason !== 'not-found') {
        this.logger.warn(
          `컨텍스트 파일 ${path} 제외: ${describeSkipReason(
            result.skipReason,
            CONTEXT_FILE_SIZE_LIMIT,
            result.size,
          )}`,
        );
      }
      return null;
    }

    const masked = maskSecrets(result.content);
    if (masked.count > 0) {
      this.logger.warn(`컨텍스트 파일 ${path} 시크릿 마스킹 ${masked.count}건`);
    }
    return { path, content: masked.text, source: 'github' };
  }
}
