import { Logger } from '@nestjs/common';
import { ReviewDispatcherService } from './review-dispatcher.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { JobStateStore } from '../redis/job-state.store';
import type { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ReviewInflightStore } from '../redis/review-inflight.store';
import type { ReviewFreshnessService } from '../review-freshness/review-freshness.service';
import type { ReviewRequestPayload } from '../pr-data-collector/dto/review-request.payload';
import type { ReviewJobContext } from '../redis/review-job-context.type';

describe('ReviewDispatcherService', () => {
  const payload: ReviewRequestPayload = {
    reviewJobId: '1:1:sha',
    repositoryId: 1,
    prNumber: 1,
    prTitle: 'PR 제목',
    prBody: 'PR 본문',
    headSha: 'sha',
    baseSha: 'base-sha',
    contextFiles: [],
    changedFiles: [],
  };

  const context: ReviewJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    installationId: 123,
  };

  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let jobStateStore: { get: jest.Mock; set: jest.Mock };
  let reviewJobContextStore: { set: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let reviewFreshness: { findStaleReason: jest.Mock };
  let reviewInflightStore: { enter: jest.Mock };
  let service: ReviewDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_REVIEW_REQUEST_TOPIC = 'pr.review.requested';

    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    jobStateStore = { get: jest.fn(), set: jest.fn() };
    reviewJobContextStore = { set: jest.fn() };
    kafkaProducer = { send: jest.fn() };
    reviewFreshness = { findStaleReason: jest.fn().mockResolvedValue(null) };
    reviewInflightStore = { enter: jest.fn().mockResolvedValue(2) };

    service = new ReviewDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      jobStateStore as unknown as JobStateStore,
      reviewJobContextStore as unknown as ReviewJobContextStore,
      kafkaProducer as unknown as KafkaProducerService,
      reviewFreshness as unknown as ReviewFreshnessService,
      reviewInflightStore as unknown as ReviewInflightStore,
    );
  });

  it('idempotency에 이미 존재하면 발행하지 않고 스킵한다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).not.toHaveBeenCalled();
    expect(reviewJobContextStore.set).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it.each(['completed', 'processing'] as const)(
    'jobState가 %s면 발행하지 않고 스킵한다',
    async (state) => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(state);

      await service.dispatch(payload, context);

      expect(jobStateStore.set).not.toHaveBeenCalled();
      expect(reviewJobContextStore.set).not.toHaveBeenCalled();
      expect(kafkaProducer.send).not.toHaveBeenCalled();
    },
  );

  it.each(['closed', 'head-changed'] as const)(
    '수집하는 동안 PR이 오래됐으면(%s) 발행하지 않고 상태·컨텍스트도 남기지 않는다',
    async (reason) => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(null);
      reviewFreshness.findStaleReason.mockResolvedValue(reason);

      await service.dispatch(payload, context);

      expect(reviewFreshness.findStaleReason).toHaveBeenCalledWith(context, {
        repositoryId: payload.repositoryId,
        headSha: payload.headSha,
      });
      expect(kafkaProducer.send).not.toHaveBeenCalled();
      expect(jobStateStore.set).not.toHaveBeenCalled();
      expect(reviewJobContextStore.set).not.toHaveBeenCalled();
    },
  );

  it('이미 처리된 job은 PR 상태를 조회하지 않고 먼저 스킵한다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload, context);

    expect(reviewFreshness.findStaleReason).not.toHaveBeenCalled();
  });

  it('중복이 아니면 requested 상태와 job context를 저장한 후 발행한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      'requested',
    );
    expect(reviewJobContextStore.set).toHaveBeenCalledWith(
      payload.reviewJobId,
      expect.objectContaining(context),
    );
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.review.requested',
      payload,
      payload.reviewJobId,
    );
  });

  describe('단계별 지연 측정 (#93)', () => {
    const withPatches = {
      ...payload,
      changedFiles: [
        {
          filePath: 'a.ts',
          status: 'modified' as const,
          patch: '@@ -1 +1 @@\n+가나',
        },
        { filePath: 'b.ts', status: 'added' as const },
      ],
    };

    it('발행 시각과 요청 크기(파일 수, patch 바이트)를 컨텍스트에 남긴다', async () => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(null);
      const before = Date.now();

      await service.dispatch(withPatches, {
        ...context,
        collectStartedAt: before - 500,
      });

      const saved = (
        reviewJobContextStore.set.mock.calls as [
          string,
          Record<string, number>,
        ][]
      )[0][1];
      expect(saved.dispatchedAt).toBeGreaterThanOrEqual(before);
      expect(saved.collectStartedAt).toBe(before - 500);
      expect(saved.files).toBe(2);
      // patch는 UTF-8 바이트로 센다(한글 2글자 = 6바이트 + 나머지 ASCII 12바이트)
      expect(saved.patchBytes).toBe(Buffer.byteLength('@@ -1 +1 @@\n+가나'));
    });

    it('발행 후 진행 중 job 수와 함께 한 줄 로그를 남긴다', async () => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(null);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      await service.dispatch(withPatches, {
        ...context,
        collectStartedAt: Date.now() - 1000,
      });

      expect(reviewInflightStore.enter).toHaveBeenCalledWith(
        payload.reviewJobId,
      );
      const logged = (log.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toMatch(
        /review dispatched reviewJobId=\S+ collect=\d+ms files=2 patchBytes=\d+ inflight=2/,
      );
      log.mockRestore();
    });

    it('진행 중 job 기록(Redis)이 실패해도 발행은 정상 완료된다', async () => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(null);
      reviewInflightStore.enter.mockRejectedValue(new Error('redis down'));

      await expect(
        service.dispatch(withPatches, context),
      ).resolves.toBeUndefined();

      expect(kafkaProducer.send).toHaveBeenCalledTimes(1);
    });

    it('수집 시작 시각이 없는 컨텍스트도 발행은 되고 로그의 collect는 n/a다', async () => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(null);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      await service.dispatch(payload, context);

      const logged = (log.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('collect=n/a');
      log.mockRestore();
    });
  });

  it('Kafka 발행이 실패하면 에러를 throw한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload, context)).rejects.toThrow(
      'kafka down',
    );
  });
});
