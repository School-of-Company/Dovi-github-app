export interface ReviewCompletedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  summary: string;
  reviews: {
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    confidence: number;
    filePath: string;
    line: number;
    title: string;
    message: string;
    evidence: string[];
    suggestedFix?: string;
    // ai-server가 계산한 발생 지문(Dovi-ai-server#132, 선택). 없으면 title/evidence로 직접 계산한다.
    fingerprint?: string;
  }[];
  modelVersion: string;
  promptVersion: string;
}
