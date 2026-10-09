import { WebhookService } from './webhook.service';
import type { ReviewCommandGuardService } from './review-command-guard.service';
import type { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import type { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import type { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import type { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import type { RepoIndexCollectorService } from '../repo-index/repo-index-collector.service';
import type { RepoIndexDispatcherService } from '../repo-index/repo-index-dispatcher.service';
import type { ReviewFeedbackDispatcherService } from '../review-feedback/review-feedback-dispatcher.service';
import type { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import type { ReviewReactionService } from '../review-reaction/review-reaction.service';
import type { SandboxProbeDispatcherService } from '../sandbox-probe/sandbox-probe-dispatcher.service';
import type { DicoshotService } from 'dicoshot-nest';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';
import type { ThreadComment } from '../comment-answer/dto/comment-answer-request.payload';

// expect.any()는 any를 돌려줘서 객체 리터럴 안에서 쓰면 lint(no-unsafe-assignment)에 걸린다.
const anyNumber = expect.any(Number) as number;

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
  let reviewReactionService: {
    notifyPrInProgress: jest.Mock;
    notifyReviewCommentInProgress: jest.Mock;
    notifyIssueCommentInProgress: jest.Mock;
  };
  let sandboxProbeDispatcherService: { notifyPrOpened: jest.Mock };
  let reviewCommandGuard: { check: jest.Mock };
  let dicoshot: { sendCustom: jest.Mock };
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
    reviewReactionService = {
      notifyPrInProgress: jest.fn(),
      notifyReviewCommentInProgress: jest.fn(),
      notifyIssueCommentInProgress: jest.fn(),
    };
    sandboxProbeDispatcherService = { notifyPrOpened: jest.fn() };
    reviewCommandGuard = { check: jest.fn().mockResolvedValue('allowed') };
    dicoshot = { sendCustom: jest.fn().mockResolvedValue(undefined) };

    service = new WebhookService(
      prDataCollector as unknown as PrDataCollectorService,
      dispatcher as unknown as ReviewDispatcherService,
      commentAnswerCollector as unknown as CommentAnswerCollectorService,
      commentAnswerDispatcher as unknown as CommentAnswerDispatcherService,
      repoIndexCollector as unknown as RepoIndexCollectorService,
      repoIndexDispatcher as unknown as RepoIndexDispatcherService,
      reviewFeedbackDispatcher as unknown as ReviewFeedbackDispatcherService,
      reviewCommentFindingStore as unknown as ReviewCommentFindingStore,
      reviewReactionService as unknown as ReviewReactionService,
      sandboxProbeDispatcherService as unknown as SandboxProbeDispatcherService,
      reviewCommandGuard as unknown as ReviewCommandGuardService,
      dicoshot as unknown as DicoshotService,
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
        head: { sha: 'sha', repo: { id: 1, full_name: 'owner/repo' } },
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
    expect(
      reviewReactionService.notifyReviewCommentInProgress,
    ).toHaveBeenCalledWith(10, 'owner', 'repo', 999);
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
        collectStartedAt: anyNumber,
      },
    );
    expect(commentAnswerCollector.collectThread).not.toHaveBeenCalled();
    expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
    expect(
      reviewReactionService.notifyReviewCommentInProgress,
    ).toHaveBeenCalledWith(10, 'owner', 'repo', 999);
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

  function pullRequestPayload(
    overrides: Partial<GithubWebhookPayload> = {},
  ): GithubWebhookPayload {
    return {
      action: 'opened',
      installation: { id: 10 },
      pull_request: {
        number: 1,
        draft: false,
        title: 'PR 제목',
        body: 'PR 본문',
        head: { sha: 'sha', repo: { id: 1, full_name: 'owner/repo' } },
        base: { sha: 'base-sha' },
      },
      repository: { id: 1, full_name: 'owner/repo', default_branch: 'main' },
      sender: { type: 'User', login: 'alice' },
      ...overrides,
    };
  }

  it('PR이 열리면(opened) 전체 리뷰 파이프라인을 실행하고 👀 리액션을 남긴다', async () => {
    service.handle('pull_request', pullRequestPayload());
    await flush();

    expect(prDataCollector.collect).toHaveBeenCalled();
    expect(reviewReactionService.notifyPrInProgress).toHaveBeenCalledWith(
      10,
      'owner',
      'repo',
      1,
    );
  });

  it('PR 이벤트마다 메인 리뷰와 독립적으로 샌드박스 프로브 발행 여부를 검토한다', async () => {
    service.handle('pull_request', pullRequestPayload());
    await flush();

    expect(sandboxProbeDispatcherService.notifyPrOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 10,
        owner: 'owner',
        repo: 'repo',
        repositoryId: 1,
        defaultBranch: 'main',
        prNumber: 1,
        headSha: 'sha',
        baseSha: 'base-sha',
        isFork: false,
      }),
    );
  });

  it('fork PR이면 isFork: true로 샌드박스 프로브 발행 검토를 넘긴다', async () => {
    service.handle(
      'pull_request',
      pullRequestPayload({
        pull_request: {
          number: 1,
          draft: false,
          title: 'PR 제목',
          body: 'PR 본문',
          head: { sha: 'sha', repo: { id: 999, full_name: 'someone/fork' } },
          base: { sha: 'base-sha' },
        },
      }),
    );
    await flush();

    expect(sandboxProbeDispatcherService.notifyPrOpened).toHaveBeenCalledWith(
      expect.objectContaining({ isFork: true }),
    );
  });

  describe('pull_request 액션별 동작 (자동 리뷰는 push에 돌지 않는다)', () => {
    it.each(['opened', 'reopened', 'ready_for_review'])(
      '%s면 AI 리뷰를 실행하고 👀 리액션을 남긴다',
      async (action) => {
        service.handle('pull_request', pullRequestPayload({ action }));
        await flush();

        expect(prDataCollector.collect).toHaveBeenCalled();
        expect(dispatcher.dispatch).toHaveBeenCalled();
        expect(reviewReactionService.notifyPrInProgress).toHaveBeenCalledWith(
          10,
          'owner',
          'repo',
          1,
        );
      },
    );

    it('synchronize(push)는 AI 리뷰도 👀 리액션도 하지 않는다', async () => {
      service.handle(
        'pull_request',
        pullRequestPayload({ action: 'synchronize' }),
      );
      await flush();

      expect(prDataCollector.collect).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
      expect(reviewReactionService.notifyPrInProgress).not.toHaveBeenCalled();
    });

    it('synchronize(push)에도 샌드박스 프로브 발행 검토는 계속한다', async () => {
      service.handle(
        'pull_request',
        pullRequestPayload({ action: 'synchronize' }),
      );
      await flush();

      expect(sandboxProbeDispatcherService.notifyPrOpened).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 1 }),
      );
    });

    it.each(['labeled', 'assigned', 'edited', 'closed', 'review_requested'])(
      '리뷰와 무관한 액션(%s)은 아무것도 하지 않는다',
      async (action) => {
        service.handle('pull_request', pullRequestPayload({ action }));
        await flush();

        expect(prDataCollector.collect).not.toHaveBeenCalled();
        expect(reviewReactionService.notifyPrInProgress).not.toHaveBeenCalled();
        expect(
          sandboxProbeDispatcherService.notifyPrOpened,
        ).not.toHaveBeenCalled();
      },
    );

    it('draft PR은 리뷰도 프로브 검토도 하지 않는다', async () => {
      service.handle(
        'pull_request',
        pullRequestPayload({
          pull_request: {
            number: 1,
            draft: true,
            title: 'PR 제목',
            body: 'PR 본문',
            head: { sha: 'sha', repo: { id: 1, full_name: 'owner/repo' } },
            base: { sha: 'base-sha' },
          },
        }),
      );
      await flush();

      expect(prDataCollector.collect).not.toHaveBeenCalled();
      expect(
        sandboxProbeDispatcherService.notifyPrOpened,
      ).not.toHaveBeenCalled();
    });

    it('봇이 연 PR은 무시한다 (루프 방지)', async () => {
      service.handle(
        'pull_request',
        pullRequestPayload({
          sender: { type: 'Bot', login: 'dependabot[bot]' },
        }),
      );
      await flush();

      expect(prDataCollector.collect).not.toHaveBeenCalled();
    });
  });

  it('PR 데이터 수집이 실패하면 Discord로 실패를 알린다', async () => {
    prDataCollector.collect.mockRejectedValue(new Error('connect timeout'));

    service.handle('pull_request', pullRequestPayload());
    await flush();

    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: '리뷰 트리거 실패', color: 'danger' }),
    );
    const call = dicoshot.sendCustom.mock.calls[0] as [{ description: string }];
    expect(call[0].description).toContain('owner/repo#1');
  });

  it('Discord 알림 전송 자체가 실패해도 예외를 던지지 않는다', async () => {
    prDataCollector.collect.mockRejectedValue(new Error('connect timeout'));
    dicoshot.sendCustom.mockRejectedValue(new Error('discord down'));

    service.handle('pull_request', pullRequestPayload());
    await flush();

    expect(dicoshot.sendCustom).toHaveBeenCalled();
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

  it('PR 대화창에 "/dovi review" 코멘트를 남기면 전체 재리뷰 파이프라인을 실행하고 👀 리액션을 남긴다', async () => {
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
      {
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        installationId: 10,
        collectStartedAt: anyNumber,
      },
    );
    expect(
      reviewReactionService.notifyIssueCommentInProgress,
    ).toHaveBeenCalledWith(10, 'owner', 'repo', 999);
  });

  it('PR 대화창에서 봇을 멘션만 해도(명령어 아니어도) 전체 재리뷰를 실행한다', async () => {
    service.handle(
      'issue_comment',
      issueCommentPayload({
        comment: {
          id: 999,
          path: '',
          line: null,
          diff_hunk: '',
          body: '@dovi-code-assist 다시 봐주세요',
        },
      }),
    );
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
      {
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        installationId: 10,
        collectStartedAt: anyNumber,
      },
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

  it('/dovi review 재실행이 실패하면 Discord로 실패를 알린다', async () => {
    prDataCollector.collectByPrNumber.mockRejectedValue(
      new Error('connect timeout'),
    );

    service.handle('issue_comment', issueCommentPayload());
    await flush();

    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: '리뷰 트리거 실패', color: 'danger' }),
    );
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
  describe('명령 권한·쿨다운', () => {
    it('/dovi review는 PR 작성자·코멘트 작성자·레포 정보로 권한 검사를 거친다', async () => {
      service.handle(
        'issue_comment',
        issueCommentPayload({
          issue: {
            number: 1,
            user: { login: 'carol' },
            pull_request: { url: 'https://api.github.com/x' },
          },
        }),
      );
      await flush();

      expect(reviewCommandGuard.check).toHaveBeenCalledWith({
        installationId: 10,
        owner: 'owner',
        repo: 'repo',
        repositoryId: 1,
        prNumber: 1,
        commenter: 'alice',
        prAuthor: 'carol',
      });
    });

    it.each(['forbidden', 'cooldown', 'error'] as const)(
      '/dovi review가 %s 판정이면 AI 리뷰를 일으키지 않는다',
      async (decision) => {
        reviewCommandGuard.check.mockResolvedValue(decision);

        service.handle('issue_comment', issueCommentPayload());
        await flush();

        expect(prDataCollector.collectByPrNumber).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
        expect(
          reviewReactionService.notifyIssueCommentInProgress,
        ).not.toHaveBeenCalled();
      },
    );

    it('봇 멘션 명령도 같은 검사를 거치고 거부되면 실행하지 않는다', async () => {
      reviewCommandGuard.check.mockResolvedValue('forbidden');

      service.handle(
        'issue_comment',
        issueCommentPayload({
          comment: {
            id: 999,
            path: '',
            line: null,
            diff_hunk: '',
            body: '@dovi-code-assist 다시 봐줘',
          },
        }),
      );
      await flush();

      expect(reviewCommandGuard.check).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('리뷰 스레드 멘션 답글도 권한이 없으면 Q&A를 발행하지 않는다', async () => {
      reviewCommandGuard.check.mockResolvedValue('forbidden');

      service.handle('pull_request_review_comment', reviewCommentPayload());
      await flush();

      expect(commentAnswerCollector.collectThread).not.toHaveBeenCalled();
      expect(commentAnswerDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('명령이 아닌 일반 코멘트는 권한 조회 자체를 하지 않는다', async () => {
      service.handle(
        'issue_comment',
        issueCommentPayload({
          comment: {
            id: 999,
            path: '',
            line: null,
            diff_hunk: '',
            body: 'LGTM',
          },
        }),
      );
      await flush();

      expect(reviewCommandGuard.check).not.toHaveBeenCalled();
    });
  });
});
