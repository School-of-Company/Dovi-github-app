export type ChangedFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  filePath: string;
  status: ChangedFileStatus;
  patch?: string;
  // ai-server가 tree-sitter로 변경된 함수/클래스 전체를 리뷰 컨텍스트에 포함시키는
  // AST 기능(app/review/chunking.py)에 쓰인다. 없으면 hunk만으로 리뷰가 진행된다.
  content?: string;
}

// 멘션 답글로 재리뷰가 트리거된 경우에만 채워진다.
// 워커는 이 값이 있으면 답글 내용을 함께 고려해 리뷰한다.
export interface ReplyContext {
  commentId: number;
  inReplyToId: number | null;
  path: string;
  line: number | null;
  diffHunk: string;
  body: string;
  author: string;
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
  replyContext?: ReplyContext;
}
