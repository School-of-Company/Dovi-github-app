import { Injectable, Logger } from '@nestjs/common';
import { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import { RepoIndexCollectorService } from '../repo-index/repo-index-collector.service';
import { RepoIndexDispatcherService } from '../repo-index/repo-index-dispatcher.service';
import { ReviewFeedbackDispatcherService } from '../review-feedback/review-feedback-dispatcher.service';
import { classifyReflection } from '../review-feedback/reflection-classifier';
import { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReplyContext } from '../pr-data-collector/dto/review-request.payload';
import type { CommentAnswerRequestPayload } from '../comment-answer/dto/comment-answer-request.payload';

const ALLOWED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
const REVIEW_COMMAND = '/dovi review';
// branch/tag가 삭제된 push 이벤트는 after가 이 값으로 온다.
const EMPTY_SHA = '0'.repeat(40);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prDataCollectorService: PrDataCollectorService,
    private readonly reviewDispatcherService: ReviewDispatcherService,
    private readonly commentAnswerCollectorService: CommentAnswerCollectorService,
    private readonly commentAnswerDispatcherService: CommentAnswerDispatcherService,
    private readonly repoIndexCollectorService: RepoIndexCollectorService,
    private readonly repoIndexDispatcherService: RepoIndexDispatcherService,
    private readonly reviewFeedbackDispatcherService: ReviewFeedbackDispatcherService,
    private readonly reviewCommentFindingStore: ReviewCommentFindingStore,
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
    if (event === 'issue_comment') {
      this.handleIssueComment(payload);
      return;
    }
    if (event === 'push') {
      this.handlePush(payload);
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
        prTitle: payload.pull_request!.title,
        prBody: payload.pull_request!.body ?? '',
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
    // 반영 여부 감지는 봇 멘션과 무관하게 항상 시도한다 (Q&A/재리뷰와는 별개 신호).
    this.detectReviewFeedback(payload);

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
        prTitle: pr.title,
        prBody: pr.body ?? '',
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

  // 리뷰 코멘트 스레드에 달린 답글(봇 멘션 여부 무관)을 텍스트 휴리스틱으로
  // 분석해 "반영했다/안 했다"로 읽히면 pr.comment.reflected를 발행한다.
  // 원본 코멘트가 우리 봇이 남긴 리뷰 코멘트인 경우만 대상이며(Redis 매핑 존재),
  // 애매한 텍스트는 조용히 무시한다(false positive 방지가 신호 누락보다 중요).
  private detectReviewFeedback(payload: GithubWebhookPayload): void {
    const comment = payload.comment;
    if (
      payload.action !== 'created' ||
      !comment ||
      !comment.in_reply_to_id ||
      // 루프 방지: 봇 자신의 답글은 sender.type === 'Bot'
      payload.sender.type !== 'User'
    ) {
      return;
    }

    const classification = classifyReflection(comment.body);
    if (!classification) return;

    const rootCommentId = comment.in_reply_to_id;
    this.reviewCommentFindingStore
      .get(rootCommentId)
      .then((finding) => {
        if (!finding) return;
        return this.reviewFeedbackDispatcherService.dispatch(
          {
            reviewJobId: finding.reviewJobId,
            findingIndex: finding.findingIndex,
            reflected: classification.reflected,
            reason: classification.reason,
          },
          comment.id,
        );
      })
      .catch((err: unknown) => {
        this.logger.error(
          `리뷰 반영 여부 신호 처리 실패 (comment #${comment.id})`,
          err,
        );
      });
  }

  // PR 대화창에 "/dovi review"만 남기면(리뷰 코멘트가 아닌 일반 코멘트) 전체
  // 리뷰 파이프라인을 재실행한다. webhook payload에 head/base sha가 없어
  // pr-data-collector가 PR 번호로 직접 조회한다.
  private handleIssueComment(payload: GithubWebhookPayload): void {
    if (!this.shouldProcessIssueComment(payload)) return;

    const ownerRepo = this.parseOwnerRepo(payload.repository.full_name);
    if (!ownerRepo) return;
    const [owner, repo] = ownerRepo;

    const prNumber = payload.issue!.number;
    const installationId = payload.installation!.id;
    const commentId = payload.comment!.id;

    this.prDataCollectorService
      .collectByPrNumber(
        installationId,
        owner,
        repo,
        prNumber,
        payload.repository.id,
      )
      .then((result) => {
        if (result === null) {
          this.logger.warn(
            `PR #${prNumber} 수집 스킵 (diff 크기 초과, /dovi review)`,
          );
          return;
        }
        // 같은 커밋에 명령이 반복돼도 매번 새 리뷰가 돌도록
        // commentId를 섞어 별도 job으로 만든다 (idempotency 우회).
        return this.reviewDispatcherService.dispatch(
          { ...result, reviewJobId: `${result.reviewJobId}_c${commentId}` },
          { owner, repo, prNumber, installationId },
        );
      })
      .catch((err: unknown) => {
        this.logger.error(`/dovi review 재실행 실패 (PR #${prNumber})`, err);
      });
  }

  private shouldProcessIssueComment(payload: GithubWebhookPayload): boolean {
    if (
      payload.action !== 'created' ||
      !payload.installation ||
      !payload.issue?.pull_request ||
      !payload.comment ||
      // 루프 방지: 봇(GitHub App) 자신의 코멘트는 sender.type === 'Bot' 이라 자동 제외
      payload.sender.type !== 'User'
    ) {
      return false;
    }
    return payload.comment.body.trim().toLowerCase() === REVIEW_COMMAND;
  }

  // Index Branch(DOVI.md에 명시, 없으면 default_branch)로 push될 때만 반응해
  // repo.index.requested를 발행한다 (RAG용 증분 인덱싱 트리거).
  private handlePush(payload: GithubWebhookPayload): void {
    if (
      !payload.installation ||
      !payload.ref ||
      !payload.before ||
      !payload.after ||
      payload.after === EMPTY_SHA
    ) {
      return;
    }

    const ownerRepo = this.parseOwnerRepo(payload.repository.full_name);
    if (!ownerRepo) return;
    const [owner, repo] = ownerRepo;

    const installationId = payload.installation.id;
    const pushedBranch = payload.ref.replace(/^refs\/heads\//, '');
    const before = payload.before;
    const after = payload.after;
    const repositoryId = payload.repository.id;

    this.repoIndexCollectorService
      .resolveIndexBranch(
        installationId,
        owner,
        repo,
        payload.repository.default_branch,
      )
      .then((indexBranch) => {
        if (pushedBranch !== indexBranch) return;

        return this.repoIndexCollectorService
          .collect(
            installationId,
            owner,
            repo,
            repositoryId,
            pushedBranch,
            before,
            after,
          )
          .then((result) => {
            if (result === null) return;
            return this.repoIndexDispatcherService.dispatch(result);
          });
      })
      .catch((err: unknown) => {
        this.logger.error(
          `repo 인덱싱 트리거 실패: ${owner}/${repo}@${pushedBranch}`,
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
