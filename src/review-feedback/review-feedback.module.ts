import { Module } from '@nestjs/common';
import { ReviewFeedbackDispatcherService } from './review-feedback-dispatcher.service';

@Module({
  providers: [ReviewFeedbackDispatcherService],
  exports: [ReviewFeedbackDispatcherService],
})
export class ReviewFeedbackModule {}
