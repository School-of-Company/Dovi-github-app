import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Octokit } from '@octokit/rest';
import { parseSandboxProbeOptIn } from '../common/dovi-md';
import { fetchFileContent } from '../common/github-content';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import type { SandboxProbeRequestPayload } from './dto/sandbox-probe-request.payload';

const DOVI_MD_SIZE_LIMIT = 200 * 1024;
const PACKAGE_JSON_SIZE_LIMIT = 1024 * 1024;
// 문서 전용 PR(README/docs 만 수정)은 빌드/기동 검증 대상이 아니다. lockfile은
// 정적 분석이 못 잡는 대표 사례라 의도적으로 문서 취급하지 않는다(스펙 참고).
const DOC_ONLY_PATH_PATTERN = /^docs\/|\.mdx?$/i;

export interface SandboxProbeTrigger {
  installationId: number;
  owner: string;
  repo: string;
  repositoryId: number;
  defaultBranch: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  isFork: boolean;
}

// PR 이벤트마다 이 레포/PR이 샌드박스 프로브(빌드/기동 런타임 검증) 대상인지
// 판단해 대상이면 pr.sandbox.probe.requested 를 발행한다. 메인 리뷰 발행 경로와
// 완전히 독립적으로 동작하며, 이 경로의 실패가 메인 리뷰에 영향을 주면 안 되므로
// 공개 메서드(notifyPrOpened)는 절대 예외를 던지지 않는다.
@Injectable()
export class SandboxProbeDispatcherService {
  private readonly logger = new Logger(SandboxProbeDispatcherService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly idempotencyStore: IdempotencyStore,
    private readonly sandboxProbeJobContextStore: SandboxProbeJobContextStore,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  notifyPrOpened(trigger: SandboxProbeTrigger): void {
    this.maybeDispatch(trigger).catch((err: unknown) => {
      this.logger.error(
        `샌드박스 프로브 발행 검토 실패, 메인 리뷰에는 영향 없음: ${trigger.owner}/${trigger.repo}#${trigger.prNumber}`,
        err,
      );
    });
  }

  private async maybeDispatch(trigger: SandboxProbeTrigger): Promise<void> {
    // 발행 측 킬스위치: 컨슈머 플래그만으로는 이벤트가 쌓여서 재활성화 시
    // 리플레이되므로, 발행 자체를 끄는 별도 플래그가 필요하다.
    if (process.env.SANDBOX_PROBE_PUBLISH_ENABLED !== 'true') return;
    // v1은 같은 레포 브랜치 PR만 대상 — fork 저장소는 App이 설치되어 있지 않을 수
    // 있어 동일한 installation token으로 clone할 수 없다.
    if (trigger.isFork) return;

    const octokit = await this.installationTokenManager.getOctokit(
      trigger.installationId,
    );

    const optedIn = await this.isOptedIn(
      octokit,
      trigger.owner,
      trigger.repo,
      trigger.defaultBranch,
    );
    if (!optedIn) return;

    const isNestJsStack = await this.detectNestJsStack(
      octokit,
      trigger.owner,
      trigger.repo,
      trigger.headSha,
    );
    if (!isNestJsStack) return;

    const isDocOnly = await this.isDocOnlyChange(
      octokit,
      trigger.owner,
      trigger.repo,
      trigger.prNumber,
    );
    if (isDocOnly) return;

    const reviewJobId = `${trigger.repositoryId}:${trigger.prNumber}:${trigger.headSha}`;
    // 메인 리뷰와 동일한 형태의 reviewJobId를 그대로 IdempotencyStore(공유 저장소)에
    // 넘기면 과거 실제 충돌 사고(#40)와 같은 종류의 키 충돌이 난다. 별도 네임스페이스로
    // 분리한다.
    const dedupKey = `sandbox:${reviewJobId}`;
    if (!(await this.idempotencyStore.acquire(dedupKey))) {
      this.logger.log(`이미 발행된 샌드박스 프로브 job, 스킵: ${dedupKey}`);
      return;
    }

    await this.sandboxProbeJobContextStore.set(reviewJobId, {
      owner: trigger.owner,
      repo: trigger.repo,
      prNumber: trigger.prNumber,
      installationId: trigger.installationId,
    });

    const payload: SandboxProbeRequestPayload = {
      reviewJobId,
      repositoryId: trigger.repositoryId,
      repoFullName: `${trigger.owner}/${trigger.repo}`,
      prNumber: trigger.prNumber,
      headSha: trigger.headSha,
      baseSha: trigger.baseSha,
    };

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_SANDBOX_PROBE_REQUEST_TOPIC!,
        payload,
        reviewJobId,
      );
    } catch (err) {
      await this.idempotencyStore.release(dedupKey);
      throw err;
    }
  }

  // DOVI.md는 항상 default_branch 기준으로 읽는다 (repo-index의 선례와 동일) —
  // PR 브랜치에서 읽으면 PR 작성자가 자기 PR 안에서 opt-in을 조작할 수 있다.
  private async isOptedIn(
    octokit: Octokit,
    owner: string,
    repo: string,
    defaultBranch: string,
  ): Promise<boolean> {
    const result = await fetchFileContent(
      octokit,
      owner,
      repo,
      defaultBranch,
      'DOVI.md',
      DOVI_MD_SIZE_LIMIT,
    );
    if (result.content === null) return false;
    return parseSandboxProbeOptIn(result.content);
  }

  private async detectNestJsStack(
    octokit: Octokit,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<boolean> {
    const result = await fetchFileContent(
      octokit,
      owner,
      repo,
      headSha,
      'package.json',
      PACKAGE_JSON_SIZE_LIMIT,
    );
    if (result.content === null) return false;

    try {
      const parsed = JSON.parse(result.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(
        parsed.dependencies?.['@nestjs/core'] ||
        parsed.devDependencies?.['@nestjs/core'],
      );
    } catch {
      return false;
    }
  }

  private async isDocOnlyChange(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<boolean> {
    const files = await withRetry(() =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    );
    if (files.length === 0) return true;
    return files.every((file) => DOC_ONLY_PATH_PATTERN.test(file.filename));
  }
}
