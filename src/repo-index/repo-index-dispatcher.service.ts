import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import type { RepoIndexRequestPayload } from './dto/repo-index-request.payload';

@Injectable()
export class RepoIndexDispatcherService {
  private readonly logger = new Logger(RepoIndexDispatcherService.name);

  constructor(
    private readonly idempotencyStore: IdempotencyStore,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  async dispatch(payload: RepoIndexRequestPayload): Promise<void> {
    const jobId = this.jobId(payload);

    if (await this.idempotencyStore.exists(jobId)) {
      this.logger.log(`이미 처리된 repo index job, 스킵: ${jobId}`);
      return;
    }
    await this.idempotencyStore.markProcessed(jobId);

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_REPO_INDEX_REQUEST_TOPIC!,
        payload,
        jobId,
      );
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${jobId}`, err);
      throw err;
    }
  }

  private jobId(payload: RepoIndexRequestPayload): string {
    return `${payload.repositoryId}:${payload.branch}:${payload.headSha}`;
  }
}
