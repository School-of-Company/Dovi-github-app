export interface ReviewFailedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  reason: 'parse_error' | 'timeout' | 'server_error';
}
