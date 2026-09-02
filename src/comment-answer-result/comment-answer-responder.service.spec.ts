import type { DicoshotService } from 'dicoshot-nest';
import { CommentAnswerResponderService } from './comment-answer-responder.service';
import type { CommentAnswerContextStore } from '../redis/comment-answer-context.store';
import type { CommentAnswerContext } from '../redis/comment-answer-context.type';
import type { CommentAnswerCompletedPayload } from './dto/comment-answer-completed.payload';
import type { CommentAnswerFailedPayload } from './dto/comment-answer-failed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('CommentAnswerResponderService', () => {
  let createReplyForReviewComment: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let commentAnswerContextStore: { get: jest.Mock };
  let dicoshot: { sendCustom: jest.Mock };
  let service: CommentAnswerResponderService;

  const context: CommentAnswerContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    installationId: 123,
    rootCommentId: 100,
  };

  const completedPayload: CommentAnswerCompletedPayload = {
    commentJobId: 'qa:1:1:999',
    answer: '현재 방식이 맞습니다.',
  };

  const failedPayload: CommentAnswerFailedPayload = {
    commentJobId: 'qa:1:1:999',
    reason: 'timeout',
  };

  beforeEach(() => {
    createReplyForReviewComment = jest.fn();
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: { pulls: { createReplyForReviewComment } },
      }),
    };
    commentAnswerContextStore = { get: jest.fn().mockResolvedValue(context) };
    dicoshot = { sendCustom: jest.fn() };

    service = new CommentAnswerResponderService(
      installationTokenManager,
      commentAnswerContextStore as unknown as CommentAnswerContextStore,
      dicoshot as unknown as DicoshotService,
    );
  });

  it('job context가 없으면 아무 것도 하지 않고 스킵한다', async () => {
    commentAnswerContextStore.get.mockResolvedValue(null);

    await service.handle(completedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).not.toHaveBeenCalled();
  });

  it('failed payload는 GitHub API를 호출하지 않고 Discord 알림만 보낸다', async () => {
    await service.handle(failedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'AI 코멘트 답변 실패',
        color: 'danger',
      }),
    );
  });

  it('completed payload는 스레드 루트 코멘트에 답글을 등록한다', async () => {
    await service.handle(completedPayload);

    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      comment_id: 100,
      body: '현재 방식이 맞습니다.',
    });
  });

  it('createReplyForReviewComment가 4xx 에러를 던지면 Discord 알림 후 에러를 재throw하지 않고 종료한다', async () => {
    createReplyForReviewComment.mockRejectedValue(makeHttpError(422));

    await expect(service.handle(completedPayload)).resolves.toBeUndefined();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'GitHub 코멘트 답글 등록 실패' }),
    );
  });

  it('createReplyForReviewComment가 5xx 에러를 던지면 Discord 알림 후 에러를 재throw한다', async () => {
    const error = makeHttpError(500);
    createReplyForReviewComment.mockRejectedValue(error);

    await expect(service.handle(completedPayload)).rejects.toBe(error);
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'GitHub 코멘트 답글 등록 실패' }),
    );
  });
});
