import type { Kafka } from 'kafkajs';
import { BaseKafkaConsumer } from './base-kafka.consumer';
import { PoisonMessageError } from './poison-message.error';

class TestConsumer extends BaseKafkaConsumer {
  handleMessageMock = jest.fn();

  constructor(kafka: Kafka) {
    super(kafka, 'test-group', ['test-topic']);
  }

  async run(): Promise<void> {
    await this.start();
  }

  protected handleMessage(
    topic: string,
    message: { offset: string },
  ): Promise<void> {
    return this.handleMessageMock(topic, message) as Promise<void>;
  }
}

describe('BaseKafkaConsumer', () => {
  const message = { offset: '5' };
  let fakeConsumer: {
    connect: jest.Mock;
    subscribe: jest.Mock;
    on: jest.Mock;
    run: jest.Mock;
    disconnect: jest.Mock;
    commitOffsets: jest.Mock;
    events: { CRASH: string };
  };
  let eachMessage: (args: {
    topic: string;
    partition: number;
    message: { offset: string };
  }) => Promise<void>;

  beforeEach(() => {
    fakeConsumer = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      on: jest.fn(),
      run: jest.fn(
        (opts: {
          eachMessage: (args: {
            topic: string;
            partition: number;
            message: { offset: string };
          }) => Promise<void>;
        }) => {
          eachMessage = opts.eachMessage;
          return Promise.resolve();
        },
      ),
      disconnect: jest.fn(),
      commitOffsets: jest.fn(),
      events: { CRASH: 'consumer.crash' },
    };
  });

  function createConsumer(): TestConsumer {
    const fakeKafka = { consumer: jest.fn().mockReturnValue(fakeConsumer) };
    return new TestConsumer(fakeKafka as unknown as Kafka);
  }

  it('handleMessage 성공 시 다음 오프셋으로 커밋한다', async () => {
    const consumer = createConsumer();
    consumer.handleMessageMock.mockResolvedValue(undefined);
    await consumer.run();

    await eachMessage({ topic: 'test-topic', partition: 0, message });

    expect(fakeConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'test-topic', partition: 0, offset: '6' },
    ]);
  });

  it('PoisonMessageError는 삼키고 오프셋을 커밋한다 (파티션 정지 방지)', async () => {
    const consumer = createConsumer();
    consumer.handleMessageMock.mockRejectedValue(
      new PoisonMessageError('bad payload'),
    );
    await consumer.run();

    await eachMessage({ topic: 'test-topic', partition: 0, message });

    expect(fakeConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'test-topic', partition: 0, offset: '6' },
    ]);
  });

  it('그 외 오류는 다시 던지고 오프셋을 커밋하지 않는다 (재시도 대상)', async () => {
    const consumer = createConsumer();
    const err = new Error('transient GitHub 500');
    consumer.handleMessageMock.mockRejectedValue(err);
    await consumer.run();

    await expect(
      eachMessage({ topic: 'test-topic', partition: 0, message }),
    ).rejects.toThrow(err);

    expect(fakeConsumer.commitOffsets).not.toHaveBeenCalled();
  });
});
