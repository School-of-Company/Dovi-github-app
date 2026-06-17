export interface ChangedFile {
  filename: string;
  status:
    | 'added'
    | 'modified'
    | 'removed'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged';
  patch?: string;
}

export interface ReviewRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  diff: string;
  changedFiles: ChangedFile[];
}
