export interface CommentAnswerContext {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  rootCommentId: number;
}
