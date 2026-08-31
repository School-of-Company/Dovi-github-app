import { Module } from '@nestjs/common';
import { ReviewResultConsumerService } from './review-result-consumer.service';
import { ReviewOrchestratorModule } from '../review-orchestrator/review-orchestrator.module';

@Module({
  imports: [ReviewOrchestratorModule],
  providers: [ReviewResultConsumerService],
})
export class ReviewResultConsumerModule {}
