// 도비가 AI 서버로 보내지 못해 리뷰되지 않은 파일과 그 사유(리뷰 본문 안내용).
export type UnreviewedReason =
  // 페이로드 크기 상한을 넘어 변경 내용(patch)을 제외함
  | 'patch-budget'
  // GitHub가 diff를 주지 않음(너무 큰 파일 등)
  | 'no-patch';

export interface UnreviewedFile {
  filePath: string;
  reason: UnreviewedReason;
}
