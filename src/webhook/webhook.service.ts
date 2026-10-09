import { Injectable, Logger } from '@nestjs/common';
import { DicoshotService } from 'dicoshot-nest';
import type { CustomMessageOptions } from 'dicoshot-nest';
import { describeError } from '../common/describe-error';
import { PrDataCollectorService } from '../pr-data-collector/pr-data-collector.service';
import { ReviewDispatcherService } from '../review-dispatcher/review-dispatcher.service';
import { CommentAnswerCollectorService } from '../comment-answer/comment-answer-collector.service';
import { CommentAnswerDispatcherService } from '../comment-answer/comment-answer-dispatcher.service';
import { RepoIndexCollectorService } from '../repo-index/repo-index-collector.service';
import { RepoIndexDispatcherService } from '../repo-index/repo-index-dispatcher.service';
import { ReviewFeedbackDispatcherService } from '../review-feedback/review-feedback-dispatcher.service';
import { classifyReflection } from '../review-feedback/reflection-classifier';
import { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import { ReviewReactionService } from '../review-reaction/review-reaction.service';
import { ReviewCommandGuardService } from './review-command-guard.service';
import { SandboxProbeDispatcherService } from '../sandbox-probe/sandbox-probe-dispatcher.service';
import { isForkPr } from './fork-pr.util';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';
import type { ReplyContext } from '../pr-data-collector/dto/review-request.payload';
import type { CommentAnswerRequestPayload } from '../comment-answer/dto/comment-answer-request.payload';

// 자동 AI 리뷰는 PR이 리뷰 가능해지는 시점에만 돈다. push(synchronize)마다 전체 리뷰를
// 돌리면 사소한 커밋에도 매번 AI 비용/대기가 들고 PR 대화창이 번잡해지므로, 이후 재리뷰는
// 명시적 요청(@멘션, /dovi review)에 맡긴다. ready_for_review는 draft로 열었다가 준비
// 완료로 전환한 PR의 첫 리뷰다.
const AUTO_REVIEW_PR_ACTIONS = new Set([
  'opened',
  'reopened',
  'ready_for_review',
]);
// 샌드박스 프로브(빌드/기동 검증)는 커밋마다 검증해야 하므로 push도 대상이다.
const SANDBOX_PROBE_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
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
    private readonly reviewReactionService: ReviewReactionService,
    private readonly sandboxProbeDispatcherService: SandboxProbeDispatcherService,
    private readonly reviewCommandGuard: ReviewCommandGuardService,
    private readonly dicoshot: DicoshotService,
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

    // 메인 리뷰 발행과 완전히 독립된 경로 — 샌드박스 프로브 발행 여부 판단이나
    // 발행 자체가 실패해도 메인 리뷰에는 전혀 영향을 주지 않는다.
    if (SANDBOX_PROBE_PR_ACTIONS.has(payload.action)) {
      this.sandboxProbeDispatcherService.notifyPrOpened({
        installationId: payload.installation!.id,
        owner,
        repo,
        repositoryId: payload.repository.id,
        defaultBranch: payload.repository.default_branch,
        prNumber: payload.pull_request!.number,
        headSha: payload.pull_request!.head.sha,
        baseSha: payload.pull_request!.base.sha,
        isFork: isForkPr(payload),
      });
    }

    // push(synchronize)는 프로브만 검토하고, AI 리뷰는 요청이 있을 때만 실행한다.
    if (!AUTO_REVIEW_PR_ACTIONS.has(payload.action)) return;

    this.reviewReactionService.notifyPrInProgress(
      payload.installation!.id,
      owner,
      repo,
      payload.pull_request!.number,
    );

    const collectStartedAt = Date.now();
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
          collectStartedAt,
        });
      })
      .catch((err: unknown) => {
        const prNumber = payload.pull_request!.number;
        this.logger.error(
          `PR 데이터 수집/리뷰 발행 실패 (PR #${prNumber})`,
          err,
        );
        this.notifyCollectionFailure('PR 리뷰', owner, repo, prNumber, err);
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

    // 멘션 답글도 AI 리뷰/답변을 일으키므로 권한 없는 사용자의 호출은 막는다.
    void this.authorizeCommand(
      payload,
      owner,
      repo,
      payload.pull_request!.number,
      payload.pull_request!.user?.login,
      '리뷰 스레드 멘션',
    ).then((allowed) => {
      if (allowed) this.runReviewCommentCommand(payload, owner, repo);
    });
  }

  private runReviewCommentCommand(
    payload: GithubWebhookPayload,
    owner: string,
    repo: string,
  ): void {
    const comment = payload.comment!;
    const pr = payload.pull_request!;
    const collectStartedAt = Date.now();

    if (comment.in_reply_to_id) {
      this.handleThreadReplyMention(payload, owner, repo, comment, pr);
      return;
    }

    this.reviewReactionService.notifyReviewCommentInProgress(
      payload.installation!.id,
      owner,
      repo,
      comment.id,
    );

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
            collectStartedAt,
          },
        );
      })
      .catch((err: unknown) => {
        this.logger.error(
          `멘션 답글 재리뷰 실패 (comment #${comment.id})`,
          err,
        );
        this.notifyCollectionFailure(
          '멘션 답글 재리뷰',
          owner,
          repo,
          pr.number,
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

    this.reviewReactionService.notifyReviewCommentInProgress(
      installationId,
      owner,
      repo,
      comment.id,
    );

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
        this.notifyCollectionFailure('코멘트 Q&A', owner, repo, pr.number, err);
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

  // PR 대화창(리뷰 코멘트가 아닌 일반 코멘트)에 "/dovi review" 명령을 남기거나
  // 봇을 멘션(@dovi-code-assist)하면 전체 리뷰 파이프라인을 재실행한다 —
  // Gemini Code Assist처럼 다시 태그하면 재리뷰하는 UX. webhook payload에
  // head/base sha가 없어 pr-data-collector가 PR 번호로 직접 조회한다.
  private handleIssueComment(payload: GithubWebhookPayload): void {
    if (!this.shouldProcessIssueComment(payload)) return;

    const ownerRepo = this.parseOwnerRepo(payload.repository.full_name);
    if (!ownerRepo) return;
    const [owner, repo] = ownerRepo;

    // 이 명령은 코멘트마다 새 AI 리뷰를 돌리므로(멱등성 우회) 권한과 쿨다운을 먼저 확인한다.
    void this.authorizeCommand(
      payload,
      owner,
      repo,
      payload.issue!.number,
      payload.issue!.user?.login,
      '/dovi review',
    ).then((allowed) => {
      if (allowed) this.runReviewCommand(payload, owner, repo);
    });
  }

  private runReviewCommand(
    payload: GithubWebhookPayload,
    owner: string,
    repo: string,
  ): void {
    const prNumber = payload.issue!.number;
    const installationId = payload.installation!.id;
    const commentId = payload.comment!.id;
    const collectStartedAt = Date.now();

    this.reviewReactionService.notifyIssueCommentInProgress(
      installationId,
      owner,
      repo,
      commentId,
    );

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
          { owner, repo, prNumber, installationId, collectStartedAt },
        );
      })
      .catch((err: unknown) => {
        this.logger.error(`/dovi review 재실행 실패 (PR #${prNumber})`, err);
        this.notifyCollectionFailure(
          '/dovi review',
          owner,
          repo,
          prNumber,
          err,
        );
      });
  }

  // 명령 실행 권한(PR 작성자 또는 Write 이상)과 PR별 쿨다운을 확인한다. 거부 사유는
  // 사용자에게 알리지 않고 로그만 남긴다(거부된 사용자가 봇을 시험하며 노이즈를 만들지 못하게).
  private async authorizeCommand(
    payload: GithubWebhookPayload,
    owner: string,
    repo: string,
    prNumber: number,
    prAuthor: string | undefined,
    command: string,
  ): Promise<boolean> {
    const decision = await this.reviewCommandGuard.check({
      installationId: payload.installation!.id,
      owner,
      repo,
      repositoryId: payload.repository.id,
      prNumber,
      commenter: payload.sender.login,
      prAuthor,
    });
    if (decision !== 'allowed') {
      this.logger.warn(
        `${command} 무시(${decision}): ${owner}/${repo}#${prNumber} by ${payload.sender.login}`,
      );
    }
    return decision === 'allowed';
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
    const body = payload.comment.body;
    return (
      body.trim().toLowerCase() === REVIEW_COMMAND || this.mentionsBot(body)
    );
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
      (AUTO_REVIEW_PR_ACTIONS.has(payload.action) ||
        SANDBOX_PROBE_PR_ACTIONS.has(payload.action)) &&
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

  // 웹훅 수신 직후 리액션(👀)은 이미 달렸는데 그 뒤 수집/발행이 조용히 실패하면,
  // 사용자 입장에선 "반응은 했는데 리뷰가 영원히 안 오는" 상태로 남아 아무도
  // 알아채지 못한다. 재시도로도 못 넘긴 실패는 Discord로 눈에 띄게 알린다.
  private notifyCollectionFailure(
    stage: string,
    owner: string,
    repo: string,
    prNumber: number,
    err: unknown,
  ): void {
    void this.safeNotify({
      title: '리뷰 트리거 실패',
      description:
        `${owner}/${repo}#${prNumber} (${stage}): ` +
        `${describeError(err)}\n` +
        `PR에 @dovi-code-assist 멘션하면 재시도됩니다.`,
      color: 'danger',
    });
  }

  private async safeNotify(message: CustomMessageOptions): Promise<void> {
    try {
      await this.dicoshot.sendCustom(message);
    } catch (notifyErr) {
      this.logger.warn('Discord 알림 전송 실패', notifyErr);
    }
  }
}
