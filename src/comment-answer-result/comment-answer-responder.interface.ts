import type { CommentAnswerCompletedPayload } from './dto/comment-answer-completed.payload';
import type { CommentAnswerFailedPayload } from './dto/comment-answer-failed.payload';

export const COMMENT_ANSWER_RESPONDER = 'COMMENT_ANSWER_RESPONDER';

export interface CommentAnswerResponder {
  handle(
    payload: CommentAnswerCompletedPayload | CommentAnswerFailedPayload,
  ): Promise<void>;
}
