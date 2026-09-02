import { Inject, Injectable } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { Redis } from 'ioredis';
import { createTimedFetch } from '../common/timed-fetch';
import { withRetry } from '../common/retry';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { InstallationTokenManager } from './installation-token-manager.interface';

const TOKEN_TTL_SECONDS = 50 * 60;

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
    const cacheKey = this.tokenKey(installationId);
    const cachedToken = await this.redis.get(cacheKey);
    if (cachedToken) {
      return new Octokit({
        auth: cachedToken,
        request: { fetch: createTimedFetch() },
      });
    }

    const { token } = await withRetry(() =>
      this.appAuth({ type: 'installation', installationId }),
    );
    await this.redis.set(cacheKey, token, 'EX', TOKEN_TTL_SECONDS);

    return new Octokit({ auth: token, request: { fetch: createTimedFetch() } });
  }

  private tokenKey(installationId: number): string {
    return `github:token:${installationId}`;
  }
}
