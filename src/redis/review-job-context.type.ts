export interface ReviewJobContext {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  // 증분 리뷰(#94)일 때만 채워진다. 게시 단계가 이전 리뷰의 코멘트 중 이번에 다시 보지 않은
  // 파일의 것을 지우지 않고, 본문에 증분임을 밝히는 데 쓴다.
  /** 이전에 리뷰한 커밋. 이 커밋 이후의 변경만 리뷰했다. */
  incrementalBase?: string;
  /** 이번 요청에서 리뷰한 파일 경로 */
  incrementalPaths?: string[];
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
