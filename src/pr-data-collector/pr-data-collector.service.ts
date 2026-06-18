import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { CollectPrDataCommand } from './dto/collect-pr-data.command';
import type { ReviewRequestPayload } from './dto/review-request.payload';

const DIFF_SIZE_LIMIT = 20 * 1024 * 1024;

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
    const { installationId, owner, repo, prNumber, headSha, repositoryId } =
      command;

    const octokit =
      await this.installationTokenManager.getOctokit(installationId);

    const diffPromise = this.fetchDiff(octokit, owner, repo, prNumber);
    const changedFilesPromise = this.fetchChangedFiles(
      octokit,
      owner,
      repo,
      prNumber,
    );

    const diff = await diffPromise;
    if (diff === null) return null;

    const changedFiles = await changedFilesPromise;

    return {
      reviewJobId: `${repositoryId}_${prNumber}_${headSha}`,
      repositoryId,
      prNumber,
      headSha,
      owner,
      repo,
      installationId,
      diff,
      changedFiles,
    };
  }

  private async fetchDiff(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string | null> {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });

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
  ) {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    return files.map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: file.patch,
    }));
  }
}
