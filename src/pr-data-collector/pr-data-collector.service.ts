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
        this.fetchChangedFiles(octokit, owner, repo, prNumber),
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
    octokit: Awaited<ReturnType<InstallationTokenManager['getOctokit']>>,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ChangedFile[]> {
    const files = await withRetry(() =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    );

    return files
      .filter((file): file is typeof file & { status: ChangedFileStatus } =>
        SUPPORTED_FILE_STATUSES.has(file.status as ChangedFileStatus),
      )
      .map((file) => ({
        filePath: file.filename,
        status: file.status,
        patch: file.patch,
      }));
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
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: headSha,
      });

      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        !data.content ||
        data.size > CONTEXT_FILE_SIZE_LIMIT
      ) {
        return null;
      }

      return {
        path,
        content: Buffer.from(data.content, 'base64').toString('utf-8'),
        source: 'github',
      };
    } catch {
      return null;
    }
  }
}
