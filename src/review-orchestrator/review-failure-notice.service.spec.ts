import { ReviewFailureNoticeService } from './review-failure-notice.service';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { ReviewFailureCommentStore } from '../redis/review-failure-comment.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('ReviewFailureNoticeService', () => {
  let createComment: jest.Mock;
  let updateComment: jest.Mock;
  let deleteComment: jest.Mock;
  let paginate: jest.Mock;
  let pullsGet: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let store: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
  let service: ReviewFailureNoticeService;

  const context: ReviewJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 7,
    installationId: 10,
  };

  const failed = (
    reason: ReviewFailedPayload['reason'],
  ): ReviewFailedPayload => ({
    reviewJobId: '1:7:abcdef1234',
    headSha: 'abcdef1234',
    reason,
  });

  beforeEach(() => {
    createComment = jest.fn().mockResolvedValue({ data: { id: 500 } });
    updateComment = jest.fn().mockResolvedValue({ data: { id: 500 } });
    deleteComment = jest.fn().mockResolvedValue(undefined);
    paginate = jest.fn().mockResolvedValue([]);
    pullsGet = jest.fn().mockResolvedValue({
      data: { state: 'open', head: { sha: 'abcdef1234' } },
    });
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        paginate,
        rest: {
          pulls: { get: pullsGet },
          issues: {
            createComment,
            updateComment,
            deleteComment,
            listComments: jest.fn(),
          },
        },
      }),
    };
    store = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReviewFailureNoticeService(
      installationTokenManager as unknown as InstallationTokenManager,
      store as unknown as ReviewFailureCommentStore,
    );
  });

  describe('notify', () => {
    it('실패한 커밋이 이미 PR의 최신 head가 아니면 안내하지 않는다', async () => {
      pullsGet.mockResolvedValue({
        data: { state: 'open', head: { sha: 'newer-sha' } },
      });

      await service.notify(context, failed('timeout'));

      expect(createComment).not.toHaveBeenCalled();
      expect(updateComment).not.toHaveBeenCalled();
    });

    it('PR이 이미 닫혔으면 안내하지 않는다', async () => {
      pullsGet.mockResolvedValue({
        data: { state: 'closed', head: { sha: 'abcdef1234' } },
      });

      await service.notify(context, failed('context_overflow'));

      expect(createComment).not.toHaveBeenCalled();
    });

    it('기존 안내가 없으면 PR에 코멘트를 새로 달고 id를 저장한다', async () => {
      await service.notify(context, failed('context_overflow'));

      expect(createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          issue_number: 7,
        }),
      );
      expect(store.set).toHaveBeenCalledWith('owner', 'repo', 7, 500);
    });

    it('context_overflow는 재시도 대신 PR을 나눠 달라고 안내한다', async () => {
      await service.notify(context, failed('context_overflow'));

      const body = (createComment.mock.calls[0] as [{ body: string }])[0].body;
      expect(body).toContain('작은 PR로 나눠');
      expect(body).not.toContain('/dovi review');
      expect(body).toContain('abcdef1');
    });

    it.each(['timeout', 'server_error', 'parse_error'] as const)(
      '%s는 /dovi review 재시도를 안내한다',
      async (reason) => {
        await service.notify(context, failed(reason));

        const body = (createComment.mock.calls[0] as [{ body: string }])[0]
          .body;
        expect(body).toContain('/dovi review');
      },
    );

    it('알 수 없는 reason이 와도 undefined 대신 기본 문구를 쓴다', async () => {
      await service.notify(
        context,
        failed('brand_new_reason' as ReviewFailedPayload['reason']),
      );

      const body = (createComment.mock.calls[0] as [{ body: string }])[0].body;
      expect(body).not.toContain('undefined');
      expect(body).toContain('/dovi review');
    });

    it('기존 안내가 있으면 새로 만들지 않고 그 코멘트를 갱신한다', async () => {
      store.get.mockResolvedValue(42);

      await service.notify(context, failed('timeout'));

      expect(updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 42 }),
      );
      expect(createComment).not.toHaveBeenCalled();
      // 갱신할 때도 TTL을 늘려 오래 실패하는 PR에서 기록이 만료되지 않게 한다.
      expect(store.set).toHaveBeenCalledWith('owner', 'repo', 7, 42);
    });

    it('id 기록이 없어도 마커가 달린 기존 안내가 있으면 그 코멘트를 갱신한다', async () => {
      paginate.mockResolvedValue([
        { id: 1, body: '다른 코멘트' },
        { id: 99, body: '<!-- dovi:review-failure -->\n이전 안내' },
      ]);

      await service.notify(context, failed('timeout'));

      expect(updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 99 }),
      );
      expect(createComment).not.toHaveBeenCalled();
      expect(store.set).toHaveBeenCalledWith('owner', 'repo', 7, 99);
    });

    it('저장된 코멘트가 삭제됐으면(404) 새로 만든다', async () => {
      store.get.mockResolvedValue(42);
      updateComment.mockRejectedValue(makeHttpError(404));

      await service.notify(context, failed('timeout'));

      expect(createComment).toHaveBeenCalled();
      expect(store.set).toHaveBeenCalledWith('owner', 'repo', 7, 500);
    });

    it('게시가 실패해도 예외를 던지지 않는다', async () => {
      createComment.mockRejectedValue(makeHttpError(403));

      await expect(
        service.notify(context, failed('timeout')),
      ).resolves.toBeUndefined();
    });
  });

  describe('clear', () => {
    it('저장된 안내가 없으면 GitHub API를 호출하지 않는다', async () => {
      await service.clear(context);

      expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
      expect(deleteComment).not.toHaveBeenCalled();
    });

    it('저장된 안내가 있으면 코멘트를 지우고 id도 지운다', async () => {
      store.get.mockResolvedValue(42);

      await service.clear(context);

      expect(deleteComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 42 }),
      );
      expect(store.delete).toHaveBeenCalledWith('owner', 'repo', 7);
    });

    it('코멘트가 이미 지워졌으면(404) id만 정리한다', async () => {
      store.get.mockResolvedValue(42);
      deleteComment.mockRejectedValue(makeHttpError(404));

      await service.clear(context);

      expect(store.delete).toHaveBeenCalledWith('owner', 'repo', 7);
    });

    it('삭제가 실패해도 예외를 던지지 않고 id는 남겨둔다(다음 성공 때 재시도)', async () => {
      store.get.mockResolvedValue(42);
      deleteComment.mockRejectedValue(makeHttpError(403));

      await expect(service.clear(context)).resolves.toBeUndefined();
      expect(store.delete).not.toHaveBeenCalled();
    });
  });
});
