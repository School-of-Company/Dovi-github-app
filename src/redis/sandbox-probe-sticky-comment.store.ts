import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// PrimaryReviewStore와 동일한 이유로 30일을 쓴다 — PR이 열려있는 동안 completed
// 이벤트가 여러 번 올 수 있어 job 단위 TTL보다 훨씬 길게 잡는다.
const TTL_SECONDS = 60 * 60 * 24 * 30;

// completed 이벤트가 올 때마다 issues.listComments로 마커 코멘트를 다시 찾으면,
// 두 이벤트가 동시에 처리될 때(예: 재전송, 여러 인스턴스) 둘 다 "없음"으로 보고
// createComment를 두 번 호출해 sticky 코멘트가 중복 생성될 수 있다(PR #36과
// 같은 종류의 경합). 생성된 코멘트 id를 기억해뒀다가 재사용한다.
@Injectable()
export class SandboxProbeStickyCommentStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(repositoryId: number, prNumber: number): Promise<number | null> {
    const raw = await this.redis.get(this.key(repositoryId, prNumber));
    return raw ? Number(raw) : null;
  }

  async set(
    repositoryId: number,
    prNumber: number,
    commentId: number,
  ): Promise<void> {
    await this.redis.set(
      this.key(repositoryId, prNumber),
      String(commentId),
      'EX',
      TTL_SECONDS,
    );
  }

  // 저장된 코멘트가 더 이상 존재하지 않을 때(사람이 삭제함, 404/410) 호출해
  // 다음 completed 이벤트에서 새로 만들도록 한다.
  async delete(repositoryId: number, prNumber: number): Promise<void> {
    await this.redis.del(this.key(repositoryId, prNumber));
  }

  private key(repositoryId: number, prNumber: number): string {
    return `sandbox-probe:sticky-comment:${repositoryId}:${prNumber}`;
  }
}
