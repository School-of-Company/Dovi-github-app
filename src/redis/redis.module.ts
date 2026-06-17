import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { IdempotencyStore } from './idempotency.store';
import { JobStateStore } from './job-state.store';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => new Redis(process.env.REDIS_URL!),
    },
    IdempotencyStore,
    JobStateStore,
  ],
  exports: [REDIS_CLIENT, IdempotencyStore, JobStateStore],
})
export class RedisModule {}
