import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { ReviewCommentFinding } from './review-comment-finding.type';

const TTL_SECONDS = 60 * 60;

@Injectable()
export class ReviewCommentFindingStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(commentId: number): Promise<ReviewCommentFinding | null> {
    const raw = await this.redis.get(this.key(commentId));
    return raw ? (JSON.parse(raw) as ReviewCommentFinding) : null;
  }

  async set(commentId: number, finding: ReviewCommentFinding): Promise<void> {
    await this.redis.set(
      this.key(commentId),
      JSON.stringify(finding),
      'EX',
      TTL_SECONDS,
    );
  }

  private key(commentId: number): string {
    return `review:finding:${commentId}`;
  }
}
