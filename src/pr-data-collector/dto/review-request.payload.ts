export type ChangedFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  filePath: string;
  status: ChangedFileStatus;
  patch?: string;
}

export interface ContextFile {
  path: string;
  content: string;
  source: string;
}

export interface ReviewRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  contextFiles: ContextFile[];
  changedFiles: ChangedFile[];
}
