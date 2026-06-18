import type { Kafka } from 'kafkajs';
import { ReviewResultConsumerService } from './review-result-consumer.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { JobStateStore } from '../redis/job-state.store';
import type { ReviewCompletedPayload } from '../review-orchestrator/dto/review-completed.payload';
import type { ReviewFailedPayload } from '../review-orchestrator/dto/review-failed.payload';

interface ConsumerWithHandleMessage {
  handleMessage(topic: string, message: { value: Buffer }): Promise<void>;
}

describe('ReviewResultConsumerService', () => {
  const completedTopic = 'pr.review.completed';
  const failedTopic = 'pr.review.failed';

  let orchestrator: { handle: jest.Mock };
  let jobStateStore: { get: jest.Mock; set: jest.Mock };
  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let service: ReviewResultConsumerService;

  beforeEach(() => {
    process.env.KAFKA_REVIEW_COMPLETED_TOPIC = completedTopic;
    process.env.KAFKA_REVIEW_FAILED_TOPIC = failedTopic;

    orchestrator = { handle: jest.fn() };
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

    service = new ReviewResultConsumerService(
      fakeKafka as unknown as Kafka,
      orchestrator,
      jobStateStore as unknown as JobStateStore,
      idempotencyStore as unknown as IdempotencyStore,
    );
  });

  it('completed 토픽 처리 시 jobState를 completed로 갱신하고 idempotency를 기록한다', async () => {
    const payload: ReviewCompletedPayload = {
      reviewJobId: 'repo_1_sha',
      repositoryId: 1,
      prNumber: 1,
      headSha: 'sha',
      owner: 'owner',
      repo: 'repo',
      installationId: 123,
      summary: 'ok',
      reviews: [],
    };
    const message = { value: Buffer.from(JSON.stringify(payload)) };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      completedTopic,
      message,
    );

    expect(orchestrator.handle).toHaveBeenCalledWith(payload);
    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      'completed',
    );
    expect(idempotencyStore.markProcessed).toHaveBeenCalledWith(
      payload.reviewJobId,
    );
  });

  it('failed 토픽 처리 시 jobState를 failed로 갱신하고 idempotency는 기록하지 않는다', async () => {
    const payload: ReviewFailedPayload = {
      reviewJobId: 'repo_1_sha',
      repositoryId: 1,
      prNumber: 1,
      headSha: 'sha',
      owner: 'owner',
      repo: 'repo',
      installationId: 123,
      reason: 'timeout',
    };
    const message = { value: Buffer.from(JSON.stringify(payload)) };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      failedTopic,
      message,
    );

    expect(orchestrator.handle).toHaveBeenCalledWith(payload);
    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      'failed',
    );
    expect(idempotencyStore.markProcessed).not.toHaveBeenCalled();
  });
});
