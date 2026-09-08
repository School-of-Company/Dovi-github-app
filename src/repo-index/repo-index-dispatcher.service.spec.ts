import { RepoIndexDispatcherService } from './repo-index-dispatcher.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { RepoIndexRequestPayload } from './dto/repo-index-request.payload';

describe('RepoIndexDispatcherService', () => {
  const payload: RepoIndexRequestPayload = {
    repositoryId: 42,
    branch: 'develop',
    headSha: 'after-sha',
    changedFiles: [],
  };

  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: RepoIndexDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REPO_INDEX_REQUEST_TOPIC = 'repo.index.requested';

    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new RepoIndexDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('이미 처리된 job이면 발행하지 않고 스킵한다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload);

    expect(idempotencyStore.markProcessed).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('중복이 아니면 idempotency를 기록하고 발행한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);

    await service.dispatch(payload);

    expect(idempotencyStore.markProcessed).toHaveBeenCalledWith(
      '42:develop:after-sha',
    );
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'repo.index.requested',
      payload,
      '42:develop:after-sha',
    );
  });

  it('Kafka 발행이 실패하면 에러를 throw한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload)).rejects.toThrow('kafka down');
  });
});
