import { Module } from '@nestjs/common';
import { ReviewResultConsumerService } from './review-result-consumer.service';
import { REVIEW_ORCHESTRATOR } from '../review-orchestrator/review-orchestrator.interface';

@Module({
  providers: [
    ReviewResultConsumerService,
    {
      provide: REVIEW_ORCHESTRATOR,
      useFactory: () => {
        throw new Error(
          'ReviewOrchestrator is not implemented. Provide a concrete class.',
        );
      },
    },
  ],
})
export class ReviewResultConsumerModule {}
