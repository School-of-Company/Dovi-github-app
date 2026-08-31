import { Module } from '@nestjs/common';
import { ReviewDispatcherService } from './review-dispatcher.service';

@Module({
  providers: [ReviewDispatcherService],
  exports: [ReviewDispatcherService],
})
export class ReviewDispatcherModule {}
