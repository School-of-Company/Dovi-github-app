import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// 같은 알림을 짧은 시간에 여러 번 보내지 않기 위한 저장소. 일시적 오류(5xx, 네트워크)는 Kafka
// 재전달로 같은 메시지가 계속 다시 처리되는데, 그때마다 Discord로 알리면 같은 job의 알림이
// 수십 개 쌓여 정작 중요한 알림이 묻힌다.
@Injectable()
export class AlertThrottleStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // 이 키로 ttl 안에 처음 호출됐으면 true(알려도 됨), 이미 알렸으면 false.
  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `alert-throttle:${key}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
