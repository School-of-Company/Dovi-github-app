import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

const TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async exists(reviewJobId: string): Promise<boolean> {
    const value = await this.redis.get(this.key(reviewJobId));
    return value !== null;
  }

  async markProcessed(reviewJobId: string): Promise<void> {
    await this.redis.set(this.key(reviewJobId), '1', 'EX', TTL_SECONDS);
  }

  private key(reviewJobId: string): string {
    return `review:idempotency:${reviewJobId}`;
  }
}
