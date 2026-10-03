import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// PR이 열려있는 동안 push마다 실패할 수 있어 PrimaryReviewStore와 같은 30일로 둔다.
const TTL_SECONDS = 60 * 60 * 24 * 30;

// 리뷰 실패 안내 코멘트의 id를 PR별로 기억한다. push마다 실패해도 코멘트를 새로
// 만들지 않고 같은 코멘트를 갱신하고, 나중에 리뷰가 성공하면 지우는 데 쓴다.
// 실패 이벤트(pr.review.failed)에는 repositoryId가 없어 owner/repo로 키를 만든다.
@Injectable()
export class ReviewFailureCommentStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<number | null> {
    const raw = await this.redis.get(this.key(owner, repo, prNumber));
    return raw ? Number(raw) : null;
  }

  async set(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
  ): Promise<void> {
    await this.redis.set(
      this.key(owner, repo, prNumber),
      String(commentId),
      'EX',
      TTL_SECONDS,
    );
  }

  async delete(owner: string, repo: string, prNumber: number): Promise<void> {
    await this.redis.del(this.key(owner, repo, prNumber));
  }

  private key(owner: string, repo: string, prNumber: number): string {
    return `review:failure-comment:${owner}/${repo}#${prNumber}`;
  }
}
