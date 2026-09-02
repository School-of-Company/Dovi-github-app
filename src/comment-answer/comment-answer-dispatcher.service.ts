import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
import { CommentAnswerContextStore } from '../redis/comment-answer-context.store';
import type { CommentAnswerContext } from '../redis/comment-answer-context.type';
import type { CommentAnswerRequestPayload } from './dto/comment-answer-request.payload';

@Injectable()
export class CommentAnswerDispatcherService {
  private readonly logger = new Logger(CommentAnswerDispatcherService.name);

  constructor(
    private readonly idempotencyStore: IdempotencyStore,
    private readonly jobStateStore: JobStateStore,
    private readonly commentAnswerContextStore: CommentAnswerContextStore,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  async dispatch(
    payload: CommentAnswerRequestPayload,
    context: CommentAnswerContext,
  ): Promise<void> {
    const { commentJobId } = payload;

    const [alreadyProcessed, state] = await Promise.all([
      this.idempotencyStore.exists(commentJobId),
      this.jobStateStore.get(commentJobId),
    ]);

    if (alreadyProcessed) {
      this.logger.log(`이미 처리된 commentJobId, 스킵: ${commentJobId}`);
      return;
    }

    if (state === 'completed' || state === 'processing') {
      this.logger.log(`현재 상태(${state})로 스킵: ${commentJobId}`);
      return;
    }

    await Promise.all([
      this.jobStateStore.set(commentJobId, 'requested'),
      this.commentAnswerContextStore.set(commentJobId, context),
    ]);

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_COMMENT_ANSWER_REQUEST_TOPIC!,
        payload,
        commentJobId,
      );
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${commentJobId}`, err);
      throw err;
    }
  }
}
