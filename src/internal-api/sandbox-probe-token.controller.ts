import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Logger,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { isClientError } from '../common/http-error';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type {
  InstallationTokenManager,
  ScopedToken,
} from '../installation-token/installation-token-manager.interface';
import { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import { InternalSecretGuard } from './internal-secret.guard';

interface SandboxProbeTokenRequest {
  installationId: number;
  repositoryId: number;
}

// MAX_SAFE_INTEGER를 넘는 값은 반올림되어 엉뚱한 ID로 GitHub에 전달되므로 막는다.
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// 레이트 리밋(429, 또는 403 + retry-after/x-ratelimit-remaining: 0)은 일시적이라 워커가
// 재시도해야 한다 — 422로 바꾸면 워커가 영구 실패로 보고 포기한다.
function isRateLimited(err: { status: number }): boolean {
  if (err.status === 429) return true;
  if (err.status !== 403) return false;
  const headers = (
    err as { response?: { headers?: Record<string, string | undefined> } }
  ).response?.headers;
  return (
    headers?.['retry-after'] !== undefined ||
    headers?.['x-ratelimit-remaining'] === '0'
  );
}

// installation 없음(404), 저장소가 installation에 속하지 않거나 요청 권한이 부여 범위를
// 넘음(422/403)처럼 요청 대상 자체가 거부된 경우만 422로 돌린다. 401(App JWT/시계 문제 등
// github-app 쪽 설정 문제)이나 레이트 리밋은 호출자 잘못이 아니므로 500으로 둔다.
function isTargetRejected(err: unknown): err is { status: number } {
  return (
    isClientError(err) &&
    [403, 404, 422].includes(err.status) &&
    !isRateLimited(err)
  );
}

// 샌드박스 프로브 워커(Dovi-ai-server, 전용 VM)가 PR 코드를 clone하기 직전에 호출한다.
// 워커 VM에는 GitHub App private key를 두지 않으므로 토큰은 github-app이 발급한다.
// 대상 저장소 하나의 contents:read로만 좁힌다 — 워커가 신뢰할 수 없는 PR 코드를
// 실행하는 곳이라, 토큰이 새어도 영향 범위가 그 저장소 읽기로 제한되게 한다.
@Controller('internal/sandbox-probe')
@UseGuards(InternalSecretGuard)
export class SandboxProbeTokenController {
  private readonly logger = new Logger(SandboxProbeTokenController.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly sandboxProbeJobContextStore: SandboxProbeJobContextStore,
  ) {}

  @Post('token')
  @HttpCode(200)
  async issueToken(@Body() body: unknown): Promise<ScopedToken> {
    const { installationId, repositoryId } = this.validate(body);

    // 시크릿만 맞으면 아무 저장소 토큰이나 받을 수 있게 두면, 신뢰할 수 없는 PR 코드를
    // 실행하는 워커 VM에서 시크릿이 새는 순간 App이 설치된 모든 저장소 코드가 노출된다.
    // github-app이 실제로 샌드박스 잡을 발행한 저장소에만 발급한다.
    if (
      !(await this.sandboxProbeJobContextStore.isActiveRepository(
        installationId,
        repositoryId,
      ))
    ) {
      this.logger.warn(
        `발행된 샌드박스 잡이 없는 저장소의 토큰 요청 거부: installation=${installationId} repository=${repositoryId}`,
      );
      throw new ForbiddenException(
        'No dispatched sandbox probe job for this installation/repository',
      );
    }

    try {
      const result = await this.installationTokenManager.getScopedToken(
        installationId,
        { permissions: { contents: 'read' }, repositoryIds: [repositoryId] },
      );
      // 토큰 값은 절대 로그에 남기지 않는다.
      this.logger.log(
        `샌드박스 프로브 토큰 발급: installation=${installationId} repository=${repositoryId} expiresAt=${result.expiresAt}`,
      );
      return result;
    } catch (err) {
      if (isTargetRejected(err)) {
        this.logger.warn(
          `샌드박스 프로브 토큰 발급 거부(GitHub status=${err.status}): installation=${installationId} repository=${repositoryId}`,
        );
        throw new UnprocessableEntityException(
          'Cannot issue a token for this installation/repository',
        );
      }
      throw err;
    }
  }

  private validate(body: unknown): SandboxProbeTokenRequest {
    const { installationId, repositoryId } = (body ?? {}) as Partial<
      Record<keyof SandboxProbeTokenRequest, unknown>
    >;
    if (
      !isPositiveInteger(installationId) ||
      !isPositiveInteger(repositoryId)
    ) {
      throw new BadRequestException(
        'installationId and repositoryId must be positive integers',
      );
    }
    return { installationId, repositoryId };
  }
}
