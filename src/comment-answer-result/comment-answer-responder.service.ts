import { Inject, Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import { isClientError } from '../common/http-error';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { CommentAnswerContextStore } from '../redis/comment-answer-context.store';
import type { CommentAnswerContext } from '../redis/comment-answer-context.type';
import type { CommentAnswerResponder } from './comment-answer-responder.interface';
import type { CommentAnswerCompletedPayload } from './dto/comment-answer-completed.payload';
import type { CommentAnswerFailedPayload } from './dto/comment-answer-failed.payload';

@Injectable()
export class CommentAnswerResponderService implements CommentAnswerResponder {
  private readonly logger = new Logger(CommentAnswerResponderService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly commentAnswerContextStore: CommentAnswerContextStore,
    private readonly dicoshot: DicoshotService,
  ) {}

  async handle(
    payload: CommentAnswerCompletedPayload | CommentAnswerFailedPayload,
  ): Promise<void> {
    const context = await this.commentAnswerContextStore.get(
      payload.commentJobId,
    );
    if (!context) {
      this.logger.error(
        `comment answer context 없음(TTL 만료 또는 미기록), 스킵: ${payload.commentJobId}`,
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
      await octokit.rest.pulls.createReplyForReviewComment({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.prNumber,
        comment_id: context.rootCommentId,
        body: payload.answer,
      });
    } catch (err) {
      await this.notifyResponderError(payload, context, err);

      if (isClientError(err)) {
        this.logger.error(
          `영구적으로 실패한 답글 등록(status=${err.status}), 재시도하지 않고 종료: ${payload.commentJobId}`,
          err,
        );
        return;
      }

      throw err;
    }
  }

  private async notifyFailure(
    payload: CommentAnswerFailedPayload,
    context: CommentAnswerContext,
  ): Promise<void> {
    await this.safeNotify({
      title: 'AI 코멘트 답변 실패',
      description: `${context.owner}/${context.repo}#${context.prNumber} (commentJobId=${payload.commentJobId}) reason=${payload.reason}`,
      color: 'danger',
    });
  }

  private async notifyResponderError(
    payload: CommentAnswerCompletedPayload,
    context: CommentAnswerContext,
    err: unknown,
  ): Promise<void> {
    await this.safeNotify({
      title: 'GitHub 코멘트 답글 등록 실패',
      description: `${context.owner}/${context.repo}#${context.prNumber} (commentJobId=${payload.commentJobId}): ${err instanceof Error ? err.message : String(err)}`,
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
