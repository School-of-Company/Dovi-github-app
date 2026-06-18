import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CompressionTypes } from 'kafkajs';
import type { Kafka, Producer } from 'kafkajs';
import { KAFKA_CLIENT } from './kafka.constants';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly producer: Producer;

  constructor(@Inject(KAFKA_CLIENT) kafka: Kafka) {
    this.producer = kafka.producer();
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async send(topic: string, payload: object, key?: string): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(payload) }],
      compression: CompressionTypes.GZIP,
    });
  }
}
