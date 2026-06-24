import { WebhookService } from './webhook.service';
import type { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import type { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';

describe('WebhookService', () => {
  const collected: ReviewRequestPayload = {
    reviewJobId: '1_1_sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    owner: 'owner',
    repo: 'repo',
    diff: 'diff',
    changedFiles: [],
  };

  let prDataCollector: { collect: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let service: WebhookService;

  beforeEach(() => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';

    prDataCollector = { collect: jest.fn().mockResolvedValue(collected) };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };

    service = new WebhookService(
      prDataCollector as unknown as PrDataCollectorService,
      dispatcher as unknown as ReviewDispatcherService,
    );
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function reviewCommentPayload(
    overrides: Partial<GithubWebhookPayload> = {},
  ): GithubWebhookPayload {
    return {
      action: 'created',
      installation: { id: 10 },
      pull_request: { number: 1, draft: false, head: { sha: 'sha' } },
      comment: {
        id: 999,
        in_reply_to_id: 100,
        path: 'src/foo.ts',
        line: 12,
        diff_hunk: '@@ -1 +1 @@',
        body: '@dovi-code-assist 반영했습니다',
      },
      repository: { id: 1, full_name: 'owner/repo' },
      sender: { type: 'User', login: 'alice' },
      ...overrides,
    };
  }

  it('봇 멘션 답글은 기존 리뷰 파이프라인을 재실행하고 replyContext를 싣는다', async () => {
    service.handle('pull_request_review_comment', reviewCommentPayload());
    await flush();

    expect(prDataCollector.collect).toHaveBeenCalled();
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        // commentId를 섞어 별도 job으로 (idempotency 우회)
        reviewJobId: '1_1_sha_c999',
        replyContext: {
          commentId: 999,
          inReplyToId: 100,
          path: 'src/foo.ts',
          line: 12,
          diffHunk: '@@ -1 +1 @@',
          body: '@dovi-code-assist 반영했습니다',
          author: 'alice',
        },
      }),
    );
  });

  it('봇 자신(Bot)의 답글은 무시한다 (루프 방지)', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        sender: { type: 'Bot', login: 'dovi-code-assist[bot]' },
      }),
    );
    await flush();

    expect(prDataCollector.collect).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('멘션이 없는 답글은 무시한다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 999,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '반영했습니다',
        },
      }),
    );
    await flush();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('GITHUB_BOT_LOGIN 미설정이면 멘션 답글도 무시한다', async () => {
    delete process.env.GITHUB_BOT_LOGIN;

    service.handle('pull_request_review_comment', reviewCommentPayload());
    await flush();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('처리 대상이 아닌 이벤트는 아무것도 하지 않는다', async () => {
    service.handle('issue_comment', reviewCommentPayload());
    await flush();

    expect(prDataCollector.collect).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
