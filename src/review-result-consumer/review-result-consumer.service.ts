import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Kafka, KafkaMessage } from 'kafkajs';
import { BaseKafkaConsumer } from '../kafka/base-kafka.consumer';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { PoisonMessageError } from '../kafka/poison-message.error';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
import { REVIEW_ORCHESTRATOR } from '../review-orchestrator/review-orchestrator.interface';
import type { ReviewOrchestrator } from '../review-orchestrator/review-orchestrator.interface';
import type { ReviewCompletedPayload } from '../review-orchestrator/dto/review-completed.payload';
import type { ReviewFailedPayload } from '../review-orchestrator/dto/review-failed.payload';

const GROUP_ID = 'github-app-review-result';

@Injectable()
export class ReviewResultConsumerService
  extends BaseKafkaConsumer
  implements OnModuleInit
{
  private readonly completedTopic = process.env.KAFKA_REVIEW_COMPLETED_TOPIC!;
  private readonly failedTopic = process.env.KAFKA_REVIEW_FAILED_TOPIC!;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(REVIEW_ORCHESTRATOR)
    private readonly orchestrator: ReviewOrchestrator,
    private readonly jobStateStore: JobStateStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {
    super(kafka, GROUP_ID, [
      process.env.KAFKA_REVIEW_COMPLETED_TOPIC!,
      process.env.KAFKA_REVIEW_FAILED_TOPIC!,
    ]);
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  protected async handleMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<void> {
    if (!message.value) {
      this.logger.warn(`빈 메시지 수신, 스킵: topic=${topic}`);
      return;
    }

    if (topic === this.completedTopic) {
      const payload = this.parse<ReviewCompletedPayload>(message);
      if (!payload?.reviewJobId) {
        throw new PoisonMessageError(
          'Invalid completed payload: reviewJobId is missing',
        );
      }
      const outcome = await this.orchestrator.handle(payload);
      // 오래되어 게시하지 않은 결과는 "처리 완료"로 표시하지 않는다 — 표시하면 같은 커밋으로
      // PR이 다시 열렸을 때(reopened) 멱등성 키 때문에 리뷰가 영영 안 돈다.
      if (outcome === 'stale') return;
      await Promise.all([
        this.jobStateStore.set(payload.reviewJobId, 'completed'),
        this.idempotencyStore.markProcessed(payload.reviewJobId),
      ]);
      return;
    }

    if (topic === this.failedTopic) {
      const payload = this.parse<ReviewFailedPayload>(message);
      if (!payload?.reviewJobId) {
        throw new PoisonMessageError(
          'Invalid failed payload: reviewJobId is missing',
        );
      }
      await this.orchestrator.handle(payload);
      await this.jobStateStore.set(payload.reviewJobId, 'failed');
      return;
    }

    this.logger.warn(`알 수 없는 토픽 메시지 수신, 스킵: topic=${topic}`);
  }

  private parse<T>(message: KafkaMessage): T {
    try {
      return JSON.parse(message.value!.toString()) as T;
    } catch (err) {
      throw new PoisonMessageError(
        `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
