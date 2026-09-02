import { Inject, Injectable } from '@nestjs/common';
import { withRetry } from '../common/retry';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { ThreadComment } from './dto/comment-answer-request.payload';

@Injectable()
export class CommentAnswerCollectorService {
  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
  ) {}

  // GitHub 리뷰 코멘트 스레드의 답글들은 모두 스레드 첫 코멘트(rootCommentId)를
  // in_reply_to_id로 가리키므로, 그 값으로 스레드 전체를 모아 시간순으로 정렬한다.
  async collectThread(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
    rootCommentId: number,
  ): Promise<ThreadComment[]> {
    const octokit =
      await this.installationTokenManager.getOctokit(installationId);

    const comments = await withRetry(() =>
      octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    );

    return comments
      .filter(
        (comment) =>
          comment.id === rootCommentId ||
          comment.in_reply_to_id === rootCommentId,
      )
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      .map((comment) => ({
        commentId: comment.id,
        author: comment.user?.login ?? 'unknown',
        body: comment.body,
        createdAt: comment.created_at,
      }));
  }
}
