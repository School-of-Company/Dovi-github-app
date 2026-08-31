import { ReviewDispatcherService } from './review-dispatcher.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { JobStateStore } from '../redis/job-state.store';
import type { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';
import type { ReviewJobContext } from '../redis/review-job-context.type';

describe('ReviewDispatcherService', () => {
  const payload: ReviewRequestPayload = {
    reviewJobId: '1:1:sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    baseSha: 'base-sha',
    contextFiles: [],
    changedFiles: [],
  };

  const context: ReviewJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    installationId: 123,
  };

  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let jobStateStore: { get: jest.Mock; set: jest.Mock };
  let reviewJobContextStore: { set: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: ReviewDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REVIEW_REQUEST_TOPIC = 'pr.review.requested';

    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    jobStateStore = { get: jest.fn(), set: jest.fn() };
    reviewJobContextStore = { set: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new ReviewDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      jobStateStore as unknown as JobStateStore,
      reviewJobContextStore as unknown as ReviewJobContextStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('idempotency에 이미 존재하면 발행하지 않고 스킵한다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).not.toHaveBeenCalled();
    expect(reviewJobContextStore.set).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it.each(['completed', 'processing'] as const)(
    'jobState가 %s면 발행하지 않고 스킵한다',
    async (state) => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(state);

      await service.dispatch(payload, context);

      expect(jobStateStore.set).not.toHaveBeenCalled();
      expect(reviewJobContextStore.set).not.toHaveBeenCalled();
      expect(kafkaProducer.send).not.toHaveBeenCalled();
    },
  );

  it('중복이 아니면 requested 상태와 job context를 저장한 후 발행한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      'requested',
    );
    expect(reviewJobContextStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      context,
    );
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.review.requested',
      payload,
      payload.reviewJobId,
    );
  });

  it('Kafka 발행이 실패하면 에러를 throw한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload, context)).rejects.toThrow(
      'kafka down',
    );
  });
});
