import { WebhookService } from './webhook.service';
import type { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import type { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import type { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import type { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import type { RepoIndexCollectorService } from '../repo-index/repo-index-collector.service';
import type { RepoIndexDispatcherService } from '../repo-index/repo-index-dispatcher.service';
import type { ReviewFeedbackDispatcherService } from '../review-feedback/review-feedback-dispatcher.service';
import type { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';
import type { ThreadComment } from '../comment-answer/dto/comment-answer-request.payload';

describe('WebhookService', () => {
  const collected: ReviewRequestPayload = {
    reviewJobId: '1_1_sha',
    repositoryId: 1,
    prNumber: 1,
    prTitle: 'PR 제목',
    prBody: 'PR 본문',
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
  let repoIndexCollector: {
    resolveIndexBranch: jest.Mock;
    collect: jest.Mock;
  };
  let repoIndexDispatcher: { dispatch: jest.Mock };
  let reviewFeedbackDispatcher: { dispatch: jest.Mock };
  let reviewCommentFindingStore: { get: jest.Mock };
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
    repoIndexCollector = {
      resolveIndexBranch: jest.fn().mockResolvedValue('develop'),
      collect: jest.fn().mockResolvedValue(null),
    };
    repoIndexDispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    reviewFeedbackDispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    reviewCommentFindingStore = { get: jest.fn().mockResolvedValue(null) };

    service = new WebhookService(
      prDataCollector as unknown as PrDataCollectorService,
      dispatcher as unknown as ReviewDispatcherService,
      commentAnswerCollector as unknown as CommentAnswerCollectorService,
      commentAnswerDispatcher as unknown as CommentAnswerDispatcherService,
      repoIndexCollector as unknown as RepoIndexCollectorService,
      repoIndexDispatcher as unknown as RepoIndexDispatcherService,
      reviewFeedbackDispatcher as unknown as ReviewFeedbackDispatcherService,
      reviewCommentFindingStore as unknown as ReviewCommentFindingStore,
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
        title: 'PR 제목',
        body: 'PR 본문',
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
      repository: { id: 1, full_name: 'owner/repo', default_branch: 'main' },
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
      repository: { id: 1, full_name: 'owner/repo', default_branch: 'main' },
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

  function pushPayload(
    overrides: Partial<GithubWebhookPayload> = {},
  ): GithubWebhookPayload {
    return {
      action: '',
      installation: { id: 10 },
      ref: 'refs/heads/develop',
      before: 'before-sha',
      after: 'after-sha',
      repository: {
        id: 1,
        full_name: 'owner/repo',
        default_branch: 'main',
      },
      sender: { type: 'User', login: 'alice' },
      ...overrides,
    };
  }

  it('Index Branch(DOVI.md)로 push되면 repo.index.requested를 발행한다', async () => {
    repoIndexCollector.resolveIndexBranch.mockResolvedValue('develop');
    repoIndexCollector.collect.mockResolvedValue({
      repositoryId: 1,
      branch: 'develop',
      headSha: 'after-sha',
      changedFiles: [],
    });

    service.handle('push', pushPayload());
    await flush();

    expect(repoIndexCollector.resolveIndexBranch).toHaveBeenCalledWith(
      10,
      'owner',
      'repo',
      'main',
    );
    expect(repoIndexCollector.collect).toHaveBeenCalledWith(
      10,
      'owner',
      'repo',
      1,
      'develop',
      'before-sha',
      'after-sha',
    );
    expect(repoIndexDispatcher.dispatch).toHaveBeenCalledWith({
      repositoryId: 1,
      branch: 'develop',
      headSha: 'after-sha',
      changedFiles: [],
    });
  });

  it('Index Branch가 아닌 브랜치로의 push는 무시한다', async () => {
    repoIndexCollector.resolveIndexBranch.mockResolvedValue('develop');

    service.handle('push', pushPayload({ ref: 'refs/heads/feature/x' }));
    await flush();

    expect(repoIndexCollector.collect).not.toHaveBeenCalled();
    expect(repoIndexDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('브랜치 삭제 push(after가 전부 0)는 무시한다', async () => {
    service.handle(
      'push',
      pushPayload({ after: '0000000000000000000000000000000000000000' }),
    );
    await flush();

    expect(repoIndexCollector.resolveIndexBranch).not.toHaveBeenCalled();
  });

  it('collect가 null(신규 브랜치 등)을 반환하면 발행하지 않는다', async () => {
    repoIndexCollector.resolveIndexBranch.mockResolvedValue('develop');
    repoIndexCollector.collect.mockResolvedValue(null);

    service.handle('push', pushPayload());
    await flush();

    expect(repoIndexDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('봇 리뷰 코멘트 스레드 답글이 "반영했다"로 읽히면 pr.comment.reflected를 발행한다', async () => {
    reviewCommentFindingStore.get.mockResolvedValue({
      reviewJobId: '1:1:sha',
      findingIndex: 2,
    });

    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 555,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '반영했습니다',
        },
      }),
    );
    await flush();

    expect(reviewCommentFindingStore.get).toHaveBeenCalledWith(100);
    expect(reviewFeedbackDispatcher.dispatch).toHaveBeenCalledWith(
      { reviewJobId: '1:1:sha', findingIndex: 2, reflected: true },
      555,
    );
  });

  it('원본 코멘트가 우리 봇 리뷰가 아니면(매핑 없음) 발행하지 않는다', async () => {
    reviewCommentFindingStore.get.mockResolvedValue(null);

    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 555,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '반영했습니다',
        },
      }),
    );
    await flush();

    expect(reviewFeedbackDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('애매한 답글은 반영 여부 매핑 조회조차 하지 않는다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 555,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '네 확인했습니다',
        },
      }),
    );
    await flush();

    expect(reviewCommentFindingStore.get).not.toHaveBeenCalled();
    expect(reviewFeedbackDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('봇 자신의 답글은 반영 여부 감지 대상에서 제외한다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 555,
          in_reply_to_id: 100,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '반영했습니다',
        },
        sender: { type: 'Bot', login: 'dovi-code-assist[bot]' },
      }),
    );
    await flush();

    expect(reviewCommentFindingStore.get).not.toHaveBeenCalled();
  });

  it('최상위 코멘트(답글 아님)는 반영 여부 감지 대상이 아니다', async () => {
    service.handle(
      'pull_request_review_comment',
      reviewCommentPayload({
        comment: {
          id: 555,
          in_reply_to_id: null,
          path: 'src/foo.ts',
          line: 12,
          diff_hunk: '@@ -1 +1 @@',
          body: '반영했습니다',
        },
      }),
    );
    await flush();

    expect(reviewCommentFindingStore.get).not.toHaveBeenCalled();
  });
});
