import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// 결과를 못 받은 채 남은 항목이 영구히 쌓이지 않게(배포 중 유실, 컨슈머 장애) 오래된 것은 센다.
const STALE_AFTER_MS = 60 * 60 * 1000;
const KEY = 'review:inflight';

// AI 서버는 리뷰를 직렬로 처리하므로, 발행 시점에 앞에 몇 건이 진행 중이었는지가 대기 시간을
// 설명한다(지연 측정, #93). 진행 중인 reviewJobId를 시각을 점수로 한 정렬 집합에 둔다.
// 측정용이라 정확도보다 단순함을 택했고, 호출부는 실패해도 리뷰 흐름에 영향이 없게 쓴다.
@Injectable()
export class ReviewInflightStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // 이 job을 진행 중으로 기록하고, 자신을 포함한 진행 중 job 수를 돌려준다.
  async enter(reviewJobId: string): Promise<number> {
    const now = Date.now();
    const results = await this.redis
      .multi()
      .zremrangebyscore(KEY, '-inf', now - STALE_AFTER_MS)
      .zadd(KEY, now, reviewJobId)
      .zcard(KEY)
      .exec();
    return Number(results?.[2]?.[1] ?? 0);
  }

  // 결과를 처리했으니 진행 중에서 빼고, 남은 진행 중 job 수를 돌려준다.
  async leave(reviewJobId: string): Promise<number> {
    const results = await this.redis
      .multi()
      .zrem(KEY, reviewJobId)
      .zcard(KEY)
      .exec();
    return Number(results?.[1]?.[1] ?? 0);
  }
}
