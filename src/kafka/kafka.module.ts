import { Global, Module } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { KafkaProducerService } from './kafka-producer.service';
import { KAFKA_CLIENT } from './kafka.constants';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: () => {
        const brokers = process.env.KAFKA_BOOTSTRAP_SERVERS;
        if (!brokers) {
          throw new Error(
            'KAFKA_BOOTSTRAP_SERVERS environment variable is not defined',
          );
        }
        return new Kafka({
          clientId: 'dovi-github-app',
          brokers: brokers.split(','),
        });
      },
    },
    KafkaProducerService,
  ],
  exports: [KAFKA_CLIENT, KafkaProducerService],
})
export class KafkaModule {}
