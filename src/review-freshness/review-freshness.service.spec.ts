import { ReviewFreshnessService } from './review-freshness.service';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { JobStateStore } from '../redis/job-state.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error('github error'), { status });
}

describe('ReviewFreshnessService', () => {
  const context: ReviewJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 7,
    installationId: 10,
  };

  const review = (headSha: string) => ({ repositoryId: 42, headSha });

  let pullsGet: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let jobStateStore: { get: jest.Mock };
  let service: ReviewFreshnessService;

  beforeEach(() => {
    pullsGet = jest
      .fn()
      .mockResolvedValue({ data: { state: 'open', head: { sha: 'sha-1' } } });
    installationTokenManager = {
      getOctokit: jest
        .fn()
        .mockResolvedValue({ rest: { pulls: { get: pullsGet } } }),
    };
    jobStateStore = { get: jest.fn().mockResolvedValue(null) };
    service = new ReviewFreshnessService(
      installationTokenManager as unknown as InstallationTokenManager,
      jobStateStore as unknown as JobStateStore,
    );
  });

  it('열려 있고 head가 같으면 오래되지 않았다', async () => {
    await expect(
      service.findStaleReason(context, review('sha-1')),
    ).resolves.toBeNull();
    expect(pullsGet).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
    });
  });

  it('PR이 닫혔거나 머지됐으면 closed다 (머지된 PR도 state는 closed)', async () => {
    pullsGet.mockResolvedValue({
      data: { state: 'closed', head: { sha: 'sha-1' } },
    });

    await expect(
      service.findStaleReason(context, review('sha-1')),
    ).resolves.toBe('closed');
  });

  it.each(['requested', 'processing', 'completed'] as const)(
    '현재 head의 리뷰 job이 이미 %s 상태면 이 결과는 head-changed로 대체된 것이다',
    async (state) => {
      jobStateStore.get.mockResolvedValue(state);

      await expect(
        service.findStaleReason(context, review('old-sha')),
      ).resolves.toBe('head-changed');
      expect(jobStateStore.get).toHaveBeenCalledWith('42:7:sha-1');
    },
  );

  it.each([null, 'failed'] as const)(
    'head가 바뀌었어도 현재 head의 리뷰 job 상태가 %s면(봇 푸시·draft 등) 이전 결과도 게시한다',
    async (state) => {
      jobStateStore.get.mockResolvedValue(state);

      await expect(
        service.findStaleReason(context, review('old-sha')),
      ).resolves.toBeNull();
    },
  );

  it('닫혔으면서 head도 다르면 closed가 우선이다', async () => {
    pullsGet.mockResolvedValue({
      data: { state: 'closed', head: { sha: 'newer' } },
    });

    await expect(
      service.findStaleReason(context, review('old-sha')),
    ).resolves.toBe('closed');
  });

  it.each([404, 403, 429, 502])(
    'GitHub 조회가 %d로 실패하면 멀쩡한 리뷰를 잃지 않도록 오래되지 않음으로 진행한다',
    async (status) => {
      pullsGet.mockRejectedValue(httpError(status));

      await expect(
        service.findStaleReason(context, review('sha-1')),
      ).resolves.toBeNull();
    },
  );

  it('토큰 발급이 실패해도 오래되지 않음으로 진행한다', async () => {
    installationTokenManager.getOctokit.mockRejectedValue(
      new Error('no token'),
    );

    await expect(
      service.findStaleReason(context, review('sha-1')),
    ).resolves.toBeNull();
  });
});
