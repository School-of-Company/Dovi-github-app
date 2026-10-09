import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { UnreviewedFile } from '../pr-data-collector/dto/unreviewed-file';
import { REDIS_CLIENT } from './redis.constants';

// 리뷰 요청 후 결과가 게시되기까지(AI 서버 대기 포함 최대 수십 분)만 필요하다.
const TTL_SECONDS = 60 * 60 * 2;

// 수집 단계(PrDataCollectorService)에서 알게 된 "리뷰하지 못한 파일"을 게시 단계가 읽을 수
// 있게 넘겨 준다. 키를 reviewJobId가 아니라 (저장소, PR, headSha)로 잡는 이유: /dovi review·멘션
// 재리뷰는 수집 뒤에 reviewJobId에 `_c{commentId}` 접미사를 붙여 달라지지만, 결과 이벤트에도
// 있는 이 세 값은 변하지 않는다.
@Injectable()
export class UnreviewedFilesStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async set(
    repositoryId: number,
    prNumber: number,
    headSha: string,
    files: UnreviewedFile[],
  ): Promise<void> {
    const key = this.key(repositoryId, prNumber, headSha);
    // 없으면 지운다 — 같은 커밋을 다시 수집했을 때 이전 수집의 목록이 남아 있으면 안 된다.
    if (files.length === 0) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, JSON.stringify(files), 'EX', TTL_SECONDS);
  }

  async get(
    repositoryId: number,
    prNumber: number,
    headSha: string,
  ): Promise<UnreviewedFile[]> {
    const raw = await this.redis.get(this.key(repositoryId, prNumber, headSha));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as UnreviewedFile[]) : [];
    } catch {
      return [];
    }
  }

  private key(repositoryId: number, prNumber: number, headSha: string): string {
    return `review:unreviewed:${repositoryId}:${prNumber}:${headSha}`;
  }
}
