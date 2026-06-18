export interface ReviewFailedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  installationId: number;
  reason: 'parse_error' | 'timeout' | 'server_error';
}
