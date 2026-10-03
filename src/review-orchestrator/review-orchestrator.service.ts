import { Inject, Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import type { Octokit } from '@octokit/rest';
import {
  isClientError,
  isGoneError,
  isUnprocessableError,
} from '../common/http-error';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import { PrimaryReviewStore } from '../redis/primary-review.store';
import { ReviewFailureNoticeService } from './review-failure-notice.service';
import {
  appendUnanchoredFindings,
  buildReviewComments,
  formatReviewSummary,
} from './review-comment.formatter';
import type { FormattedReviewComment } from './review-comment.formatter';
import type { ReviewOrchestrator } from './review-orchestrator.interface';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

// ai-server의 FailureReason과 1:1 대응하는 사람이 읽을 설명. Discord 알림에서
// reason 코드만 봐서는 뭐가 문제인지 바로 안 와닿아서 함께 보여준다.
const REASON_DESCRIPTIONS: Record<ReviewFailedPayload['reason'], string> = {
  parse_error: 'LLM 응답 파싱 실패',
  timeout: 'AI 서버 처리 시간 초과',
  server_error: 'AI 서버 내부 오류',
  context_overflow: 'PR이 너무 커서 컨텍스트에 담을 수 없음',
  output_truncated: 'AI 출력이 잘려 복구도 실패',
};

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
    private readonly reviewFailureNotice: ReviewFailureNoticeService,
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
      // 둘 다 예외를 던지지 않고 서로 독립적이라 함께 보낸다.
      await Promise.all([
        this.notifyFailure(payload, context),
        this.reviewFailureNotice.notify(context, payload),
      ]);
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

      // 이전 push에서 실패해 남긴 안내 코멘트는 리뷰가 성공했으니 더 이상 맞지 않는다.
      await this.reviewFailureNotice.clear(context);
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
    const review = await this.createReviewWithAllComments(
      octokit,
      context,
      payload,
      body,
      formattedComments,
    );

    if (review) {
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
      return;
    }

    // 인라인 코멘트 중 일부가 diff 밖 줄을 가리켜 리뷰 전체가 422로 거부된 경우다.
    // 본문만으로 리뷰를 먼저 만들고, finding은 하나씩 게시해 달 수 있는 건 인라인으로,
    // 못 다는 건 본문에 모은다.
    this.logger.warn(
      `인라인 코멘트 일부가 diff 밖이라 본문 리뷰 + 개별 게시로 전환: PR #${payload.prNumber}`,
    );
    const { data: bodyOnlyReview } = await octokit.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: payload.prNumber,
      commit_id: payload.headSha,
      event: 'COMMENT',
      body,
      comments: [],
    });
    await this.primaryReviewStore.set(
      payload.repositoryId,
      payload.prNumber,
      bodyOnlyReview.id,
    );
    await this.postFindings(
      octokit,
      context,
      payload,
      bodyOnlyReview.id,
      body,
      formattedComments,
    );
  }

  // 모든 인라인 코멘트를 한 번에 담아 리뷰를 만든다(정상 경로). GitHub가 코멘트 하나라도
  // 해석할 수 없으면(422) 리뷰 전체를 거부하므로, 그 경우에만 null을 돌려 호출부가
  // 개별 게시로 전환하게 한다. 코멘트가 없는데 422면 원인이 다른 것이라 그대로 던진다.
  private async createReviewWithAllComments(
    octokit: Octokit,
    context: ReviewJobContext,
    payload: ReviewCompletedPayload,
    body: string,
    formattedComments: FormattedReviewComment[],
  ): Promise<{ id: number } | null> {
    try {
      const { data: review } = await octokit.rest.pulls.createReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: payload.prNumber,
        commit_id: payload.headSha,
        event: 'COMMENT',
        body,
        comments: formattedComments.map(
          ({ path, line, body: commentBody }) => ({
            path,
            line,
            body: commentBody,
          }),
        ),
      });
      return review;
    } catch (err) {
      if (!isUnprocessableError(err) || formattedComments.length === 0) {
        throw err;
      }
      return null;
    }
  }

  // finding을 인라인 코멘트로 하나씩 게시한다. AI가 diff 밖 줄을 가리켜 GitHub가
  // 422로 거부한 finding은 리뷰 전체를 실패시키지 않고 모아서 리뷰 본문에 붙인다.
  // 422 외의 에러(5xx, 권한 등)는 기존대로 그대로 던진다. 본문에 붙은 finding은
  // 코멘트 id가 없어 반영 여부 추적 대상에서 빠진다.
  private async postFindings(
    octokit: Octokit,
    context: ReviewJobContext,
    payload: ReviewCompletedPayload,
    reviewId: number,
    body: string,
    formattedComments: FormattedReviewComment[],
  ): Promise<void> {
    const unanchored: FormattedReviewComment[] = [];

    for (const finding of formattedComments) {
      try {
        const { data: comment } = await withRetry(() =>
          octokit.rest.pulls.createReviewComment({
            owner: context.owner,
            repo: context.repo,
            pull_number: payload.prNumber,
            commit_id: payload.headSha,
            path: finding.path,
            line: finding.line,
            body: finding.body,
          }),
        );

        await this.reviewCommentFindingStore.set(comment.id, {
          reviewJobId: payload.reviewJobId,
          findingIndex: finding.findingIndex,
        });
      } catch (err) {
        if (!isUnprocessableError(err)) throw err;

        this.logger.warn(
          `인라인 코멘트를 달 수 없어 본문에 포함: ${finding.path}:${finding.line} (PR #${payload.prNumber})`,
        );
        unanchored.push(finding);
      }
    }

    if (unanchored.length === 0) return;

    await withRetry(() =>
      octokit.rest.pulls.updateReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: payload.prNumber,
        review_id: reviewId,
        body: appendUnanchoredFindings(body, unanchored),
      }),
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
    try {
      await withRetry(() =>
        octokit.rest.pulls.updateReview({
          owner: context.owner,
          repo: context.repo,
          pull_number: payload.prNumber,
          review_id: reviewId,
          body,
        }),
      );
    } catch (err) {
      if (!isGoneError(err)) throw err;

      // 저장된 review id가 GitHub에서 삭제/dismiss된 경우(404/410) 계속 같은
      // 오류를 반복하며 이 PR이 영영 리뷰를 못 받는 대신, 기록을 지우고 새 리뷰를
      // 생성한다.
      this.logger.warn(
        `기존 리뷰(id=${reviewId})를 찾을 수 없어 새로 생성: PR #${payload.prNumber}`,
        err,
      );
      await this.primaryReviewStore.delete(
        payload.repositoryId,
        payload.prNumber,
      );
      await this.createInitialReview(
        octokit,
        context,
        payload,
        body,
        formattedComments,
      );
      return;
    }

    await this.postFindings(
      octokit,
      context,
      payload,
      reviewId,
      body,
      formattedComments,
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
  // 답글은 루트 코멘트에 매달린 구조이므로, 봇이 남긴 루트라도 그 아래에 답글이
  // 하나라도 달려 있으면(다른 코멘트의 in_reply_to_id가 이 id를 가리키면) 스레드
  // 전체가 함께 삭제되지 않도록 대상에서 제외한다.
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

      const repliedToIds = new Set(
        comments
          .map((comment) => comment.in_reply_to_id)
          .filter((id): id is number => id != null),
      );

      const staleComments = comments.filter(
        (comment) =>
          comment.user?.login === `${botLogin}[bot]` &&
          !comment.in_reply_to_id &&
          !repliedToIds.has(comment.id),
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
      description:
        `${context.owner}/${context.repo}#${context.prNumber} ` +
        `(reviewJobId=${payload.reviewJobId}) reason=${payload.reason} ` +
        `(${REASON_DESCRIPTIONS[payload.reason] ?? '알 수 없는 사유'})`,
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
