import { ReviewCommandGuardService } from './review-command-guard.service';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { ReviewCommandCooldownStore } from '../redis/review-command-cooldown.store';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('ReviewCommandGuardService', () => {
  let getPermission: jest.Mock;
  let cooldownStore: { acquire: jest.Mock };
  let installationTokenManager: { getOctokit: jest.Mock };
  let service: ReviewCommandGuardService;

  const request = {
    installationId: 10,
    owner: 'owner',
    repo: 'repo',
    repositoryId: 1,
    prNumber: 5,
    commenter: 'alice',
    prAuthor: 'bob',
  };

  beforeEach(() => {
    delete process.env.REVIEW_COMMAND_COOLDOWN_SECONDS;
    getPermission = jest
      .fn()
      .mockResolvedValue({ data: { permission: 'write' } });
    cooldownStore = { acquire: jest.fn().mockResolvedValue(true) };
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: { repos: { getCollaboratorPermissionLevel: getPermission } },
      }),
    };
    service = new ReviewCommandGuardService(
      installationTokenManager as unknown as InstallationTokenManager,
      cooldownStore as unknown as ReviewCommandCooldownStore,
    );
  });

  it('PR 작성자는 권한 조회 없이 허용한다 (대소문자 무시)', async () => {
    const decision = await service.check({
      ...request,
      commenter: 'Bob',
      prAuthor: 'bob',
    });

    expect(decision).toBe('allowed');
    expect(getPermission).not.toHaveBeenCalled();
  });

  it.each(['admin', 'write'])('%s 권한자는 허용한다', async (permission) => {
    getPermission.mockResolvedValue({ data: { permission } });

    await expect(service.check(request)).resolves.toBe('allowed');
    expect(getPermission).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      username: 'alice',
    });
  });

  it('maintain 역할(role_name)도 허용한다', async () => {
    getPermission.mockResolvedValue({
      data: { permission: 'none', role_name: 'maintain' },
    });

    await expect(service.check(request)).resolves.toBe('allowed');
  });

  it.each(['read', 'none'])('%s 권한자는 거부한다', async (permission) => {
    getPermission.mockResolvedValue({ data: { permission } });

    await expect(service.check(request)).resolves.toBe('forbidden');
    expect(cooldownStore.acquire).not.toHaveBeenCalled();
  });

  it('협업자가 아니라 404가 오면 권한 없음으로 거부한다', async () => {
    getPermission.mockRejectedValue(httpError(404));

    await expect(service.check(request)).resolves.toBe('forbidden');
  });

  it('권한 조회가 일시 오류로 실패하면 거부한다 (fail-closed)', async () => {
    getPermission.mockRejectedValue(httpError(500));

    await expect(service.check(request)).resolves.toBe('error');
    expect(cooldownStore.acquire).not.toHaveBeenCalled();
  });

  it('쿨다운 중이면 cooldown으로 판정한다', async () => {
    cooldownStore.acquire.mockResolvedValue(false);

    await expect(service.check(request)).resolves.toBe('cooldown');
    expect(cooldownStore.acquire).toHaveBeenCalledWith(1, 5, 60);
  });

  it('쿨다운 시간은 환경변수로 바꾸고 0이면 끈다', async () => {
    process.env.REVIEW_COMMAND_COOLDOWN_SECONDS = '120';
    await service.check(request);
    expect(cooldownStore.acquire).toHaveBeenLastCalledWith(1, 5, 120);

    process.env.REVIEW_COMMAND_COOLDOWN_SECONDS = '0';
    cooldownStore.acquire.mockClear();
    await expect(service.check(request)).resolves.toBe('allowed');
    expect(cooldownStore.acquire).not.toHaveBeenCalled();
  });

  it('잘못된 쿨다운 값은 기본값(60초)을 쓴다', async () => {
    process.env.REVIEW_COMMAND_COOLDOWN_SECONDS = 'abc';
    await service.check(request);

    expect(cooldownStore.acquire).toHaveBeenCalledWith(1, 5, 60);
  });

  it('Redis 오류가 나면 거부한다', async () => {
    cooldownStore.acquire.mockRejectedValue(new Error('redis down'));

    await expect(service.check(request)).resolves.toBe('error');
  });
});
