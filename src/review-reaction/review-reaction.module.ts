import { Module } from '@nestjs/common';
import { ReviewReactionService } from './review-reaction.service';

@Module({
  providers: [ReviewReactionService],
  exports: [ReviewReactionService],
})
export class ReviewReactionModule {}
