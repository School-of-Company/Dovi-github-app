import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebhookModule } from './webhook/webhook.module';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { InstallationTokenModule } from './installation-token/installation-token.module';
import { ReviewResultConsumerModule } from './review-result-consumer/review-result-consumer.module';
import { CommentAnswerResultModule } from './comment-answer-result/comment-answer-result.module';
import { SandboxProbeResultModule } from './sandbox-probe-result/sandbox-probe-result.module';

@Module({
  imports: [
    RedisModule,
    KafkaModule,
    InstallationTokenModule,
    WebhookModule,
    ReviewResultConsumerModule,
    CommentAnswerResultModule,
    SandboxProbeResultModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
