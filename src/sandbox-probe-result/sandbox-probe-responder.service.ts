import { Inject, Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import type { Octokit } from '@octokit/rest';
import { isClientError } from '../common/http-error';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import type { SandboxProbeJobContext } from '../redis/sandbox-probe-job-context.type';
import {
  formatSandboxProbeComment,
  SANDBOX_PROBE_STICKY_MARKER,
} from './sandbox-probe-comment.formatter';
import type { SandboxProbeCompletedPayload } from './dto/sandbox-probe-completed.payload';

// pr.sandbox.probe.completed 를 받아 PR에 마커 주석 기반 sticky 코멘트를
// upsert한다. 메인 리뷰 코멘트(pulls.createReview 계열)는 전혀 건드리지 않는다 —
// 완전히 별도 트랙(issues.createComment/updateComment)이다.
@Injectable()
export class SandboxProbeResponderService {
  private readonly logger = new Logger(SandboxProbeResponderService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly sandboxProbeJobContextStore: SandboxProbeJobContextStore,
    private readonly dicoshot: DicoshotService,
  ) {}

  async handle(payload: SandboxProbeCompletedPayload): Promise<void> {
    const context = await this.sandboxProbeJobContextStore.get(
      payload.reviewJobId,
    );
    if (!context) {
      this.logger.error(
        `샌드박스 프로브 job context 없음(TTL 만료 또는 미기록), 스킵: ${payload.reviewJobId}`,
      );
      return;
    }

    const octokit = await this.installationTokenManager.getOctokit(
      context.installationId,
    );

    try {
      await this.upsertStickyComment(octokit, context, payload);
    } catch (err) {
      await this.notifyError(payload, context, err);

      if (isClientError(err)) {
        this.logger.error(
          `영구적으로 실패한 샌드박스 프로브 코멘트 게시(status=${err.status}), 재시도하지 않고 종료: ${payload.reviewJobId}`,
          err,
        );
        return;
      }

      throw err;
    }
  }

  private async upsertStickyComment(
    octokit: Octokit,
    context: SandboxProbeJobContext,
    payload: SandboxProbeCompletedPayload,
  ): Promise<void> {
    const body = formatSandboxProbeComment(payload);

    const existing = await this.findStickyComment(octokit, context);

    if (existing) {
      await withRetry(() =>
        octokit.rest.issues.updateComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: existing,
          body,
        }),
      );
      return;
    }

    await withRetry(() =>
      octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.prNumber,
        body,
      }),
    );
  }

  private async findStickyComment(
    octokit: Octokit,
    context: SandboxProbeJobContext,
  ): Promise<number | null> {
    const comments = await withRetry(() =>
      octokit.paginate(octokit.rest.issues.listComments, {
        owner: context.owner,
        repo: context.repo,
        issue_number: context.prNumber,
        per_page: 100,
      }),
    );

    const sticky = comments.find((comment) =>
      comment.body?.includes(SANDBOX_PROBE_STICKY_MARKER),
    );
    return sticky?.id ?? null;
  }

  private async notifyError(
    payload: SandboxProbeCompletedPayload,
    context: SandboxProbeJobContext,
    err: unknown,
  ): Promise<void> {
    await this.safeNotify({
      title: '샌드박스 프로브 코멘트 게시 실패',
      description: `${context.owner}/${context.repo}#${context.prNumber} (reviewJobId=${payload.reviewJobId}): ${err instanceof Error ? err.message : String(err)}`,
      color: 'danger',
    });
  }

  private async safeNotify(message: CustomMessageOptions): Promise<void> {
    try {
      await this.dicoshot.sendCustom(message);
    } catch (notifyErr) {
      this.logger.warn('Discord 알림 전송 실패', notifyErr);
    }
  }
}
