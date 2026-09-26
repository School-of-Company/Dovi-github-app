import { Global, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { IdempotencyStore } from './idempotency.store';
import { JobStateStore } from './job-state.store';
import { ReviewJobContextStore } from './review-job-context.store';
import { CommentAnswerContextStore } from './comment-answer-context.store';
import { ReviewCommentFindingStore } from './review-comment-finding.store';
import { PrimaryReviewStore } from './primary-review.store';
import { SandboxProbeJobContextStore } from './sandbox-probe-job-context.store';
import { SandboxProbeStickyCommentStore } from './sandbox-probe-sticky-comment.store';
import { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) {
          throw new Error('REDIS_URL environment variable is not defined');
        }
        const client = new Redis(url);
        client.on('error', (err) => {
          new Logger('RedisModule').error('Redis 연결 오류', err);
        });
        return client;
      },
    },
    IdempotencyStore,
    JobStateStore,
    ReviewJobContextStore,
    CommentAnswerContextStore,
    ReviewCommentFindingStore,
    PrimaryReviewStore,
    SandboxProbeJobContextStore,
    SandboxProbeStickyCommentStore,
  ],
  exports: [
    REDIS_CLIENT,
    IdempotencyStore,
    JobStateStore,
    ReviewJobContextStore,
    CommentAnswerContextStore,
    ReviewCommentFindingStore,
    PrimaryReviewStore,
    SandboxProbeJobContextStore,
    SandboxProbeStickyCommentStore,
  ],
})
export class RedisModule {}
