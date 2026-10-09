export interface ReviewJobContext {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  // 아래는 단계별 지연 측정(#93)용 선택 필드다. 이 기능 이전에 저장된 컨텍스트에는 없으므로
  // 모두 선택이고, 없으면 지연 로그만 건너뛴다.
  /** 데이터 수집을 시작한 시각(epoch ms). 웹훅 처리 시작과 사실상 같다. */
  collectStartedAt?: number;
  /** pr.review.requested를 Kafka로 보내기 직전 시각(epoch ms) */
  dispatchedAt?: number;
  /** 요청에 실린 변경 파일 수 */
  files?: number;
  /** 요청에 실린 patch 총 바이트. 큰 PR이 오래 걸리는지 상관을 보는 데 쓴다. */
  patchBytes?: number;
}
