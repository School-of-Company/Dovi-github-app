import { Inject, Injectable } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { Redis } from 'ioredis';
import { createTimedFetch } from '../common/timed-fetch';
import { withRetry } from '../common/retry';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type {
  InstallationTokenManager,
  ScopedToken,
  TokenScope,
} from './installation-token-manager.interface';

// installation token은 GitHub에서 발급 후 1시간 뒤 만료된다. 실제 만료시각보다
// 일찍 캐시를 비워야 하므로 안전 마진을 둔다.
const TTL_SAFETY_MARGIN_SECONDS = 5 * 60;
// 스코프 토큰(샌드박스 워커 clone용)은 받은 뒤 clone·fetch에 시간이 걸리므로 최소 이만큼
// 남은 토큰만 내준다. 캐시도 이 시점에 비운다.
const SCOPED_TOKEN_MIN_REMAINING_SECONDS = 30 * 60;

const TOKEN_CACHE_VERSION = 'v2';

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
    const { token } = await this.fetchToken(installationId);
    return new Octokit({ auth: token, request: { fetch: createTimedFetch() } });
  }

  async getScopedToken(
    installationId: number,
    scope: TokenScope,
  ): Promise<ScopedToken> {
    return this.fetchToken(installationId, scope);
  }

  private async fetchToken(
    installationId: number,
    scope?: TokenScope,
  ): Promise<ScopedToken> {
    const cacheKey = this.tokenKey(installationId, scope);
    const cached = this.parseCached(await this.redis.get(cacheKey));
    if (cached) return cached;

    const minRemaining = scope
      ? SCOPED_TOKEN_MIN_REMAINING_SECONDS
      : TTL_SAFETY_MARGIN_SECONDS;
    let issued = await this.issue(installationId, scope, false);
    // @octokit/auth-app은 자체 메모리 캐시(최대 59분)에서 이미 발급한 토큰을 그대로
    // 돌려줄 수 있어, 남은 수명이 모자라면 캐시를 건너뛰고 새로 발급받는다.
    if (scope && this.remainingSeconds(issued.expiresAt) < minRemaining) {
      issued = await this.issue(installationId, scope, true);
    }
    const { token, expiresAt } = issued;

    const ttlSeconds = this.remainingSeconds(expiresAt) - minRemaining;
    if (ttlSeconds > 0) {
      await this.redis.set(
        cacheKey,
        JSON.stringify({ token, expiresAt }),
        'EX',
        ttlSeconds,
      );
    }

    return { token, expiresAt };
  }

  private remainingSeconds(expiresAt: string): number {
    return Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  }

  private async issue(
    installationId: number,
    scope: TokenScope | undefined,
    refresh: boolean,
  ): Promise<ScopedToken> {
    const { token, expiresAt } = await withRetry(() =>
      this.appAuth({
        type: 'installation',
        installationId,
        ...(refresh ? { refresh: true } : {}),
        // 빈 객체/배열도 truthy이므로 length까지 확인한다 — GitHub의 installation
        // access token 발급 API는 permissions/repositoryIds 키 자체를 생략해야
        // "설치 시점의 전체 권한/전체 저장소"로 대체되고, 빈 값을 명시적으로
        // 보내면 "권한/저장소 없음"으로 해석될 수 있다.
        ...(scope?.permissions && Object.keys(scope.permissions).length > 0
          ? { permissions: scope.permissions }
          : {}),
        ...(scope?.repositoryIds && scope.repositoryIds.length > 0
          ? { repositoryIds: scope.repositoryIds }
          : {}),
      }),
    );
    return { token, expiresAt };
  }

  // 형식이 맞지 않는 값(손상되었거나 예상치 못한 평문 등)은 만료 시각을 알 수 없으므로
  // 캐시 미스로 보고 새로 발급해 덮어쓴다.
  private parseCached(raw: string | null): ScopedToken | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<ScopedToken>;
      if (
        typeof value.token === 'string' &&
        typeof value.expiresAt === 'string'
      ) {
        return { token: value.token, expiresAt: value.expiresAt };
      }
    } catch {
      // JSON이 아님(평문 토큰 등) — 아래에서 null 반환
    }
    return null;
  }

  // 스코프가 다르면 반드시 다른 캐시 키를 써야 한다 — 그러지 않으면 contents:read로
  // 좁힌 토큰이 캐시를 선점해 이후 전체 권한이 필요한 호출(예: pulls.createReview)이
  // 403으로 실패할 수 있다.
  //
  // v2: 캐시 값이 평문 토큰 → JSON({token, expiresAt})으로 바뀌었다. 키를 분리하지 않으면
  // 이전 이미지로 롤백했을 때 구버전이 JSON 문자열을 그대로 토큰으로 써서 모든 GitHub
  // 호출이 401로 실패한다(캐시 TTL 동안).
  private tokenKey(installationId: number, scope?: TokenScope): string {
    const prefix = `github:token:${TOKEN_CACHE_VERSION}:${installationId}`;
    if (!scope) return prefix;

    const permissionsPart = Object.keys(scope.permissions)
      .sort()
      .map((key) => `${key}:${scope.permissions[key]}`)
      .join(',');
    const repositoryIdsPart = [...(scope.repositoryIds ?? [])]
      .sort((a, b) => a - b)
      .join(',');

    return `${prefix}:${permissionsPart}:${repositoryIdsPart}`;
  }
}
