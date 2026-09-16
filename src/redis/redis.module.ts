import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { IdempotencyStore } from './idempotency.store';
import { JobStateStore } from './job-state.store';
import { ReviewJobContextStore } from './review-job-context.store';
import { CommentAnswerContextStore } from './comment-answer-context.store';
import { ReviewCommentFindingStore } from './review-comment-finding.store';
import { PrimaryReviewStore } from './primary-review.store';
import { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => new Redis(process.env.REDIS_URL!),
    },
    IdempotencyStore,
    JobStateStore,
    ReviewJobContextStore,
    CommentAnswerContextStore,
    ReviewCommentFindingStore,
    PrimaryReviewStore,
  ],
  exports: [
    REDIS_CLIENT,
    IdempotencyStore,
    JobStateStore,
    ReviewJobContextStore,
    CommentAnswerContextStore,
    ReviewCommentFindingStore,
    PrimaryReviewStore,
  ],
})
export class RedisModule {}
