export interface ReviewFailedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  installationId: number;
  reason: 'parse_error' | 'timeout' | 'server_error';
}
