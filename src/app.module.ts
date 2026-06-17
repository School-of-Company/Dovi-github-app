import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebhookModule } from './webhook/webhook.module';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { InstallationTokenModule } from './installation-token/installation-token.module';
import { ReviewResultConsumerModule } from './review-result-consumer/review-result-consumer.module';

@Module({
  imports: [
    RedisModule,
    KafkaModule,
    InstallationTokenModule,
    WebhookModule,
    ReviewResultConsumerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
