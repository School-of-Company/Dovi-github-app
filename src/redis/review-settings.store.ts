import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { PublishSettings } from '../common/review-settings';
import { REDIS_CLIENT } from './redis.constants';

// 리뷰 요청 후 결과가 게시되기까지(AI 서버 대기 포함)만 필요하다.
const TTL_SECONDS = 60 * 60 * 2;

// 수집 단계가 읽은 레포 설정 중 **게시 단계**가 쓰는 것(minSeverity, maxInlineComments)을 넘겨 준다.
// UnreviewedFilesStore와 같은 이유로 키는 (저장소, PR, headSha)다 — 재리뷰는 수집 뒤 reviewJobId가
// 달라지지만 결과 이벤트의 이 세 값은 그대로다.
@Injectable()
export class ReviewSettingsStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async set(
    repositoryId: number,
    prNumber: number,
    headSha: string,
    settings: PublishSettings,
  ): Promise<void> {
    const key = this.key(repositoryId, prNumber, headSha);
    // 설정이 없으면 지운다 — 같은 커밋을 다시 수집했을 때 이전 설정이 남아 있으면 안 된다
    // (사용자가 설정을 지운 뒤에도 필터가 계속 적용되는 일이 없게).
    if (
      settings.minSeverity === undefined &&
      settings.maxInlineComments === undefined
    ) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, JSON.stringify(settings), 'EX', TTL_SECONDS);
  }

  async get(
    repositoryId: number,
    prNumber: number,
    headSha: string,
  ): Promise<PublishSettings> {
    const raw = await this.redis.get(this.key(repositoryId, prNumber, headSha));
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private key(repositoryId: number, prNumber: number, headSha: string): string {
    return `review:settings:${repositoryId}:${prNumber}:${headSha}`;
  }
}
