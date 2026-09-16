import { Inject, Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import type { Octokit } from '@octokit/rest';
import { isClientError } from '../common/http-error';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import { PrimaryReviewStore } from '../redis/primary-review.store';
import {
  buildReviewComments,
  formatReviewSummary,
} from './review-comment.formatter';
import type { FormattedReviewComment } from './review-comment.formatter';
import type { ReviewOrchestrator } from './review-orchestrator.interface';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

@Injectable()
export class ReviewOrchestratorService implements ReviewOrchestrator {
  private readonly logger = new Logger(ReviewOrchestratorService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly reviewJobContextStore: ReviewJobContextStore,
    private readonly reviewCommentFindingStore: ReviewCommentFindingStore,
    private readonly primaryReviewStore: PrimaryReviewStore,
    private readonly dicoshot: DicoshotService,
  ) {}

  async handle(
    payload: ReviewCompletedPayload | ReviewFailedPayload,
  ): Promise<void> {
    const context = await this.reviewJobContextStore.get(payload.reviewJobId);
    if (!context) {
      this.logger.error(
        `job context 없음(TTL 만료 또는 미기록), 스킵: ${payload.reviewJobId}`,
      );
      return;
    }

    if ('reason' in payload) {
      await this.notifyFailure(payload, context);
      return;
    }

    const octokit = await this.installationTokenManager.getOctokit(
      context.installationId,
    );

    try {
      await this.deleteStaleReviewComments(octokit, context, payload.prNumber);

      const formattedComments = buildReviewComments(payload.reviews);
      const reviewBody = formatReviewSummary(payload.summary);
      const existingReviewId = await this.primaryReviewStore.get(
        payload.repositoryId,
        payload.prNumber,
      );

      if (existingReviewId !== null) {
        await this.updateExistingReview(
          octokit,
          context,
          payload,
          existingReviewId,
          reviewBody,
          formattedComments,
        );
      } else {
        await this.createInitialReview(
          octokit,
          context,
          payload,
          reviewBody,
          formattedComments,
        );
      }
    } catch (err) {
      await this.notifyOrchestratorError(payload, context, err);

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

  // 이 PR에 봇 리뷰가 처음 등록될 때만 호출된다. GitHub 리뷰(PR 타임라인의
  // "reviewed" 배너)를 생성하고, 이후 push에서 body만 갱신할 수 있도록 그
  // 리뷰의 id를 Redis에 저장해둔다.
  private async createInitialReview(
    octokit: Octokit,
    context: ReviewJobContext,
    payload: ReviewCompletedPayload,
    body: string,
    formattedComments: FormattedReviewComment[],
  ): Promise<void> {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: payload.prNumber,
      commit_id: payload.headSha,
      event: 'COMMENT',
      body,
      comments: formattedComments.map(({ path, line, body: commentBody }) => ({
        path,
        line,
        body: commentBody,
      })),
    });

    await this.primaryReviewStore.set(
      payload.repositoryId,
      payload.prNumber,
      review.id,
    );

    await this.saveCommentFindingMapping(
      octokit,
      context,
      payload,
      review.id,
      formattedComments,
    );
  }

  // 이미 이 PR에 봇 리뷰가 있으면(Redis에 review id 기록됨) push마다 새 리뷰를
  // 만들어 PR 타임라인에 "reviewed" 배너가 계속 쌓이는 대신, 기존 리뷰의 body만
  // 갱신(updateReview)하고 finding은 개별 리뷰 코멘트로 추가한다. updateReview는
  // body만 바꿀 뿐 코멘트를 함께 추가할 수 없어 createReviewComment를 따로 호출한다.
  private async updateExistingReview(
    octokit: Octokit,
    context: ReviewJobContext,
    payload: ReviewCompletedPayload,
    reviewId: number,
    body: string,
    formattedComments: FormattedReviewComment[],
  ): Promise<void> {
    await withRetry(() =>
      octokit.rest.pulls.updateReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: payload.prNumber,
        review_id: reviewId,
        body,
      }),
    );

    await Promise.all(
      formattedComments.map(
        async ({ path, line, body: commentBody, findingIndex }) => {
          const { data: comment } = await withRetry(() =>
            octokit.rest.pulls.createReviewComment({
              owner: context.owner,
              repo: context.repo,
              pull_number: payload.prNumber,
              commit_id: payload.headSha,
              path,
              line,
              body: commentBody,
            }),
          );

          await this.reviewCommentFindingStore.set(comment.id, {
            reviewJobId: payload.reviewJobId,
            findingIndex,
          });
        },
      ),
    );
  }

  // 생성된 리뷰 코멘트의 GitHub id를 원본 finding 인덱스로 역매핑해 저장한다.
  // 이후 이 코멘트 스레드에 반영/미반영 답글이 달렸을 때 어느 finding에 대한
  // 것인지 알아내는 데 쓴다(pr.comment.reflected 발행용). listCommentsForReview는
  // 요청한 comments 배열과 동일한 순서로 반환된다는 전제.
  private async saveCommentFindingMapping(
    octokit: Octokit,
    context: ReviewJobContext,
    payload: ReviewCompletedPayload,
    reviewId: number,
    formattedComments: { findingIndex: number }[],
  ): Promise<void> {
    if (formattedComments.length === 0) return;

    try {
      const createdComments = await withRetry(() =>
        octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
          owner: context.owner,
          repo: context.repo,
          pull_number: payload.prNumber,
          review_id: reviewId,
          per_page: 100,
        }),
      );

      await Promise.all(
        createdComments.map((comment, i) => {
          const findingIndex = formattedComments[i]?.findingIndex;
          if (findingIndex === undefined) return Promise.resolve();
          return this.reviewCommentFindingStore.set(comment.id, {
            reviewJobId: payload.reviewJobId,
            findingIndex,
          });
        }),
      );
    } catch (err) {
      this.logger.warn(
        `리뷰 코멘트-finding 매핑 저장 실패 (반영 여부 추적 불가): PR #${payload.prNumber}`,
        err,
      );
    }
  }

  // push(synchronize)마다 새 리뷰를 올리다 보면 이전 push에서 남긴 봇 코멘트가
  // 그대로 쌓이므로, 새 리뷰를 올리기 전 봇이 단 이전 최상위 코멘트를 정리한다.
  // 사람이 남긴 답글(in_reply_to_id 존재)은 대화 스레드이므로 건드리지 않는다.
  private async deleteStaleReviewComments(
    octokit: Octokit,
    context: ReviewJobContext,
    prNumber: number,
  ): Promise<void> {
    const botLogin = process.env.GITHUB_BOT_LOGIN;
    if (!botLogin) return;

    try {
      const comments = await withRetry(() =>
        octokit.paginate(octokit.rest.pulls.listReviewComments, {
          owner: context.owner,
          repo: context.repo,
          pull_number: prNumber,
          per_page: 100,
        }),
      );

      const staleComments = comments.filter(
        (comment) =>
          comment.user?.login === `${botLogin}[bot]` && !comment.in_reply_to_id,
      );

      await Promise.all(
        staleComments.map((comment) =>
          withRetry(() =>
            octokit.rest.pulls.deleteReviewComment({
              owner: context.owner,
              repo: context.repo,
              comment_id: comment.id,
            }),
          ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `이전 리뷰 코멘트 정리 실패, 새 리뷰는 계속 진행: PR #${prNumber}`,
        err,
      );
    }
  }

  private async notifyFailure(
    payload: ReviewFailedPayload,
    context: ReviewJobContext,
  ): Promise<void> {
    await this.safeNotify({
      title: 'AI 리뷰 분석 실패',
      description: `${context.owner}/${context.repo}#${context.prNumber} (reviewJobId=${payload.reviewJobId}) reason=${payload.reason}`,
      color: 'danger',
    });
  }

  private async notifyOrchestratorError(
    payload: ReviewCompletedPayload,
    context: ReviewJobContext,
    err: unknown,
  ): Promise<void> {
    await this.safeNotify({
      title: 'GitHub 리뷰 등록 실패',
      description: `${context.owner}/${context.repo}#${payload.prNumber} (reviewJobId=${payload.reviewJobId}): ${err instanceof Error ? err.message : String(err)}`,
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
