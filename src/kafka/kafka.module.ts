import { Global, Module } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { KafkaProducerService } from './kafka-producer.service';
import { KAFKA_CLIENT } from './kafka.constants';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: () =>
        new Kafka({
          clientId: 'dovi-github-app',
          brokers: process.env.KAFKA_BOOTSTRAP_SERVERS!.split(','),
        }),
    },
    KafkaProducerService,
  ],
  exports: [KAFKA_CLIENT, KafkaProducerService],
})
export class KafkaModule {}
