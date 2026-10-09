import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { ReviewFreshnessService } from '../review-freshness/review-freshness.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
import { ReviewInflightStore } from '../redis/review-inflight.store';
import { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';

@Injectable()
export class ReviewDispatcherService {
  private readonly logger = new Logger(ReviewDispatcherService.name);

  constructor(
    private readonly idempotencyStore: IdempotencyStore,
    private readonly jobStateStore: JobStateStore,
    private readonly reviewJobContextStore: ReviewJobContextStore,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly reviewFreshness: ReviewFreshnessService,
    private readonly reviewInflightStore: ReviewInflightStore,
  ) {}

  async dispatch(
    payload: ReviewRequestPayload,
    context: ReviewJobContext,
  ): Promise<void> {
    const { reviewJobId } = payload;

    const [alreadyProcessed, state] = await Promise.all([
      this.idempotencyStore.exists(reviewJobId),
      this.jobStateStore.get(reviewJobId),
    ]);

    if (alreadyProcessed) {
      this.logger.log(`이미 처리된 reviewJobId, 스킵: ${reviewJobId}`);
      return;
    }

    if (state === 'completed' || state === 'processing') {
      this.logger.log(`현재 상태(${state})로 스킵: ${reviewJobId}`);
      return;
    }

    // 증분 리뷰인데 리뷰할 파일이 남지 않았으면(제외 설정 파일만 바뀜 등) AI 서버를 부르지 않는다.
    // 이전 리뷰와 코멘트가 그대로 유효하다.
    if (payload.incremental && payload.changedFiles.length === 0) {
      this.logger.log(
        `증분 리뷰 대상 파일 없음, AI 요청 생략: reviewJobId=${reviewJobId} previousHeadSha=${payload.previousHeadSha}`,
      );
      return;
    }

    // 수집하는 동안 PR이 닫혔거나 새 커밋이 올라왔으면 발행하지 않는다. 큐에 쌓이면 AI
    // 서버(직렬)가 헛돈 리뷰를 하느라 다른 PR이 밀린다. 이미 발행된 요청은 되돌릴 수 없고,
    // 그 결과는 게시 단계(ReviewOrchestratorService)가 걸러낸다.
    const staleReason = await this.reviewFreshness.findStaleReason(context, {
      repositoryId: payload.repositoryId,
      headSha: payload.headSha,
    });
    if (staleReason !== null) {
      this.logger.log(
        `stale review request skipped (${staleReason}): ${context.owner}/${context.repo}#${context.prNumber} reviewJobId=${reviewJobId} headSha=${payload.headSha}`,
      );
      return;
    }

    // 단계별 지연 측정(#93): 결과를 받을 때 계산할 수 있도록 발행 시각과 요청 크기를 컨텍스트에 남긴다.
    const dispatchedAt = Date.now();
    const measuredContext: ReviewJobContext = {
      ...context,
      ...(payload.incremental && payload.previousHeadSha
        ? {
            incrementalBase: payload.previousHeadSha,
            incrementalPaths: payload.changedFiles.map((f) => f.filePath),
          }
        : {}),
      dispatchedAt,
      files: payload.changedFiles.length,
      patchBytes: payload.changedFiles.reduce(
        (sum, file) =>
          sum + (file.patch === undefined ? 0 : Buffer.byteLength(file.patch)),
        0,
      ),
    };

    await Promise.all([
      this.jobStateStore.set(reviewJobId, 'requested'),
      this.reviewJobContextStore.set(reviewJobId, measuredContext),
    ]);

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_REVIEW_REQUEST_TOPIC!,
        payload,
        reviewJobId,
      );
      await this.logDispatched(reviewJobId, measuredContext);
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${reviewJobId}`, err);
      throw err;
    }
  }

  // 발행 시점의 수집 시간과 진행 중 job 수(앞에 몇 건이 있었는지)를 남긴다. 측정은 보조
  // 기능이라 Redis 오류가 발행 흐름에 영향을 주지 않게 삼킨다.
  private async logDispatched(
    reviewJobId: string,
    context: ReviewJobContext,
  ): Promise<void> {
    try {
      const inflight = await this.reviewInflightStore.enter(reviewJobId);
      const collect =
        context.collectStartedAt !== undefined &&
        context.dispatchedAt !== undefined
          ? `${Math.max(0, context.dispatchedAt - context.collectStartedAt)}ms`
          : 'n/a';
      this.logger.log(
        `review dispatched reviewJobId=${reviewJobId} collect=${collect} files=${context.files} patchBytes=${context.patchBytes} inflight=${inflight}`,
      );
    } catch (err) {
      this.logger.warn(`발행 측정 기록 실패: ${reviewJobId}`, err);
    }
  }
}
