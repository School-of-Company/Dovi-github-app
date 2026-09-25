import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { SandboxProbeJobContext } from './sandbox-probe-job-context.type';

// 프로브 잡의 wall-clock 상한(15분) + ai-server의 포이즌 잡 재시도(최대 2회, dedup TTL
// 30분)보다 여유 있게 잡아, completed 이벤트가 늦게 와도 컨텍스트가 살아있게 한다.
const TTL_SECONDS = 60 * 60 * 2;

@Injectable()
export class SandboxProbeJobContextStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(reviewJobId: string): Promise<SandboxProbeJobContext | null> {
    const raw = await this.redis.get(this.key(reviewJobId));
    return raw ? (JSON.parse(raw) as SandboxProbeJobContext) : null;
  }

  async set(
    reviewJobId: string,
    context: SandboxProbeJobContext,
  ): Promise<void> {
    await this.redis.set(
      this.key(reviewJobId),
      JSON.stringify(context),
      'EX',
      TTL_SECONDS,
    );
  }

  private key(reviewJobId: string): string {
    return `sandbox-probe:context:${reviewJobId}`;
  }
}
