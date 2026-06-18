import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookService } from './webhook.service';
import { PrDataCollectorModule } from '../pr-data-collector/pr-data-collector.module';
import { ReviewDispatcherModule } from '../review-dispatcher/review-dispatcher.module';

@Module({
  imports: [PrDataCollectorModule, ReviewDispatcherModule],
  controllers: [WebhookController],
  providers: [WebhookSignatureGuard, WebhookService],
})
export class WebhookModule {}
