export interface SandboxProbeRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  // owner/repo — clone에 필수. "한쪽만 쓰는 필드는 이벤트에 안 싣는다"는 기존
  // 컨벤션의 의도적 예외(ai-server가 실제로 clone에 소비).
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  // 스펙(클론 섹션): 워커가 잡을 실제로 시작하기 직전에 이 값으로 github-app에
  // contents:read 스코프 토큰을 요청한다(installation token은 Kafka에 절대
  // 싣지 않는다). 그 요청을 받을 github-app 쪽 엔드포인트/인증 방식은 아직
  // 별도 이슈로 설계가 필요하다 — installationId는 그 설계가 끝날 때까지도
  // 유효한, ai-server가 실제로 필요로 하는 최소 정보라 미리 포함해둔다.
  installationId: number;
}
