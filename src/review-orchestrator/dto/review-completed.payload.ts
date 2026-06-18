export interface ReviewCompletedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  installationId: number;
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
  }[];
}
