import { Inject, Injectable, Logger } from '@nestjs/common';
import { isClientError } from '../common/http-error';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { ReviewFailureCommentStore } from '../redis/review-failure-comment.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

const MARKER = '<!-- dovi:review-failure -->';
const RETRY_HINT =
  '잠시 후 PR 대화창에 `/dovi review`를 남기면 다시 리뷰합니다.';

// PR 작성자가 할 수 있는 조치까지 알려준다. context_overflow는 재시도로는 절대
// 해결되지 않으므로(같은 PR은 같은 크기) 재시도 안내 대신 PR을 나눠 달라고 한다.
const REASON_MESSAGES: Record<ReviewFailedPayload['reason'], string> = {
  context_overflow:
    '이 PR은 변경량이 너무 커서 AI 리뷰를 진행하지 못했습니다. 변경을 더 작은 PR로 나눠 올려주시면 리뷰할 수 있습니다.',
  output_truncated: `리뷰 결과가 너무 길어 등록하지 못했습니다. PR을 나누거나, ${RETRY_HINT}`,
  timeout: `AI 리뷰가 제한 시간 안에 끝나지 않았습니다. ${RETRY_HINT}`,
  server_error: `AI 리뷰 중 서버 오류가 발생했습니다. ${RETRY_HINT}`,
  parse_error: `AI 리뷰 결과를 해석하지 못했습니다. ${RETRY_HINT}`,
};

// 리뷰 실패를 PR 작성자에게도 알린다(원래는 Discord로만 알림이 가서 작성자는
// 👀 리액션만 보고 리뷰를 계속 기다리게 됐다). PR당 코멘트 하나를 갱신하고, 이후
// 리뷰가 성공하면 지운다.
//
// 보조 기능이라 두 메서드 모두 예외를 던지지 않는다 — 실패해도 Discord 알림과
// 리뷰 등록 흐름에는 영향이 없어야 한다.
@Injectable()
export class ReviewFailureNoticeService {
  private readonly logger = new Logger(ReviewFailureNoticeService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly store: ReviewFailureCommentStore,
  ) {}

  async notify(
    context: ReviewJobContext,
    payload: ReviewFailedPayload,
  ): Promise<void> {
    try {
      const body = this.format(payload);
      const octokit = await this.installationTokenManager.getOctokit(
        context.installationId,
      );
      const { owner, repo, prNumber } = context;

      const existingId = await this.store.get(owner, repo, prNumber);
      if (existingId !== null) {
        try {
          await withRetry(() =>
            octokit.rest.issues.updateComment({
              owner,
              repo,
              comment_id: existingId,
              body,
            }),
          );
          return;
        } catch (err) {
          // 사람이 코멘트를 지웠으면 새로 만든다. 그 밖의 오류는 바깥에서 처리.
          if (!this.isGone(err)) throw err;
        }
      }

      const { data: created } = await withRetry(() =>
        octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        }),
      );
      await this.store.set(owner, repo, prNumber, created.id);
    } catch (err) {
      this.logger.warn(
        `리뷰 실패 안내 코멘트 게시 실패: ${context.owner}/${context.repo}#${context.prNumber}`,
        err,
      );
    }
  }

  async clear(context: ReviewJobContext): Promise<void> {
    const { owner, repo, prNumber } = context;
    try {
      const existingId = await this.store.get(owner, repo, prNumber);
      if (existingId === null) return;

      const octokit = await this.installationTokenManager.getOctokit(
        context.installationId,
      );
      try {
        await withRetry(() =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: existingId,
          }),
        );
      } catch (err) {
        if (!this.isGone(err)) throw err;
      }
      await this.store.delete(owner, repo, prNumber);
    } catch (err) {
      this.logger.warn(
        `리뷰 실패 안내 코멘트 정리 실패: ${owner}/${repo}#${prNumber}`,
        err,
      );
    }
  }

  private format(payload: ReviewFailedPayload): string {
    return [
      MARKER,
      `⚠️ **AI 리뷰 실패** (커밋 \`${payload.headSha.slice(0, 7)}\`)`,
      '',
      // ai-server가 새 reason을 추가했는데 이쪽 타입이 아직 못 따라온 경우(#56 선례)에도
      // 코멘트에 undefined가 찍히지 않게 한다.
      REASON_MESSAGES[payload.reason] ??
        `AI 리뷰 중 오류가 발생했습니다. ${RETRY_HINT}`,
    ].join('\n');
  }

  private isGone(err: unknown): boolean {
    return isClientError(err) && (err.status === 404 || err.status === 410);
  }
}
