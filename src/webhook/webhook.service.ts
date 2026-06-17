import { Injectable, Logger } from '@nestjs/common';
import { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';

const ALLOWED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prDataCollectorService: PrDataCollectorService,
  ) {}

  handle(event: string, payload: GithubWebhookPayload): void {
    if (!this.shouldProcess(event, payload)) return;

    const parts = payload.repository.full_name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      this.logger.error(
        `올바르지 않은 repository full_name: ${payload.repository.full_name}`,
      );
      return;
    }
    const [owner, repo] = parts;

    this.prDataCollectorService
      .collect({
        installationId: payload.installation.id,
        owner,
        repo,
        prNumber: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
        repositoryId: payload.repository.id,
      })
      .then((result) => {
        if (result === null) {
          this.logger.warn(
            `PR #${payload.pull_request.number} 수집 스킵 (diff 크기 초과)`,
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.error(
          `PR 데이터 수집 실패 (PR #${payload.pull_request.number})`,
          err,
        );
      });
  }

  private shouldProcess(event: string, payload: GithubWebhookPayload): boolean {
    return (
      event === 'pull_request' &&
      !!payload.installation &&
      ALLOWED_ACTIONS.has(payload.action) &&
      !payload.pull_request.draft &&
      payload.sender.type === 'User'
    );
  }
}
