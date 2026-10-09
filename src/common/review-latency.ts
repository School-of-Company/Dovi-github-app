import type { ReviewJobContext } from '../redis/review-job-context.type';

export type ReviewOutcome = 'published' | 'failed' | 'stale' | 'error';

interface LatencyInput {
  reviewJobId: string;
  outcome: ReviewOutcome;
  context: ReviewJobContext;
  /** 결과 이벤트를 받아 처리를 시작한 시각 */
  resultReceivedAt: number;
  /** 게시(또는 실패 처리)를 마친 시각 */
  finishedAt: number;
  /** 결과 처리 후 남은 진행 중 job 수 */
  inflight?: number;
}

// 한 줄 지연 로그. 운영 로그 며칠치로 수집/대기+추론/게시 비율과 P50/P95를 볼 수 있게 키=값
// 형태로 고정한다(#93).
//   collect  : 수집 시작 → 발행 직전 (웹훅 수신 후 GitHub에서 데이터를 모으는 시간)
//   awaitAi  : 발행 → 결과 수신 (큐 대기 + AI 추론. 내부 분해는 ai-server가 측정)
//   publish  : 결과 수신 → GitHub 게시 완료
//   total    : 수집 시작 → 게시 완료
// 단계 시각이 없는 예전 컨텍스트면 측정할 수 없으므로 null을 돌려준다(로그 건너뜀).
export function formatReviewLatency(input: LatencyInput): string | null {
  const { context } = input;
  if (
    context.collectStartedAt === undefined ||
    context.dispatchedAt === undefined
  ) {
    return null;
  }

  const collect = Math.max(0, context.dispatchedAt - context.collectStartedAt);
  const awaitAi = Math.max(0, input.resultReceivedAt - context.dispatchedAt);
  const publish = Math.max(0, input.finishedAt - input.resultReceivedAt);
  const total = Math.max(0, input.finishedAt - context.collectStartedAt);

  const parts = [
    `reviewJobId=${input.reviewJobId}`,
    `outcome=${input.outcome}`,
    `collect=${collect}ms`,
    `awaitAi=${awaitAi}ms`,
    `publish=${publish}ms`,
    `total=${total}ms`,
  ];
  if (context.files !== undefined) parts.push(`files=${context.files}`);
  if (context.patchBytes !== undefined) {
    parts.push(`patchBytes=${context.patchBytes}`);
  }
  if (input.inflight !== undefined) parts.push(`inflight=${input.inflight}`);
  return `review latency ${parts.join(' ')}`;
}
