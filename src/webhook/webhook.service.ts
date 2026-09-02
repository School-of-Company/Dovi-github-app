import { Injectable, Logger } from '@nestjs/common';
import { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReplyContext } from '../pr-data-collector/dto/review-request.payload';
import type { CommentAnswerRequestPayload } from '../comment-answer/dto/comment-answer-request.payload';

const ALLOWED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prDataCollectorService: PrDataCollectorService,
    private readonly reviewDispatcherService: ReviewDispatcherService,
    private readonly commentAnswerCollectorService: CommentAnswerCollectorService,
    private readonly commentAnswerDispatcherService: CommentAnswerDispatcherService,
  ) {}

  handle(event: string, payload: GithubWebhookPayload): void {
    if (event === 'pull_request') {
      this.handlePullRequest(payload);
      return;
    }
    if (event === 'pull_request_review_comment') {
      this.handleReviewComment(payload);
      return;
    }
  }

  private handlePullRequest(payload: GithubWebhookPayload): void {
    if (!this.shouldProcessPullRequest(payload)) return;

    const ownerRepo = this.parseOwnerRepo(payload.repository.full_name);
    if (!ownerRepo) return;
    const [owner, repo] = ownerRepo;

    this.prDataCollectorService
      .collect({
        installationId: payload.installation!.id,
        owner,
        repo,
        prNumber: payload.pull_request!.number,
        headSha: payload.pull_request!.head.sha,
        baseSha: payload.pull_request!.base.sha,
        repositoryId: payload.repository.id,
      })
      .then((result) => {
        if (result === null) {
          this.logger.warn(
            `PR #${payload.pull_request!.number} 수집 스킵 (diff 크기 초과)`,
          );
          return;
        }
        return this.reviewDispatcherService.dispatch(result, {
          owner,
          repo,
          prNumber: payload.pull_request!.number,
          installationId: payload.installation!.id,
        });
      })
      .catch((err: unknown) => {
        this.logger.error(
          `PR 데이터 수집/리뷰 발행 실패 (PR #${payload.pull_request!.number})`,
          err,
        );
      });
  }

  // 봇 멘션 답글이 오면 두 가지로 분기한다.
  // (1) 리뷰 스레드 답글(in_reply_to_id 있음) → 해당 스레드만 읽는 가벼운 Q&A 플로우
  // (2) 그 외 최상위 코멘트 멘션 → 기존처럼 전체 리뷰 파이프라인 재실행
  private handleReviewComment(payload: GithubWebhookPayload): void {
    if (!this.shouldProcessReviewComment(payload)) return;

    const ownerRepo = this.parseOwnerRepo(payload.repository.full_name);
    if (!ownerRepo) return;
    const [owner, repo] = ownerRepo;

    const comment = payload.comment!;
    const pr = payload.pull_request!;

    if (comment.in_reply_to_id) {
      this.handleThreadReplyMention(payload, owner, repo, comment, pr);
      return;
    }

    const replyContext: ReplyContext = {
      commentId: comment.id,
      inReplyToId: null,
      path: comment.path,
      line: comment.line,
      diffHunk: comment.diff_hunk,
      body: comment.body,
      author: payload.sender.login,
    };

    this.prDataCollectorService
      .collect({
        installationId: payload.installation!.id,
        owner,
        repo,
        prNumber: pr.number,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        repositoryId: payload.repository.id,
      })
      .then((result) => {
        if (result === null) {
          this.logger.warn(
            `PR #${pr.number} 수집 스킵 (diff 크기 초과, 멘션 답글)`,
          );
          return;
        }
        // 같은 커밋에 멘션만 반복돼도 매번 새 리뷰가 돌도록
        // commentId를 섞어 별도 job으로 만든다 (idempotency 우회).
        return this.reviewDispatcherService.dispatch(
          {
            ...result,
            reviewJobId: `${result.reviewJobId}_c${comment.id}`,
            replyContext,
          },
          {
            owner,
            repo,
            prNumber: pr.number,
            installationId: payload.installation!.id,
          },
        );
      })
      .catch((err: unknown) => {
        this.logger.error(
          `멘션 답글 재리뷰 실패 (comment #${comment.id})`,
          err,
        );
      });
  }

  private handleThreadReplyMention(
    payload: GithubWebhookPayload,
    owner: string,
    repo: string,
    comment: NonNullable<GithubWebhookPayload['comment']>,
    pr: NonNullable<GithubWebhookPayload['pull_request']>,
  ): void {
    const rootCommentId = comment.in_reply_to_id!;
    const installationId = payload.installation!.id;

    this.commentAnswerCollectorService
      .collectThread(installationId, owner, repo, pr.number, rootCommentId)
      .then((thread) => {
        // 같은 스레드에 멘션이 여러 번 달려도 매번 새 job으로 처리되도록
        // 트리거한 코멘트의 id를 그대로 job id에 사용한다.
        const commentJobId = `qa:${payload.repository.id}:${pr.number}:${comment.id}`;
        const requestPayload: CommentAnswerRequestPayload = {
          commentJobId,
          repositoryId: payload.repository.id,
          prNumber: pr.number,
          path: comment.path,
          line: comment.line,
          diffHunk: comment.diff_hunk,
          thread,
        };

        return this.commentAnswerDispatcherService.dispatch(requestPayload, {
          owner,
          repo,
          prNumber: pr.number,
          installationId,
          rootCommentId,
        });
      })
      .catch((err: unknown) => {
        this.logger.error(
          `코멘트 스레드 Q&A 발행 실패 (comment #${comment.id})`,
          err,
        );
      });
  }

  private shouldProcessPullRequest(payload: GithubWebhookPayload): boolean {
    return (
      !!payload.installation &&
      !!payload.pull_request &&
      ALLOWED_PR_ACTIONS.has(payload.action) &&
      !payload.pull_request.draft &&
      payload.sender.type === 'User'
    );
  }

  private shouldProcessReviewComment(payload: GithubWebhookPayload): boolean {
    if (
      payload.action !== 'created' ||
      !payload.installation ||
      !payload.pull_request ||
      !payload.comment ||
      // 루프 방지: 봇(GitHub App) 자신의 답글은 sender.type === 'Bot' 이라 자동 제외
      payload.sender.type !== 'User'
    ) {
      return false;
    }
    return this.mentionsBot(payload.comment.body);
  }

  private mentionsBot(body: string): boolean {
    const botLogin = process.env.GITHUB_BOT_LOGIN;
    if (!botLogin) {
      this.logger.warn(
        'GITHUB_BOT_LOGIN 미설정으로 코멘트 멘션 처리를 건너뜁니다.',
      );
      return false;
    }
    // GitHub 사용자명은 영숫자·하이픈만 허용한다. 멘션 뒤에 그런 문자가
    // 이어지면(예: @dovi-code-assist-dev) 다른 대상이므로 매칭에서 제외한다.
    const escaped = botLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = new RegExp(`@${escaped}(?![a-zA-Z0-9-])`, 'i');
    return mention.test(body);
  }

  private parseOwnerRepo(fullName: string): [string, string] | null {
    const parts = fullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      this.logger.error(`올바르지 않은 repository full_name: ${fullName}`);
      return null;
    }
    return [parts[0], parts[1]];
  }
}
