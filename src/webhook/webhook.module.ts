import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookService } from './webhook.service';
import { PrDataCollectorModule } from '../pr-data-collector/pr-data-collector.module';
import { ReviewDispatcherModule } from '../review-dispatcher/review-dispatcher.module';
import { CommentAnswerModule } from '../comment-answer/comment-answer.module';

@Module({
  imports: [PrDataCollectorModule, ReviewDispatcherModule, CommentAnswerModule],
  controllers: [WebhookController],
  providers: [WebhookSignatureGuard, WebhookService],
})
export class WebhookModule {}
