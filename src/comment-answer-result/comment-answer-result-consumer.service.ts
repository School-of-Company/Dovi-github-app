import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Kafka, KafkaMessage } from 'kafkajs';
import { BaseKafkaConsumer } from '../kafka/base-kafka.consumer';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
import { COMMENT_ANSWER_RESPONDER } from './comment-answer-responder.interface';
import type { CommentAnswerResponder } from './comment-answer-responder.interface';
import type { CommentAnswerCompletedPayload } from './dto/comment-answer-completed.payload';
import type { CommentAnswerFailedPayload } from './dto/comment-answer-failed.payload';

const GROUP_ID = 'github-app-comment-answer-result';

@Injectable()
export class CommentAnswerResultConsumerService
  extends BaseKafkaConsumer
  implements OnModuleInit
{
  private readonly completedTopic =
    process.env.KAFKA_COMMENT_ANSWER_COMPLETED_TOPIC!;
  private readonly failedTopic = process.env.KAFKA_COMMENT_ANSWER_FAILED_TOPIC!;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(COMMENT_ANSWER_RESPONDER)
    private readonly responder: CommentAnswerResponder,
    private readonly jobStateStore: JobStateStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {
    super(kafka, GROUP_ID, [
      process.env.KAFKA_COMMENT_ANSWER_COMPLETED_TOPIC!,
      process.env.KAFKA_COMMENT_ANSWER_FAILED_TOPIC!,
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
      const payload = JSON.parse(
        message.value.toString(),
      ) as CommentAnswerCompletedPayload;
      if (!payload?.commentJobId) {
        throw new Error('Invalid completed payload: commentJobId is missing');
      }
      await this.responder.handle(payload);
      await Promise.all([
        this.jobStateStore.set(payload.commentJobId, 'completed'),
        this.idempotencyStore.markProcessed(payload.commentJobId),
      ]);
      return;
    }

    if (topic === this.failedTopic) {
      const payload = JSON.parse(
        message.value.toString(),
      ) as CommentAnswerFailedPayload;
      if (!payload?.commentJobId) {
        throw new Error('Invalid failed payload: commentJobId is missing');
      }
      await this.responder.handle(payload);
      await this.jobStateStore.set(payload.commentJobId, 'failed');
      return;
    }

    this.logger.warn(`알 수 없는 토픽 메시지 수신, 스킵: topic=${topic}`);
  }
}
