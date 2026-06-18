import { Module } from '@nestjs/common';
import { ReviewResultConsumerService } from './review-result-consumer.service';
import { REVIEW_ORCHESTRATOR } from '../review-orchestrator/review-orchestrator.interface';
import type { ReviewOrchestrator } from '../review-orchestrator/review-orchestrator.interface';

const notImplementedOrchestrator: ReviewOrchestrator = {
  handle: () => {
    throw new Error(
      'ReviewOrchestrator is not implemented. Provide a concrete class.',
    );
  },
};

@Module({
  providers: [
    ReviewResultConsumerService,
    {
      provide: REVIEW_ORCHESTRATOR,
      useValue: notImplementedOrchestrator,
    },
  ],
})
export class ReviewResultConsumerModule {}
