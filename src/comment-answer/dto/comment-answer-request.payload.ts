export interface ThreadComment {
  commentId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface CommentAnswerRequestPayload {
  commentJobId: string;
  repositoryId: number;
  prNumber: number;
  path: string;
  line: number | null;
  diffHunk: string;
  thread: ThreadComment[];
}
