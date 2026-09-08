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

  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: ReviewFeedbackDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REVIEW_FEEDBACK_TOPIC = 'pr.comment.reflected';

    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new ReviewFeedbackDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('같은 commentId로 이미 처리된 경우 발행하지 않는다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload, 999);

    expect(idempotencyStore.markProcessed).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('처리되지 않은 경우 idempotency를 기록하고 reviewJobId를 key로 발행한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);

    await service.dispatch(payload, 999);

    expect(idempotencyStore.exists).toHaveBeenCalledWith('feedback:999');
    expect(idempotencyStore.markProcessed).toHaveBeenCalledWith('feedback:999');
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.comment.reflected',
      payload,
      '1:1:sha',
    );
  });

  it('Kafka 발행이 실패하면 에러를 throw한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload, 999)).rejects.toThrow('kafka down');
  });
});
