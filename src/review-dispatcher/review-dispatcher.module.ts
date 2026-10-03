import { Module } from '@nestjs/common';
import { ReviewFreshnessModule } from '../review-freshness/review-freshness.module';
import { ReviewDispatcherService } from './review-dispatcher.service';

@Module({
  imports: [ReviewFreshnessModule],
  providers: [ReviewDispatcherService],
  exports: [ReviewDispatcherService],
})
export class ReviewDispatcherModule {}
