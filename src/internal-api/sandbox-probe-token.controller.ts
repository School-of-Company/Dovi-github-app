import {
  BadRequestException,
  Body,
  Controller,
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
import { InternalSecretGuard } from './internal-secret.guard';

interface SandboxProbeTokenRequest {
  installationId: number;
  repositoryId: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
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
  ) {}

  @Post('token')
  @HttpCode(200)
  async issueToken(@Body() body: unknown): Promise<ScopedToken> {
    const { installationId, repositoryId } = this.validate(body);

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
      // installation이 없거나, 저장소가 그 installation에 속하지 않으면 GitHub가 4xx를 준다.
      if (isClientError(err)) {
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
