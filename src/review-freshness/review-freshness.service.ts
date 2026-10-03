import { Inject, Injectable, Logger } from '@nestjs/common';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import { JobStateStore } from '../redis/job-state.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';

export type StaleReason = 'closed' | 'head-changed';

// AI 서버는 리뷰를 직렬로 처리해서 헛돈 리뷰가 곧 다른 PR의 대기 시간이다. 리뷰를 요청한
// 뒤 PR이 닫히거나 새 커밋이 올라오면 그 결과는 쓸모가 없고(줄이 어긋나 422/강등의 원인이
// 되기도 한다), 이를 GitHub의 현재 PR 상태와 비교해 판단한다.
//
// 이건 최적화이지 안전장치가 아니다. 상태를 확인하지 못하면(GitHub 오류, 네트워크) 오래된
// 결과를 걸러내지 못할 뿐이므로, 멀쩡한 리뷰를 잃지 않도록 항상 "오래되지 않음"으로 진행한다.
@Injectable()
export class ReviewFreshnessService {
  private readonly logger = new Logger(ReviewFreshnessService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
    private readonly jobStateStore: JobStateStore,
  ) {}

  // 오래되었으면 사유를, 아니면(또는 판단 불가면) null을 돌려준다.
  async findStaleReason(
    context: ReviewJobContext,
    review: { repositoryId: number; headSha: string },
  ): Promise<StaleReason | null> {
    try {
      const octokit = await this.installationTokenManager.getOctokit(
        context.installationId,
      );
      const { data: pr } = await withRetry(() =>
        octokit.rest.pulls.get({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.prNumber,
        }),
      );

      // 머지된 PR도 API에서는 state === 'closed'다.
      if (pr.state !== 'open') return 'closed';
      if (pr.head.sha === review.headSha) return null;

      // head가 바뀌었다고 곧바로 버리면 안 된다. 봇이 푸시한 커밋(포맷팅 등)은 웹훅이 무시해서
      // 새 head의 리뷰가 아예 발행되지 않는데, 이때 이전 커밋의 리뷰까지 버리면 그 PR은
      // 리뷰를 하나도 못 받는다. 새 head의 리뷰 job이 실제로 요청/완료된 경우에만 이 결과가
      // 대체된 것으로 본다(job id는 PrDataCollectorService가 만드는 형식과 같다).
      const newerState = await this.jobStateStore.get(
        `${review.repositoryId}:${context.prNumber}:${pr.head.sha}`,
      );
      const superseded =
        newerState === 'requested' ||
        newerState === 'processing' ||
        newerState === 'completed';
      return superseded ? 'head-changed' : null;
    } catch (err) {
      this.logger.warn(
        `PR 상태 확인 실패, 오래된 결과 판단 없이 진행: ${context.owner}/${context.repo}#${context.prNumber}`,
        err,
      );
      return null;
    }
  }
}
