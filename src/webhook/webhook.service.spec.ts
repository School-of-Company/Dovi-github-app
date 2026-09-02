import { WebhookService } from './webhook.service';
import type { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import type { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import type { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import type { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';
import type { ThreadComment } from '../comment-answer/dto/comment-answer-request.payload';

describe('WebhookService', () => {
  const collected: ReviewRequestPayload = {
    reviewJobId: '1_1_sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    baseSha: 'base-sha',
    contextFiles: [],
    changedFiles: [],
  };

  const thread: ThreadComment[] = [
    {
      commentId: 100,
      author: 'dovi-code-assist[bot]',
      body: '원본 finding',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      commentId: 999,
      author: 'alice',
      body: '@dovi-code-assist 반영했습니다',
      createdAt: '2026-01-01T00:05:00Z',
    },
  ];

  let prDataCollector: { collect: jest.Mock; collectByPrNumber: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let commentAnswerCollector: { collectThread: jest.Mock };
  let commentAnswerDispatcher: { dispatch: jest.Mock };
  let service: WebhookService;

  beforeEach(() => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';

    prDataCollector = {
      collect: jest.fn().mockResolvedValue(collected),
      collectByPrNumber: jest.fn().mockResolvedValue(collected),
    };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    commentAnswerCollector = {
      collectThread: jest.fn().mockResolvedValue(thread),
    };
    commentAnswerDispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    service = new WebhookService(
      prDataCollector as unknown as PrDataCollectorService,
      dispatcher as unknown as ReviewDispatcherService,
      commentAnswerCollector as unknown as CommentAnswerCollectorService,
      commentAnswerDispatcher as unknown as CommentAnswerDispatcherService,
    );
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function reviewCommentPayload(
    overrides: Partial<GithubWebhookPayload> = {},
  ): GithubWebhookPayload {
    return {
      action: 'created',
      installation: { id: 10 },
      pull_request: {
        number: 1,
        draft: false,
        head: { sha: 'sha' },
        base: { sha: 'base-sha' },
      },
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

  it('리뷰 스레드 답글 멘션은 스레드를 모아 코멘트 Q&A로 발행하고, 전체 재리뷰는 실행하지 않는다', async () => {
    service.handle('pull_request_review_comment', reviewCommentPayload());
    await flush();

    expect(commentAnswerCollector.collectThread).toHaveBeenCalledWith(
      10,
      'owner',
      'repo',
      1,
      100,
    );
    expect(commentAnswerDispatcher.dispatch).toHaveBeenCalledWith(
      {
        commentJobId: 'qa:1:1:999',
        repositoryId: 1,
        prNumber: 1,
        path: 'src/foo.ts',
        line: 12,
        diffHunk: '@@ -1 +1 @@',
        thread,
      },
      {
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        installationId: 10,
        rootCommentId: 100,
      },
    );
    expect(prDataCollector.collect).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('최상위 코멘트에서의 멘션(답글 아님)은 기존 전체 재리뷰 파이프라인을 재실행한다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 999,
          in_reply_to_id: null,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '@dovi-code-assist 확인해주세요',
        },
      }),
    );
    await flush();

    expect(prDataCollector.collect).toHaveBeenCalled();
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewJobId: '1_1_sha_c999',
        replyContext: {
          commentId: 999,
          inReplyToId: null,
          path: 'src/foo.ts',
          line: 12,
          diffHunk: '@@ -1 +1 @@',
          body: '@dovi-code-assist 확인해주세요',
          author: 'alice',
        },
      }),
      {
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        installationId: 10,
      },
    );
    expect(commentAnswerCollector.collectThread).not.toHaveBeenCalled();
    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
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
    expect(commentAnswerCollector.collectThread).not.toHaveBeenCalled();
    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('봇 슬러그가 접두사로만 일치하는 멘션은 무시한다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 999,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '@dovi-code-assist-dev 반영했습니다',
        },
      }),
    );
    await flush();

    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
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

    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('GITHUB_BOT_LOGIN 미설정이면 멘션 답글도 무시한다', async () => {
    delete process.env.GITHUB_BOT_LOGIN;

    service.handle('pull_request_review_comment', reviewCommentPayload());
    await flush();

    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('처리 대상이 아닌 이벤트는 아무것도 하지 않는다', async () => {
    service.handle('deployment_status', reviewCommentPayload());
    await flush();

    expect(prDataCollector.collect).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(commentAnswerCollector.collectThread).not.toHaveBeenCalled();
    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
  });

  function issueCommentPayload(
    overrides: Partial<GithubWebhookPayload> = {},
  ): GithubWebhookPayload {
    return {
      action: 'created',
      installation: { id: 10 },
      issue: { number: 1, pull_request: { url: 'https://api.github.com/x' } },
      comment: {
        id: 999,
        path: '',
        line: null,
        diff_hunk: '',
        body: '/dovi review',
      },
      repository: { id: 1, full_name: 'owner/repo' },
      sender: { type: 'User', login: 'alice' },
      ...overrides,
    };
  }

  it('PR 대화창에 "/dovi review" 코멘트를 남기면 전체 재리뷰 파이프라인을 실행한다', async () => {
    service.handle('issue_comment', issueCommentPayload());
    await flush();

    expect(prDataCollector.collectByPrNumber).toHaveBeenCalledWith(
      10,
      'owner',
      'repo',
      1,
      1,
    );
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reviewJobId: '1_1_sha_c999' }),
      { owner: 'owner', repo: 'repo', prNumber: 1, installationId: 10 },
    );
  });

  it('일반 이슈(PR 아님)에 남긴 "/dovi review"는 무시한다', async () => {
    service.handle(
      'issue_comment',
      issueCommentPayload({ issue: { number: 1 } }),
    );
    await flush();

    expect(prDataCollector.collectByPrNumber).not.toHaveBeenCalled();
  });

  it('명령 문구가 정확히 일치하지 않으면 무시한다', async () => {
    service.handle(
      'issue_comment',
      issueCommentPayload({
        comment: {
          id: 999,
          path: '',
          line: null,
          diff_hunk: '',
          body: '리뷰 좀',
        },
      }),
    );
    await flush();

    expect(prDataCollector.collectByPrNumber).not.toHaveBeenCalled();
  });

  it('봇 자신의 "/dovi review" 코멘트는 무시한다 (루프 방지)', async () => {
    service.handle(
      'issue_comment',
      issueCommentPayload({
        sender: { type: 'Bot', login: 'dovi-code-assist[bot]' },
      }),
    );
    await flush();

    expect(prDataCollector.collectByPrNumber).not.toHaveBeenCalled();
  });
});
