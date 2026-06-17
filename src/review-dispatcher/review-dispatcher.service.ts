import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';

@Injectable()
export class ReviewDispatcherService {
  private readonly logger = new Logger(ReviewDispatcherService.name);

  constructor(
    private readonly idempotencyStore: IdempotencyStore,
    private readonly jobStateStore: JobStateStore,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  async dispatch(payload: ReviewRequestPayload): Promise<void> {
    const { reviewJobId } = payload;

    const [alreadyProcessed, state] = await Promise.all([
      this.idempotencyStore.exists(reviewJobId),
      this.jobStateStore.get(reviewJobId),
    ]);

    if (alreadyProcessed) {
      this.logger.log(`이미 처리된 reviewJobId, 스킵: ${reviewJobId}`);
      return;
    }

    if (state === 'completed' || state === 'processing') {
      this.logger.log(`현재 상태(${state})로 스킵: ${reviewJobId}`);
      return;
    }

    await this.jobStateStore.set(reviewJobId, 'requested');

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_REVIEW_REQUEST_TOPIC!,
        payload,
        reviewJobId,
      );
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${reviewJobId}`, err);
      throw err;
    }
  }
}
