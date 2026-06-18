import { Inject, Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { buildReviewComments } from './review-comment.formatter';
import type { ReviewOrchestrator } from './review-orchestrator.interface';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

function isClientError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    (err as { status: number }).status >= 400 &&
    (err as { status: number }).status < 500
  );
}

@Injectable()
export class ReviewOrchestratorService implements ReviewOrchestrator {
  private readonly logger = new Logger(ReviewOrchestratorService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly dicoshot: DicoshotService,
  ) {}

  async handle(
    payload: ReviewCompletedPayload | ReviewFailedPayload,
  ): Promise<void> {
    if ('reason' in payload) {
      await this.notifyFailure(payload);
      return;
    }

    const octokit = await this.installationTokenManager.getOctokit(
      payload.installationId,
    );

    try {
      await octokit.rest.pulls.createReview({
        owner: payload.owner,
        repo: payload.repo,
        pull_number: payload.prNumber,
        commit_id: payload.headSha,
        event: 'COMMENT',
        body: payload.summary,
        comments: buildReviewComments(payload.reviews),
      });
    } catch (err) {
      await this.notifyOrchestratorError(payload, err);

      if (isClientError(err)) {
        this.logger.error(
          `영구적으로 실패한 리뷰 등록(status=${err.status}), 재시도하지 않고 종료: ${payload.reviewJobId}`,
          err,
        );
        return;
      }

      throw err;
    }
  }

  private async notifyFailure(payload: ReviewFailedPayload): Promise<void> {
    await this.safeNotify({
      title: 'AI 리뷰 분석 실패',
      description: `${payload.owner}/${payload.repo}#${payload.prNumber} (reviewJobId=${payload.reviewJobId}) reason=${payload.reason}`,
      color: 'danger',
    });
  }

  private async notifyOrchestratorError(
    payload: ReviewCompletedPayload,
    err: unknown,
  ): Promise<void> {
    await this.safeNotify({
      title: 'GitHub 리뷰 등록 실패',
      description: `${payload.owner}/${payload.repo}#${payload.prNumber} (reviewJobId=${payload.reviewJobId}): ${err instanceof Error ? err.message : String(err)}`,
      color: 'danger',
    });
  }

  private async safeNotify(message: CustomMessageOptions): Promise<void> {
    try {
      await this.dicoshot.sendCustom(message);
    } catch (notifyErr) {
      this.logger.warn('Discord 알림 전송 실패', notifyErr);
    }
  }
}
