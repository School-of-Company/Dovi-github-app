import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { JobState } from './job-state.type';

const TTL_SECONDS = 60 * 60;

@Injectable()
export class JobStateStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(reviewJobId: string): Promise<JobState | null> {
    return (await this.redis.get(this.key(reviewJobId))) as JobState | null;
  }

  async set(reviewJobId: string, state: JobState): Promise<void> {
    await this.redis.set(this.key(reviewJobId), state, 'EX', TTL_SECONDS);
  }

  private key(reviewJobId: string): string {
    return `review:state:${reviewJobId}`;
  }
}
