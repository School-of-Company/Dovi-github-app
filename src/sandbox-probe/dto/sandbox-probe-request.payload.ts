export interface SandboxProbeRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  // owner/repo — clone에 필수. "한쪽만 쓰는 필드는 이벤트에 안 싣는다"는 기존
  // 컨벤션의 의도적 예외(ai-server가 실제로 clone에 소비).
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}
