import type { DicoshotService } from 'dicoshot-nest';
import { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import { SANDBOX_PROBE_STICKY_MARKER } from './sandbox-probe-comment.formatter';
import type { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import type { SandboxProbeJobContext } from '../redis/sandbox-probe-job-context.type';
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
    dicoshot = { sendCustom: jest.fn() };

    service = new SandboxProbeResponderService(
      installationTokenManager,
      sandboxProbeJobContextStore as unknown as SandboxProbeJobContextStore,
      dicoshot as unknown as DicoshotService,
    );
  });

  it('job context가 없으면 아무 것도 하지 않고 스킵한다', async () => {
    sandboxProbeJobContextStore.get.mockResolvedValue(null);

    await service.handle(completedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
  });

  it('기존 sticky 코멘트가 없으면 새로 생성한다', async () => {
    paginate.mockResolvedValue([{ id: 1, body: '다른 코멘트' }]);

    await service.handle(completedPayload);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 5,
      }),
    );
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('기존 sticky 코멘트가 있으면 그 코멘트를 갱신한다', async () => {
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
