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

export interface ReviewRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  diff: string;
  changedFiles: ChangedFile[];
  replyContext?: ReplyContext;
}
