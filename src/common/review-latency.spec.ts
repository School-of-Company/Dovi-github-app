import { formatReviewLatency } from './review-latency';
import type { ReviewJobContext } from '../redis/review-job-context.type';

const base: ReviewJobContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 1,
  installationId: 10,
  collectStartedAt: 1_000,
  dispatchedAt: 4_000,
  files: 12,
  patchBytes: 34_567,
};

describe('formatReviewLatency', () => {
  it('수집/대기+추론/게시/전체 구간을 키=값 한 줄로 만든다', () => {
    const line = formatReviewLatency({
      reviewJobId: '1:1:abc',
      outcome: 'published',
      context: base,
      resultReceivedAt: 64_000,
      finishedAt: 67_000,
      inflight: 2,
    });

    expect(line).toBe(
      'review latency reviewJobId=1:1:abc outcome=published collect=3000ms awaitAi=60000ms publish=3000ms total=66000ms files=12 patchBytes=34567 inflight=2',
    );
  });

  it.each(['published', 'failed', 'stale', 'error'] as const)(
    'outcome %s 를 그대로 남긴다',
    (outcome) => {
      const line = formatReviewLatency({
        reviewJobId: 'j',
        outcome,
        context: base,
        resultReceivedAt: 5_000,
        finishedAt: 6_000,
      });

      expect(line).toContain(`outcome=${outcome}`);
    },
  );

  it('진행 중 job 수를 모르면 inflight를 생략한다', () => {
    const line = formatReviewLatency({
      reviewJobId: 'j',
      outcome: 'error',
      context: base,
      resultReceivedAt: 5_000,
      finishedAt: 6_000,
    });

    expect(line).not.toContain('inflight=');
  });

  it('파일 수·patch 크기를 모르면 해당 항목을 생략한다', () => {
    const line = formatReviewLatency({
      reviewJobId: 'j',
      outcome: 'published',
      context: { ...base, files: undefined, patchBytes: undefined },
      resultReceivedAt: 5_000,
      finishedAt: 6_000,
    });

    expect(line).not.toContain('files=');
    expect(line).not.toContain('patchBytes=');
  });

  it.each([
    ['수집 시작 시각이 없으면', { collectStartedAt: undefined }],
    ['발행 시각이 없으면', { dispatchedAt: undefined }],
  ])('%s(예전 컨텍스트) 측정할 수 없어 null을 돌려준다', (_label, override) => {
    const line = formatReviewLatency({
      reviewJobId: 'j',
      outcome: 'published',
      context: { ...base, ...override },
      resultReceivedAt: 5_000,
      finishedAt: 6_000,
    });

    expect(line).toBeNull();
  });

  it('서버 시계 차이로 음수가 나와도 0으로 보정한다', () => {
    const line = formatReviewLatency({
      reviewJobId: 'j',
      outcome: 'published',
      context: base,
      resultReceivedAt: 3_000, // 발행(4000)보다 이전
      finishedAt: 2_000,
    });

    expect(line).toContain('awaitAi=0ms');
    expect(line).toContain('publish=0ms');
    expect(line).not.toMatch(/=-\d/);
  });
});
