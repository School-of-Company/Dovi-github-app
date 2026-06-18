import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { IdempotencyStore } from './idempotency.store';
import { JobStateStore } from './job-state.store';
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
  ],
  exports: [REDIS_CLIENT, IdempotencyStore, JobStateStore],
})
export class RedisModule {}
