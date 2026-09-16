import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// PR이 열려있는 동안 push(synchronize)가 여러 번 반복될 수 있어 job 단위 TTL(1시간)보다
// 훨씬 길게 잡는다 — push마다 set()으로 갱신되므로 사실상 PR이 활성 상태인 한 유지된다.
const TTL_SECONDS = 60 * 60 * 24 * 30;

// push마다 GitHub 리뷰(PR 타임라인의 "reviewed" 배너)를 새로 만들면 배너가 계속
// 쌓이므로, 이 PR에 봇이 처음 남긴 리뷰의 id를 기억해뒀다가 이후 push에서는
// 그 리뷰의 body만 갱신(updateReview)하는 데 쓴다.
@Injectable()
export class PrimaryReviewStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(repositoryId: number, prNumber: number): Promise<number | null> {
    const raw = await this.redis.get(this.key(repositoryId, prNumber));
    return raw ? Number(raw) : null;
  }

  async set(
    repositoryId: number,
    prNumber: number,
    reviewId: number,
  ): Promise<void> {
    await this.redis.set(
      this.key(repositoryId, prNumber),
      String(reviewId),
      'EX',
      TTL_SECONDS,
    );
  }

  // 저장된 review id가 더 이상 GitHub에 존재하지 않을 때(삭제/dismiss됨) 호출해
  // 다음 push에서 새 리뷰가 생성되도록 한다.
  async delete(repositoryId: number, prNumber: number): Promise<void> {
    await this.redis.del(this.key(repositoryId, prNumber));
  }

  private key(repositoryId: number, prNumber: number): string {
    return `review:primary:${repositoryId}:${prNumber}`;
  }
}
