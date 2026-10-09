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
  prTitle: string;
  prBody: string;
  headSha: string;
  baseSha: string;
  contextFiles: ContextFile[];
  changedFiles: ChangedFile[];
  replyContext?: ReplyContext;
  // 증분 리뷰(#94)일 때만 채워진다. changedFiles는 previousHeadSha 이후 바뀐 파일만이다.
  // ai-server는 아직 읽지 않는다(없는 필드는 무시) — 도비의 발행·게시 단계가 쓴다.
  incremental?: boolean;
  previousHeadSha?: string;
}
