import { ReviewFeedbackDispatcherService } from './review-feedback-dispatcher.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ReviewFeedbackPayload } from './dto/review-feedback.payload';

describe('ReviewFeedbackDispatcherService', () => {
  const payload: ReviewFeedbackPayload = {
    reviewJobId: '1:1:sha',
    findingIndex: 0,
    reflected: true,
  };

  let idempotencyStore: { acquire: jest.Mock; release: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: ReviewFeedbackDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REVIEW_FEEDBACK_TOPIC = 'pr.comment.reflected';

    idempotencyStore = { acquire: jest.fn(), release: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new ReviewFeedbackDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('같은 commentId로 이미 처리된 경우 발행하지 않는다', async () => {
    idempotencyStore.acquire.mockResolvedValue(false);

    await service.dispatch(payload, 999);

    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('처리되지 않은 경우 idempotency를 점유하고 reviewJobId를 key로 발행한다', async () => {
    idempotencyStore.acquire.mockResolvedValue(true);

    await service.dispatch(payload, 999);

    expect(idempotencyStore.acquire).toHaveBeenCalledWith('feedback:999');
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.comment.reflected',
      payload,
      '1:1:sha',
    );
    expect(idempotencyStore.release).not.toHaveBeenCalled();
  });

  it('Kafka 발행이 실패하면 idempotency 점유를 되돌리고 에러를 throw한다', async () => {
    idempotencyStore.acquire.mockResolvedValue(true);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload, 999)).rejects.toThrow('kafka down');
    expect(idempotencyStore.release).toHaveBeenCalledWith('feedback:999');
  });
});
