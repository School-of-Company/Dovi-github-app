export type SandboxProbeStatus = 'passed' | 'found_issue' | 'inconclusive';
export type SandboxProbeType = 'init_order' | 'lifecycle' | 'build';

// ReviewComment(ai-server가 메인 리뷰에서 쓰는 finding 타입)를 재사용하지 않는다 —
// 거긴 line: number(gt=0)가 필수인데, "생명주기 훅 누락"류 버그는 가리킬 특정
// 라인이 없다.
export interface SandboxProbeFinding {
  probe: SandboxProbeType;
  title: string;
  message: string;
  filePath: string | null;
  line: number | null;
  evidence: string;
}

export interface SandboxProbeCompletedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  status: SandboxProbeStatus;
  evidence: string;
  findings: SandboxProbeFinding[];
}
