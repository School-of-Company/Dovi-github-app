export type RepoIndexFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface RepoIndexChangedFile {
  filePath: string;
  status: RepoIndexFileStatus;
  content?: string;
}

export interface RepoIndexRequestPayload {
  repositoryId: number;
  branch: string;
  headSha: string;
  changedFiles: RepoIndexChangedFile[];
}
