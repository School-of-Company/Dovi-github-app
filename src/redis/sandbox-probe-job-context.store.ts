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

  // 발행한 잡의 (installation, 저장소) 조합을 기록한다. 토큰 발급 내부 API가 이 표시가
  // 있는 저장소에만 토큰을 내주도록 해서, 공유 시크릿이 새어도 github-app이 실제로
  // 샌드박스 잡을 발행하지 않은 저장소(opt-in 안 한 저장소, 다른 installation)의 코드는
  // 읽을 수 없게 한다. 같은 저장소에 새 잡이 발행될 때마다 TTL이 갱신된다.
  async markActiveRepository(
    installationId: number,
    repositoryId: number,
  ): Promise<void> {
    await this.redis.set(
      this.activeKey(installationId, repositoryId),
      '1',
      'EX',
      TTL_SECONDS,
    );
  }

  async isActiveRepository(
    installationId: number,
    repositoryId: number,
  ): Promise<boolean> {
    return (
      (await this.redis.get(this.activeKey(installationId, repositoryId))) !==
      null
    );
  }

  private activeKey(installationId: number, repositoryId: number): string {
    return `sandbox-probe:active:${installationId}:${repositoryId}`;
  }

  private key(reviewJobId: string): string {
    return `sandbox-probe:context:${reviewJobId}`;
  }
}
