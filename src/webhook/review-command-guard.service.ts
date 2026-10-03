import { Inject, Injectable, Logger } from '@nestjs/common';
import { isClientError } from '../common/http-error';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { ReviewCommandCooldownStore } from '../redis/review-command-cooldown.store';

export type CommandDecision = 'allowed' | 'forbidden' | 'cooldown' | 'error';

export interface CommandRequest {
  installationId: number;
  owner: string;
  repo: string;
  repositoryId: number;
  prNumber: number;
  // 명령(코멘트)을 남긴 사용자
  commenter: string;
  // PR 작성자. 웹훅 payload에 없으면 undefined(권한 조회로만 판단)
  prAuthor?: string;
}

const DEFAULT_COOLDOWN_SECONDS = 60;
// getCollaboratorPermissionLevel의 permission은 admin/write/read/none 중 하나이고,
// maintain은 write로 접혀 온다. 쓰기 이상이어야 AI 리뷰를 일으킬 수 있다.
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

// AI 리뷰를 직접 일으키는 명령(/dovi review, 봇 멘션)을 실행해도 되는지 판단한다.
// 허용: PR 작성자, 또는 레포 Write 이상 권한자. 그 외 사용자의 코멘트로 비싼 AI 리뷰가
// 돌면(공개 레포, 외부 협업자) 직렬로 처리되는 AI 서버가 막히고 비용이 새기 때문이다.
// 판단 실패는 거부한다(fail-closed). 검사는 권한 → 쿨다운 순이라 권한 없는 사용자가
// 쿨다운을 소모해 정상 사용자를 막지 못한다.
@Injectable()
export class ReviewCommandGuardService {
  private readonly logger = new Logger(ReviewCommandGuardService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly cooldownStore: ReviewCommandCooldownStore,
  ) {}

  async check(request: CommandRequest): Promise<CommandDecision> {
    try {
      if (!(await this.hasPermission(request))) return 'forbidden';

      const ttl = this.cooldownSeconds();
      if (ttl > 0) {
        const acquired = await this.cooldownStore.acquire(
          request.repositoryId,
          request.prNumber,
          ttl,
        );
        if (!acquired) return 'cooldown';
      }
      return 'allowed';
    } catch (err) {
      this.logger.error(
        `명령 권한/쿨다운 판단 실패, 거부: ${request.owner}/${request.repo}#${request.prNumber} (${request.commenter})`,
        err,
      );
      return 'error';
    }
  }

  private async hasPermission(request: CommandRequest): Promise<boolean> {
    // 대소문자만 다른 로그인은 같은 사용자다.
    if (
      request.prAuthor !== undefined &&
      request.prAuthor.toLowerCase() === request.commenter.toLowerCase()
    ) {
      return true;
    }

    const octokit = await this.installationTokenManager.getOctokit(
      request.installationId,
    );
    try {
      const { data } = await withRetry(() =>
        octokit.rest.repos.getCollaboratorPermissionLevel({
          owner: request.owner,
          repo: request.repo,
          username: request.commenter,
        }),
      );
      return (
        WRITE_PERMISSIONS.has(data.permission) ||
        WRITE_PERMISSIONS.has(data.role_name ?? '')
      );
    } catch (err) {
      // 협업자가 아니거나(404) 조회 권한이 없는 사용자는 권한 없음으로 본다.
      // 5xx·네트워크 오류는 withRetry 후에도 던져져 check()에서 거부된다.
      if (isClientError(err)) return false;
      throw err;
    }
  }

  // 0이면 쿨다운을 끈다. 잘못된 값은 기본값을 쓴다.
  private cooldownSeconds(): number {
    const raw = process.env.REVIEW_COMMAND_COOLDOWN_SECONDS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_COOLDOWN_SECONDS;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_COOLDOWN_SECONDS;
  }
}
