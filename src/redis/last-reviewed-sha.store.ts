import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// PR이 열려 있는 동안 재리뷰가 여러 번 있을 수 있어 PrimaryReviewStore와 같은 수명으로 둔다.
const TTL_SECONDS = 60 * 60 * 24 * 30;

// 증분 리뷰(#94)의 기준점: 이 PR에 **게시까지 성공한** 마지막 리뷰의 headSha.
// 게시 전(요청·결과 수신)이 아니라 게시 성공 시점에만 기록해야, 중간 커밋의 리뷰가 실패하거나
// 오래되어 버려졌을 때 그 커밋의 변경이 다음 증분 리뷰에서 빠지지 않는다.
@Injectable()
export class LastReviewedShaStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(repositoryId: number, prNumber: number): Promise<string | null> {
    return this.redis.get(this.key(repositoryId, prNumber));
  }

  async set(
    repositoryId: number,
    prNumber: number,
    headSha: string,
  ): Promise<void> {
    await this.redis.set(
      this.key(repositoryId, prNumber),
      headSha,
      'EX',
      TTL_SECONDS,
    );
  }

  private key(repositoryId: number, prNumber: number): string {
    return `review:last-sha:${repositoryId}:${prNumber}`;
  }
}
