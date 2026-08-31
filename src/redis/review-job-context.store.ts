import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { ReviewJobContext } from './review-job-context.type';

const TTL_SECONDS = 60 * 60;

@Injectable()
export class ReviewJobContextStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(reviewJobId: string): Promise<ReviewJobContext | null> {
    const raw = await this.redis.get(this.key(reviewJobId));
    return raw ? (JSON.parse(raw) as ReviewJobContext) : null;
  }

  async set(reviewJobId: string, context: ReviewJobContext): Promise<void> {
    await this.redis.set(
      this.key(reviewJobId),
      JSON.stringify(context),
      'EX',
      TTL_SECONDS,
    );
  }

  private key(reviewJobId: string): string {
    return `review:context:${reviewJobId}`;
  }
}
