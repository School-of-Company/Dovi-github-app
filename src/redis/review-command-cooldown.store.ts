import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// /dovi review·봇 멘션처럼 AI 리뷰를 직접 일으키는 명령의 PR별 쿨다운.
// 이 명령은 reviewJobId에 commentId를 섞어 멱등성을 우회하므로, 반복 호출을 막는
// 장치가 따로 없으면 코멘트 수만큼 AI 리뷰(직렬, 1.5~8분)가 쌓인다.
@Injectable()
export class ReviewCommandCooldownStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // SET NX EX로 원자적으로 점유한다. false면 쿨다운 중이다.
  async acquire(
    repositoryId: number,
    prNumber: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.set(
      `review:command-cooldown:${repositoryId}:${prNumber}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
