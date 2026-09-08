import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { enforceContentBudget } from '../common/content-budget';
import { parseIndexBranch } from '../common/dovi-md';
import { fetchFileContent } from '../common/github-content';
import { withRetry } from '../common/retry';
import { isSecretPath } from '../common/secret-path';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type {
  RepoIndexChangedFile,
  RepoIndexFileStatus,
  RepoIndexRequestPayload,
} from './dto/repo-index-request.payload';

const SUPPORTED_FILE_STATUSES = new Set<RepoIndexFileStatus>([
  'added',
  'modified',
  'removed',
  'renamed',
]);
const FILE_CONTENT_SIZE_LIMIT = 200 * 1024;
const FILE_CONTENT_TOTAL_BUDGET = 512 * 1024;
// push 전 브랜치가 없던 상태(신규 브랜치 push)를 나타내는 값. 이 경우 diff 기준이
// 없어 증분 인덱싱이 불가능하므로 스킵한다 (최초 전체 인덱싱은 ai-server가 별도 처리).
const EMPTY_SHA = '0'.repeat(40);

@Injectable()
export class RepoIndexCollectorService {
  private readonly logger = new Logger(RepoIndexCollectorService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
  ) {}

  // 레포마다 실제 개발 브랜치가 default_branch와 다를 수 있어, DOVI.md의
  // `## Index Branch` 섹션을 우선 사용하고 없으면 default_branch로 fallback한다.
  // DOVI.md는 항상 default_branch 기준으로 읽는다 (push된 브랜치가 아님).
  async resolveIndexBranch(
    installationId: number,
    owner: string,
    repo: string,
    defaultBranch: string,
  ): Promise<string> {
    const octokit =
      await this.installationTokenManager.getOctokit(installationId);
    const content = await fetchFileContent(
      octokit,
      owner,
      repo,
      defaultBranch,
      'DOVI.md',
      FILE_CONTENT_SIZE_LIMIT,
    );
    if (!content) return defaultBranch;

    return parseIndexBranch(content) ?? defaultBranch;
  }

  async collect(
    installationId: number,
    owner: string,
    repo: string,
    repositoryId: number,
    branch: string,
    before: string,
    after: string,
  ): Promise<RepoIndexRequestPayload | null> {
    if (before === EMPTY_SHA) {
      this.logger.log(
        `신규 브랜치 push(${owner}/${repo}@${branch}), 증분 diff 없어 스킵`,
      );
      return null;
    }

    const octokit =
      await this.installationTokenManager.getOctokit(installationId);

    const compareFiles = await this.compareFiles(
      octokit,
      owner,
      repo,
      branch,
      before,
      after,
    );
    if (compareFiles === null) return null;

    const changedFiles: RepoIndexChangedFile[] = compareFiles
      .filter((file): file is typeof file & { status: RepoIndexFileStatus } =>
        SUPPORTED_FILE_STATUSES.has(file.status as RepoIndexFileStatus),
      )
      .map((file) => ({
        filePath: file.filename,
        status: file.status,
      }));

    await Promise.all(
      changedFiles.map(async (file) => {
        if (file.status === 'removed') return;
        if (isSecretPath(file.filePath)) return;

        file.content =
          (await fetchFileContent(
            octokit,
            owner,
            repo,
            after,
            file.filePath,
            FILE_CONTENT_SIZE_LIMIT,
          )) ?? undefined;
      }),
    );

    const dropped = enforceContentBudget(
      changedFiles,
      FILE_CONTENT_TOTAL_BUDGET,
    );
    if (dropped.length > 0) {
      this.logger.warn(
        `${owner}/${repo}@${branch} changedFiles content 예산(${FILE_CONTENT_TOTAL_BUDGET} bytes) 초과, ` +
          `${dropped.length}개 파일 content 제외: ${dropped.join(', ')}`,
      );
    }

    return { repositoryId, branch, headSha: after, changedFiles };
  }

  private async compareFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
    before: string,
    after: string,
  ) {
    try {
      const { data } = await withRetry(() =>
        octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${before}...${after}`,
        }),
      );
      return data.files ?? [];
    } catch (err) {
      this.logger.warn(
        `${owner}/${repo}@${branch} compare 조회 실패(${before}...${after}), 인덱싱 스킵`,
        err,
      );
      return null;
    }
  }
}
