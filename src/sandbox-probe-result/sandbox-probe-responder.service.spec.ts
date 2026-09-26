import type { DicoshotService } from 'dicoshot-nest';
import { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import { SANDBOX_PROBE_STICKY_MARKER } from './sandbox-probe-comment.formatter';
import type { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import type { SandboxProbeJobContext } from '../redis/sandbox-probe-job-context.type';
import type { SandboxProbeStickyCommentStore } from '../redis/sandbox-probe-sticky-comment.store';
import type { SandboxProbeCompletedPayload } from './dto/sandbox-probe-completed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('SandboxProbeResponderService', () => {
  let createComment: jest.Mock;
  let updateComment: jest.Mock;
  let listComments: jest.Mock;
  let paginate: jest.Mock;
  let installationTokenManager: {
    getOctokit: jest.Mock;
    getScopedToken: jest.Mock;
  };
  let sandboxProbeJobContextStore: { get: jest.Mock };
  let sandboxProbeStickyCommentStore: {
    get: jest.Mock;
    set: jest.Mock;
    delete: jest.Mock;
  };
  let dicoshot: { sendCustom: jest.Mock };
  let service: SandboxProbeResponderService;

  const context: SandboxProbeJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 5,
    installationId: 10,
  };

  const completedPayload: SandboxProbeCompletedPayload = {
    reviewJobId: '1:5:sha',
    repositoryId: 1,
    prNumber: 5,
    headSha: 'sha',
    status: 'passed',
    evidence: '',
    findings: [],
  };

  beforeEach(() => {
    createComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
    updateComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
    listComments = jest.fn();
    paginate = jest.fn().mockResolvedValue([]);
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: { issues: { createComment, updateComment, listComments } },
        paginate,
      }),
      getScopedToken: jest.fn(),
    };
    sandboxProbeJobContextStore = { get: jest.fn().mockResolvedValue(context) };
    sandboxProbeStickyCommentStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    dicoshot = { sendCustom: jest.fn() };

    service = new SandboxProbeResponderService(
      installationTokenManager,
      sandboxProbeJobContextStore as unknown as SandboxProbeJobContextStore,
      sandboxProbeStickyCommentStore as unknown as SandboxProbeStickyCommentStore,
      dicoshot as unknown as DicoshotService,
    );
  });

  it('job context가 없으면 아무 것도 하지 않고 스킵한다', async () => {
    sandboxProbeJobContextStore.get.mockResolvedValue(null);

    await service.handle(completedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
  });

  it('캐시된 코멘트 id가 있으면 검색 없이 바로 갱신한다', async () => {
    sandboxProbeStickyCommentStore.get.mockResolvedValue(77);

    await service.handle(completedPayload);

    expect(paginate).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 77 }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('캐시가 없고 기존 sticky 코멘트도 없으면 새로 생성하고 id를 캐싱한다', async () => {
    paginate.mockResolvedValue([{ id: 1, body: '다른 코멘트' }]);
    createComment.mockResolvedValue({ data: { id: 555 } });

    await service.handle(completedPayload);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 5,
      }),
    );
    expect(updateComment).not.toHaveBeenCalled();
    expect(sandboxProbeStickyCommentStore.set).toHaveBeenCalledWith(1, 5, 555);
  });

  it('캐시는 없지만 기존 sticky 코멘트가 있으면 그 코멘트를 갱신하고 캐싱한다', async () => {
    paginate.mockResolvedValue([
      { id: 42, body: `${SANDBOX_PROBE_STICKY_MARKER}\n이전 상태` },
    ]);

    await service.handle(completedPayload);

    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        comment_id: 42,
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
    expect(sandboxProbeStickyCommentStore.set).toHaveBeenCalledWith(1, 5, 42);
  });

  it('캐시된 코멘트가 삭제됐으면(404) 캐시를 비우고 다시 찾아서 처리한다', async () => {
    sandboxProbeStickyCommentStore.get.mockResolvedValue(77);
    updateComment
      .mockRejectedValueOnce(makeHttpError(404))
      .mockResolvedValueOnce({ data: { id: 42 } });
    paginate.mockResolvedValue([
      { id: 42, body: `${SANDBOX_PROBE_STICKY_MARKER}\n이전 상태` },
    ]);

    await service.handle(completedPayload);

    expect(sandboxProbeStickyCommentStore.delete).toHaveBeenCalledWith(1, 5);
    expect(updateComment).toHaveBeenCalledTimes(2);
    expect(sandboxProbeStickyCommentStore.set).toHaveBeenCalledWith(1, 5, 42);
  });

  it('코멘트 게시가 4xx 에러면 Discord 알림 후 재throw하지 않고 종료한다', async () => {
    createComment.mockRejectedValue(makeHttpError(422));

    await expect(service.handle(completedPayload)).resolves.toBeUndefined();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: '샌드박스 프로브 코멘트 게시 실패' }),
    );
  });

  it('코멘트 게시가 5xx 에러면 Discord 알림 후 재throw한다', async () => {
    const error = makeHttpError(500);
    createComment.mockRejectedValue(error);

    await expect(service.handle(completedPayload)).rejects.toBe(error);
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: '샌드박스 프로브 코멘트 게시 실패' }),
    );
  });
});
