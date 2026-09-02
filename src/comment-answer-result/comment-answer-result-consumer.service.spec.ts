import type { Kafka } from 'kafkajs';
import { CommentAnswerResultConsumerService } from './comment-answer-result-consumer.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { JobStateStore } from '../redis/job-state.store';
import type { CommentAnswerCompletedPayload } from './dto/comment-answer-completed.payload';
import type { CommentAnswerFailedPayload } from './dto/comment-answer-failed.payload';

interface ConsumerWithHandleMessage {
  handleMessage(topic: string, message: { value: Buffer }): Promise<void>;
}

describe('CommentAnswerResultConsumerService', () => {
  const completedTopic = 'pr.comment.answer.completed';
  const failedTopic = 'pr.comment.answer.failed';

  let responder: { handle: jest.Mock };
  let jobStateStore: { get: jest.Mock; set: jest.Mock };
  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let service: CommentAnswerResultConsumerService;

  beforeEach(() => {
    process.env.KAFKA_COMMENT_ANSWER_COMPLETED_TOPIC = completedTopic;
    process.env.KAFKA_COMMENT_ANSWER_FAILED_TOPIC = failedTopic;

    responder = { handle: jest.fn() };
    jobStateStore = { get: jest.fn(), set: jest.fn() };
    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };

    const fakeConsumer = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      on: jest.fn(),
      run: jest.fn(),
      disconnect: jest.fn(),
      commitOffsets: jest.fn(),
      events: { CRASH: 'consumer.crash' },
    };
    const fakeKafka = { consumer: jest.fn().mockReturnValue(fakeConsumer) };

    service = new CommentAnswerResultConsumerService(
      fakeKafka as unknown as Kafka,
      responder,
      jobStateStore as unknown as JobStateStore,
      idempotencyStore as unknown as IdempotencyStore,
    );
  });

  it('completed 토픽 처리 시 jobState를 completed로 갱신하고 idempotency를 기록한다', async () => {
    const payload: CommentAnswerCompletedPayload = {
      commentJobId: 'qa:1:1:999',
      answer: '현재 방식이 맞습니다.',
    };
    const message = { value: Buffer.from(JSON.stringify(payload)) };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      completedTopic,
      message,
    );

    expect(responder.handle).toHaveBeenCalledWith(payload);
    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.commentJobId,
      'completed',
    );
    expect(idempotencyStore.markProcessed).toHaveBeenCalledWith(
      payload.commentJobId,
    );
  });

  it('failed 토픽 처리 시 jobState를 failed로 갱신하고 idempotency는 기록하지 않는다', async () => {
    const payload: CommentAnswerFailedPayload = {
      commentJobId: 'qa:1:1:999',
      reason: 'timeout',
    };
    const message = { value: Buffer.from(JSON.stringify(payload)) };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      failedTopic,
      message,
    );

    expect(responder.handle).toHaveBeenCalledWith(payload);
    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.commentJobId,
      'failed',
    );
    expect(idempotencyStore.markProcessed).not.toHaveBeenCalled();
  });
});
