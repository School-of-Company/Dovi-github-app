jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(),
}));
// @octokit/rest는 ESM 전용이라 ts-jest 기본 설정으로 변환되지 않는다. 이 테스트는
// appAuth 자체를 mock하므로 실제 Octokit 인스턴스가 필요 없어 함께 mock한다.
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({ request: jest.fn() })),
}));

import type Redis from 'ioredis';
import { createAppAuth } from '@octokit/auth-app';
import { InstallationTokenManagerService } from './installation-token-manager.service';

describe('InstallationTokenManagerService', () => {
  let redis: {
    get: jest.Mock<Promise<string | null>, [string]>;
    set: jest.Mock<Promise<unknown>, [string, string, string, number]>;
  };
  let appAuthMock: jest.Mock;
  let service: InstallationTokenManagerService;

  beforeEach(() => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_PRIVATE_KEY = 'dummy-key';

    redis = {
      get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      set: jest.fn<Promise<unknown>, [string, string, string, number]>(),
    };
    appAuthMock = jest.fn();
    (createAppAuth as jest.Mock).mockReturnValue(appAuthMock);

    service = new InstallationTokenManagerService(redis as unknown as Redis);
  });

  function expiresInSeconds(seconds: number): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  it('캐시 미스 시 appAuth를 호출해 토큰을 발급하고, 실제 만료시각 기준 TTL로 캐싱한다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'tok-1',
      expiresAt: expiresInSeconds(3600),
    });

    await service.getOctokit(1);

    expect(appAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'installation', installationId: 1 }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'github:token:1',
      'tok-1',
      'EX',
      expect.any(Number),
    );
    const ttl = redis.set.mock.calls[0][3];
    expect(ttl).toBeLessThan(3600);
    expect(ttl).toBeGreaterThan(0);
  });

  it('캐시 히트면 appAuth를 호출하지 않는다', async () => {
    redis.get.mockResolvedValue('cached-token');

    await service.getOctokit(1);

    expect(appAuthMock).not.toHaveBeenCalled();
  });

  it('만료가 안전 마진 이내로 임박하면 캐싱하지 않는다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'short-lived',
      expiresAt: expiresInSeconds(60),
    });

    const token = await service.getScopedToken(1, { permissions: {} });

    expect(token).toBe('short-lived');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('getScopedToken은 permissions/repositoryIds를 appAuth에 전달하고, 스코프별로 다른 캐시 키를 쓴다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'scoped-tok',
      expiresAt: expiresInSeconds(3600),
    });

    await service.getScopedToken(1, {
      permissions: { contents: 'read' },
      repositoryIds: [20, 10],
    });

    expect(appAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'installation',
        installationId: 1,
        permissions: { contents: 'read' },
        repositoryIds: [20, 10],
      }),
    );
    expect(redis.get).toHaveBeenCalledWith(
      'github:token:1:contents:read:10,20',
    );
  });

  it('permissions/repositoryIds가 빈 객체/배열이면 appAuth 호출에서 아예 생략한다 (전체 권한/전체 저장소 유지)', async () => {
    appAuthMock.mockResolvedValue({
      token: 'tok-empty-scope',
      expiresAt: expiresInSeconds(3600),
    });

    await service.getScopedToken(1, { permissions: {}, repositoryIds: [] });

    const [callArgs] = appAuthMock.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs).not.toHaveProperty('permissions');
    expect(callArgs).not.toHaveProperty('repositoryIds');
  });

  it('스코프가 다르면 전체 권한 토큰(getOctokit) 캐시를 오염시키지 않는다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'scoped-tok',
      expiresAt: expiresInSeconds(3600),
    });

    await service.getScopedToken(1, { permissions: { contents: 'read' } });
    await service.getOctokit(1);

    const keysUsed = redis.get.mock.calls.map((call) => call[0]);
    expect(new Set(keysUsed).size).toBe(2);
    expect(keysUsed).toContain('github:token:1');
  });
});
