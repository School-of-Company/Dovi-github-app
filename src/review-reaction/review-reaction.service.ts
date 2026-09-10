import { Inject, Injectable, Logger } from '@nestjs/common';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';

// gemini-code-assist 등 다른 리뷰 봇처럼 "처리 중"임을 눈(eyes) 리액션으로 알리는 용도.
// 결과가 최종 리뷰/사용자 경험에 필수는 아니므로 실패해도 메인 플로우를 막지 않는다
// (호출부에서 fire-and-forget으로 사용, 실패 시 warn 로그만 남긴다).
@Injectable()
export class ReviewReactionService {
  private readonly logger = new Logger(ReviewReactionService.name);

  constructor(
    @Inject(INSTALLATION_TOKEN_MANAGER)
    private readonly installationTokenManager: InstallationTokenManager,
  ) {}

  async markPrInProgress(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<void> {
    const octokit =
      await this.installationTokenManager.getOctokit(installationId);
    await octokit.rest.reactions.createForIssue({
      owner,
      repo,
      issue_number: prNumber,
      content: 'eyes',
    });
  }

  async markReviewCommentInProgress(
    installationId: number,
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<void> {
    const octokit =
      await this.installationTokenManager.getOctokit(installationId);
    await octokit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content: 'eyes',
    });
  }

  notifyPrInProgress(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ): void {
    this.markPrInProgress(installationId, owner, repo, prNumber).catch(
      (err: unknown) => {
        this.logger.warn(`PR #${prNumber} 👀 리액션 추가 실패`, err);
      },
    );
  }

  notifyReviewCommentInProgress(
    installationId: number,
    owner: string,
    repo: string,
    commentId: number,
  ): void {
    this.markReviewCommentInProgress(
      installationId,
      owner,
      repo,
      commentId,
    ).catch((err: unknown) => {
      this.logger.warn(`comment #${commentId} 👀 리액션 추가 실패`, err);
    });
  }
}
