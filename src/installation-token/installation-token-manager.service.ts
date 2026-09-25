import { Inject, Injectable } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { Redis } from 'ioredis';
import { createTimedFetch } from '../common/timed-fetch';
import { withRetry } from '../common/retry';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type {
  InstallationTokenManager,
  TokenScope,
} from './installation-token-manager.interface';

// installation token은 GitHub에서 발급 후 1시간 뒤 만료된다. 실제 만료시각보다
// 일찍 캐시를 비워야 하므로 안전 마진을 둔다.
const TTL_SAFETY_MARGIN_SECONDS = 5 * 60;

@Injectable()
export class InstallationTokenManagerService implements InstallationTokenManager {
  private readonly appAuth: ReturnType<typeof createAppAuth>;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;
    if (!appId || !privateKey) {
      throw new Error(
        'GITHUB_APP_ID or GITHUB_PRIVATE_KEY environment variable is not defined',
      );
    }
    // 인증 요청도 짧은 타임아웃 fetch로 나가야 withRetry가 재시도할 기회를
    // 충분히 갖는다 (기본 fetch의 연결 타임아웃은 약 10초로 너무 길다).
    const authRequest = new Octokit({
      request: { fetch: createTimedFetch() },
    }).request;
    this.appAuth = createAppAuth({
      appId,
      privateKey: privateKey.replace(/\\n/g, '\n'),
      request: authRequest,
    });
  }

  async getOctokit(installationId: number): Promise<Octokit> {
    const token = await this.fetchToken(installationId);
    return new Octokit({ auth: token, request: { fetch: createTimedFetch() } });
  }

  async getScopedToken(
    installationId: number,
    scope: TokenScope,
  ): Promise<string> {
    return this.fetchToken(installationId, scope);
  }

  private async fetchToken(
    installationId: number,
    scope?: TokenScope,
  ): Promise<string> {
    const cacheKey = this.tokenKey(installationId, scope);
    const cachedToken = await this.redis.get(cacheKey);
    if (cachedToken) return cachedToken;

    const { token, expiresAt } = await withRetry(() =>
      this.appAuth({
        type: 'installation',
        installationId,
        ...(scope?.permissions ? { permissions: scope.permissions } : {}),
        ...(scope?.repositoryIds ? { repositoryIds: scope.repositoryIds } : {}),
      }),
    );

    const ttlSeconds =
      Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) -
      TTL_SAFETY_MARGIN_SECONDS;
    if (ttlSeconds > 0) {
      await this.redis.set(cacheKey, token, 'EX', ttlSeconds);
    }

    return token;
  }

  // 스코프가 다르면 반드시 다른 캐시 키를 써야 한다 — 그러지 않으면 contents:read로
  // 좁힌 토큰이 캐시를 선점해 이후 전체 권한이 필요한 호출(예: pulls.createReview)이
  // 403으로 실패할 수 있다.
  private tokenKey(installationId: number, scope?: TokenScope): string {
    if (!scope) return `github:token:${installationId}`;

    const permissionsPart = Object.keys(scope.permissions)
      .sort()
      .map((key) => `${key}:${scope.permissions[key]}`)
      .join(',');
    const repositoryIdsPart = [...(scope.repositoryIds ?? [])]
      .sort((a, b) => a - b)
      .join(',');

    return `github:token:${installationId}:${permissionsPart}:${repositoryIdsPart}`;
  }
}
