import { ReviewReactionService } from './review-reaction.service';

describe('ReviewReactionService', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  let createForIssue: jest.Mock;
  let createForPullRequestReviewComment: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let service: ReviewReactionService;

  beforeEach(() => {
    createForIssue = jest.fn().mockResolvedValue(undefined);
    createForPullRequestReviewComment = jest.fn().mockResolvedValue(undefined);
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: {
          reactions: { createForIssue, createForPullRequestReviewComment },
        },
      }),
    };
    service = new ReviewReactionService(installationTokenManager);
  });

  it('markPrInProgress는 PR(issue)에 eyes 리액션을 추가한다', async () => {
    await service.markPrInProgress(10, 'owner', 'repo', 1);

    expect(createForIssue).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      content: 'eyes',
    });
  });

  it('markReviewCommentInProgress는 리뷰 코멘트에 eyes 리액션을 추가한다', async () => {
    await service.markReviewCommentInProgress(10, 'owner', 'repo', 999);

    expect(createForPullRequestReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 999,
      content: 'eyes',
    });
  });

  it('notifyPrInProgress는 실패해도 예외를 던지지 않는다', async () => {
    createForIssue.mockRejectedValue(new Error('rate limited'));

    expect(() =>
      service.notifyPrInProgress(10, 'owner', 'repo', 1),
    ).not.toThrow();
    await flush();
  });

  it('notifyReviewCommentInProgress는 실패해도 예외를 던지지 않는다', async () => {
    createForPullRequestReviewComment.mockRejectedValue(new Error('gone'));

    expect(() =>
      service.notifyReviewCommentInProgress(10, 'owner', 'repo', 999),
    ).not.toThrow();
    await flush();
  });
});
