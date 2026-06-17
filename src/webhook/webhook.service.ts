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

    const [owner, repo] = payload.repository.full_name.split('/');

    this.prDataCollectorService
      .collect({
        installationId: payload.installation.id,
        owner,
        repo,
        prNumber: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
        repositoryId: payload.repository.id,
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
      ALLOWED_ACTIONS.has(payload.action) &&
      !payload.pull_request.draft &&
      payload.sender.type === 'User'
    );
  }
}
