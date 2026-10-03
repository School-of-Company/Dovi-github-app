import { Module } from '@nestjs/common';
import { ReviewFreshnessService } from './review-freshness.service';

@Module({
  providers: [ReviewFreshnessService],
  exports: [ReviewFreshnessService],
})
export class ReviewFreshnessModule {}
