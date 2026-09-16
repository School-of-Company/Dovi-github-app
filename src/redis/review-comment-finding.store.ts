import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { ReviewCommentFinding } from './review-comment-finding.type';

// 이 매핑은 사람이 봇 리뷰 코멘트에 답글을 달았을 때만 조회되는데, 그런 답글은
// 코멘트가 달린 지 몇 시간~며칠 뒤에 오는 경우가 흔하다. PrimaryReviewStore와
// 같은 TTL(PR이 열려있는 동안 유지)을 사용해야 반영 여부 추적이 유효하다.
const TTL_SECONDS = 60 * 60 * 24 * 30;

@Injectable()
export class ReviewCommentFindingStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(commentId: number): Promise<ReviewCommentFinding | null> {
    const raw = await this.redis.get(this.key(commentId));
    return raw ? (JSON.parse(raw) as ReviewCommentFinding) : null;
  }

  async set(commentId: number, finding: ReviewCommentFinding): Promise<void> {
    await this.redis.set(
      this.key(commentId),
      JSON.stringify(finding),
      'EX',
      TTL_SECONDS,
    );
  }

  private key(commentId: number): string {
    return `review:finding:${commentId}`;
  }
}
