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
      'github:token:v2:1',
      expect.any(String),
      'EX',
      expect.any(Number),
    );
    const cachedValue = JSON.parse(redis.set.mock.calls[0][1]) as {
      token: string;
      expiresAt: string;
    };
    expect(cachedValue.token).toBe('tok-1');
    expect(typeof cachedValue.expiresAt).toBe('string');
    const ttl = redis.set.mock.calls[0][3];
    expect(ttl).toBeLessThan(3600);
    expect(ttl).toBeGreaterThan(0);
  });

  it('캐시 히트면 appAuth를 호출하지 않는다', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        token: 'cached-token',
        expiresAt: expiresInSeconds(3000),
      }),
    );

    await service.getOctokit(1);

    expect(appAuthMock).not.toHaveBeenCalled();
  });

  it('이전 형식(평문 토큰) 캐시는 만료 시각을 몰라 새로 발급해 덮어쓴다', async () => {
    redis.get.mockResolvedValue('ghs_legacyPlainToken');
    appAuthMock.mockResolvedValue({
      token: 'tok-new',
      expiresAt: expiresInSeconds(3600),
    });

    await service.getOctokit(1);

    expect(appAuthMock).toHaveBeenCalled();
    expect(JSON.parse(redis.set.mock.calls[0][1])).toMatchObject({
      token: 'tok-new',
    });
  });

  it('getScopedToken은 캐시 히트여도 만료 시각을 함께 돌려준다', async () => {
    const expiresAt = expiresInSeconds(3000);
    redis.get.mockResolvedValue(JSON.stringify({ token: 'scoped', expiresAt }));

    const result = await service.getScopedToken(1, {
      permissions: { contents: 'read' },
    });

    expect(result).toEqual({ token: 'scoped', expiresAt });
    expect(appAuthMock).not.toHaveBeenCalled();
  });

  it('만료가 안전 마진 이내로 임박하면 캐싱하지 않는다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'short-lived',
      expiresAt: expiresInSeconds(60),
    });

    const result = await service.getScopedToken(1, { permissions: {} });

    expect(result.token).toBe('short-lived');
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
      'github:token:v2:1:contents:read:10,20',
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

  it('스코프 토큰의 남은 수명이 30분 미만이면(auth-app 메모리 캐시) refresh로 새로 발급받는다', async () => {
    appAuthMock
      .mockResolvedValueOnce({
        token: 'stale',
        expiresAt: expiresInSeconds(600),
      })
      .mockResolvedValueOnce({
        token: 'fresh',
        expiresAt: expiresInSeconds(3600),
      });

    const result = await service.getScopedToken(1, {
      permissions: { contents: 'read' },
      repositoryIds: [42],
    });

    expect(result.token).toBe('fresh');
    expect(appAuthMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: true }),
    );
    // 캐시 TTL은 최소 남은 수명(30분)만큼 줄여 잡는다 → 캐시에서 꺼낸 토큰도 30분 이상 남음.
    const ttl = redis.set.mock.calls[0][3];
    expect(ttl).toBeLessThanOrEqual(3600 - 30 * 60);
    expect(ttl).toBeGreaterThan(0);
  });

  it('전체 권한 토큰(getOctokit)은 refresh 없이 기존대로 쓴다', async () => {
    appAuthMock.mockResolvedValue({
      token: 'tok',
      expiresAt: expiresInSeconds(600),
    });

    await service.getOctokit(1);

    expect(appAuthMock).toHaveBeenCalledTimes(1);
    expect(appAuthMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true }),
    );
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
    expect(keysUsed).toContain('github:token:v2:1');
  });
});
