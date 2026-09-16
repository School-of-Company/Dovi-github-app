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

  let idempotencyStore: { acquire: jest.Mock; release: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: RepoIndexDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REPO_INDEX_REQUEST_TOPIC = 'repo.index.requested';

    idempotencyStore = { acquire: jest.fn(), release: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new RepoIndexDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('이미 처리된 job이면 발행하지 않고 스킵한다', async () => {
    idempotencyStore.acquire.mockResolvedValue(false);

    await service.dispatch(payload);

    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('중복이 아니면 idempotency를 점유하고 발행한다', async () => {
    idempotencyStore.acquire.mockResolvedValue(true);

    await service.dispatch(payload);

    expect(idempotencyStore.acquire).toHaveBeenCalledWith(
      '42:develop:after-sha',
    );
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'repo.index.requested',
      payload,
      '42:develop:after-sha',
    );
    expect(idempotencyStore.release).not.toHaveBeenCalled();
  });

  it('Kafka 발행이 실패하면 idempotency 점유를 되돌리고 에러를 throw한다', async () => {
    idempotencyStore.acquire.mockResolvedValue(true);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload)).rejects.toThrow('kafka down');
    expect(idempotencyStore.release).toHaveBeenCalledWith(
      '42:develop:after-sha',
    );
  });
});
