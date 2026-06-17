import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Consumer, Kafka, KafkaMessage } from 'kafkajs';

export abstract class BaseKafkaConsumer implements OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  private readonly consumer: Consumer;

  constructor(
    kafka: Kafka,
    private readonly groupId: string,
    private readonly topics: string[],
  ) {
    this.consumer = kafka.consumer({ groupId: this.groupId });
  }

  protected async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.topics });

    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      this.logger.error('Kafka consumer crashed', payload.error);
    });

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        await this.handleMessage(topic, message);
        await this.consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  protected abstract handleMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<void>;
}
