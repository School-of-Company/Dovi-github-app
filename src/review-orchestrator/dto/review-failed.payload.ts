export interface ReviewFailedPayload {
  reviewJobId: string;
  headSha: string;
  reason:
    | 'parse_error'
    | 'timeout'
    | 'server_error'
    | 'context_overflow'
    | 'output_truncated';
}
