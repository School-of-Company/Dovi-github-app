import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Consumer, Kafka, KafkaMessage } from 'kafkajs';
import { PoisonMessageError } from './poison-message.error';

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
        try {
          await this.handleMessage(topic, message);
        } catch (err) {
          if (!(err instanceof PoisonMessageError)) throw err;
          this.logger.warn(
            `역직렬화/검증 불가 메시지, 커밋 후 스킵: topic=${topic} partition=${partition} offset=${message.offset}`,
            err,
          );
        }

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
