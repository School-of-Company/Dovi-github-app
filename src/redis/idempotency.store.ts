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

  // exists() + markProcessed()를 따로 호출하면 그 사이에 경합이 생겨(웹훅 재전송,
  // 다중 인스턴스) 동시 호출 양쪽 모두 처리 대상으로 판정될 수 있다. SET NX로
  // 원자적으로 점유해야 하는 호출부(dispatcher 등)는 이 메서드를 사용한다.
  // 반환값이 false면 이미 다른 호출이 선점한 것이므로 스킵해야 한다.
  async acquire(reviewJobId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.key(reviewJobId),
      '1',
      'EX',
      TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  // acquire() 이후 처리가 실패해(예: Kafka 발행 실패) 재시도가 가능해야 할 때
  // 점유를 되돌린다.
  async release(reviewJobId: string): Promise<void> {
    await this.redis.del(this.key(reviewJobId));
  }

  private key(reviewJobId: string): string {
    return `review:idempotency:${reviewJobId}`;
  }
}
