import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { CollectPrDataCommand } from './dto/collect-pr-data.command';
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
const SECRET_EXTENSIONS = ['.env', '.pem', '.p8', '.key'];

// ai-server의 app/review/chunking.py::_EXTENSION_LANGUAGE와 동일한 목록.
// AST 파싱을 지원하지 않는 확장자는 content를 보내봐야 ai-server가 버리므로
// API 호출/페이로드 크기 절약을 위해 여기서 미리 거른다.
const AST_SUPPORTED_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
]);
// ai-server의 AST context 기능(app/review/chunking.py)이 파싱할 원본 파일 크기 상한.
const CHANGED_FILE_CONTENT_SIZE_LIMIT = 200 * 1024;
// Kafka 브로커의 기본 message.max.bytes(~1MB)를 넘기지 않도록, PR 하나에서 보내는
// changedFiles[].content 총합에 두는 예산. 파일 하나당 최대 200KB라 파일 수가 많은
// PR은 개별 상한만으로는 부족하다.
const CHANGED_FILE_CONTENT_TOTAL_BUDGET = 512 * 1024;

function hasAstSupportedExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return AST_SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ai-server의 app/review/context.py::_is_secret과 동일한 규칙 (1차 방어)
function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  if (segments.includes('secrets')) return true;

  const name = segments[segments.length - 1];
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name.includes('private-key') || name.includes('private_key')) return true;

  return false;
}

@Injectable()
export class PrDataCollectorService {
  private readonly logger = new Logger(PrDataCollectorService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
  ) {}

  async collect(
    command: CollectPrDataCommand,
  ): Promise<ReviewRequestPayload | null> {
    const {
      installationId,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha,
      repositoryId,
    } = command;

    const octokit =
      await this.installationTokenManager.getOctokit(installationId);

    const [diffResult, changedFilesResult, contextFilesResult] =
      await Promise.allSettled([
        this.fetchDiff(octokit, owner, repo, prNumber),
        this.fetchChangedFiles(octokit, owner, repo, prNumber, headSha),
        this.fetchContextFiles(octokit, owner, repo, headSha),
      ]);

    if (diffResult.status === 'rejected') throw diffResult.reason;
    if (changedFilesResult.status === 'rejected')
      throw changedFilesResult.reason;
    if (contextFilesResult.status === 'rejected')
      throw contextFilesResult.reason;

    const diff = diffResult.value;
    if (diff === null) return null;

    const changedFiles = changedFilesResult.value;
    const contextFiles = contextFilesResult.value;

    return {
      reviewJobId: `${repositoryId}:${prNumber}:${headSha}`,
      repositoryId,
      prNumber,
      headSha,
      baseSha,
      contextFiles,
      changedFiles,
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
  ): Promise<ChangedFile[]> {
    const files = await withRetry(() =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    );

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

    await Promise.all(
      changedFiles.map(async (file) => {
        if (file.status === 'removed') return;
        if (!hasAstSupportedExtension(file.filePath)) return;
        if (isSecretPath(file.filePath)) return;

        file.content =
          (await this.fetchFileContent(
            octokit,
            owner,
            repo,
            headSha,
            file.filePath,
            CHANGED_FILE_CONTENT_SIZE_LIMIT,
          )) ?? undefined;
      }),
    );

    this.enforceChangedFileContentBudget(changedFiles, prNumber);

    return changedFiles;
  }

  // 예산을 넘으면 큰 파일부터 content를 비워 hunk 기반 리뷰로 fallback시킨다
  // (ai-server는 content가 없으면 hunk만으로 리뷰를 진행한다).
  private enforceChangedFileContentBudget(
    files: ChangedFile[],
    prNumber: number,
  ): void {
    const withContent = files.filter((file) => file.content !== undefined);
    let total = withContent.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content!, 'utf-8'),
      0,
    );
    if (total <= CHANGED_FILE_CONTENT_TOTAL_BUDGET) return;

    const droppedFiles: string[] = [];
    const sorted = [...withContent].sort(
      (a, b) =>
        Buffer.byteLength(b.content!, 'utf-8') -
        Buffer.byteLength(a.content!, 'utf-8'),
    );
    for (const file of sorted) {
      if (total <= CHANGED_FILE_CONTENT_TOTAL_BUDGET) break;
      total -= Buffer.byteLength(file.content!, 'utf-8');
      file.content = undefined;
      droppedFiles.push(file.filePath);
    }

    this.logger.warn(
      `PR #${prNumber} changedFiles content 예산(${CHANGED_FILE_CONTENT_TOTAL_BUDGET} bytes) 초과, ` +
        `${droppedFiles.length}개 파일 content 제외 (hunk만 전송): ${droppedFiles.join(', ')}`,
    );
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
    const content = await this.fetchFileContent(
      octokit,
      owner,
      repo,
      headSha,
      path,
      CONTEXT_FILE_SIZE_LIMIT,
    );
    if (content === null) return null;

    return { path, content, source: 'github' };
  }

  private async fetchFileContent(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
    path: string,
    sizeLimit: number,
  ): Promise<string | null> {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        !data.content ||
        data.size > sizeLimit
      ) {
        return null;
      }

      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }
}
