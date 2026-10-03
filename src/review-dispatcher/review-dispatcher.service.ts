import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { ReviewFreshnessService } from '../review-freshness/review-freshness.service';
import { IdempotencyStore } from '../redis/idempotency.store';
import { JobStateStore } from '../redis/job-state.store';
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

    await Promise.all([
      this.jobStateStore.set(reviewJobId, 'requested'),
      this.reviewJobContextStore.set(reviewJobId, context),
    ]);

    try {
      await this.kafkaProducer.send(
        process.env.KAFKA_REVIEW_REQUEST_TOPIC!,
        payload,
        reviewJobId,
      );
    } catch (err) {
      this.logger.error(`Kafka 발행 실패: ${reviewJobId}`, err);
      throw err;
    }
  }
}
