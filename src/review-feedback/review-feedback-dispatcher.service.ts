import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import type { ReviewFeedbackPayload } from './dto/review-feedback.payload';

@Injectable()
export class ReviewFeedbackDispatcherService {
  private readonly logger = new Logger(ReviewFeedbackDispatcherService.name);

  constructor(
    private readonly idempotencyStore: IdempotencyStore,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // commentId는 이 반영/미반영 신호를 유발한 답글 코멘트의 id — 같은 답글이
  // 웹훅 재전송으로 두 번 오더라도 중복 발행하지 않기 위한 idempotency 키.
  async dispatch(
    payload: ReviewFeedbackPayload,
    commentId: number,
  ): Promise<void> {
    const jobId = `feedback:${commentId}`;

    if (await this.idempotencyStore.exists(jobId)) {
      this.logger.log(`이미 처리된 반영 여부 코멘트, 스킵: ${jobId}`);
      return;
    }
    await this.idempotencyStore.markProcessed(jobId);

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_REVIEW_FEEDBACK_TOPIC!,
        payload,
        payload.reviewJobId,
      );
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${jobId}`, err);
      throw err;
    }
  }
}
