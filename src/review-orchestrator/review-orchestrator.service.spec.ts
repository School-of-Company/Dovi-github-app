import { Logger } from '@nestjs/common';
import type { DicoshotService } from 'dicoshot-nest';
import { ReviewOrchestratorService } from './review-orchestrator.service';
import type { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import type { ReviewCommentFindingStore } from '../redis/review-comment-finding.store';
import type { PrimaryReviewStore } from '../redis/primary-review.store';
import type { ReviewFailureNoticeService } from './review-failure-notice.service';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('ReviewOrchestratorService', () => {
  let createReview: jest.Mock;
  let updateReview: jest.Mock;
  let createReviewComment: jest.Mock;
  let paginate: jest.Mock;
  // PR 파일 목록(listFiles) 응답. 기본값은 조회 실패 → 줄 검증을 건너뛰고 전부 인라인으로 시도.
  let listFiles: jest.Mock;
  let deleteReviewComment: jest.Mock;
  let installationTokenManager: {
    getOctokit: jest.Mock;
    getScopedToken: jest.Mock;
  };
  let reviewJobContextStore: { get: jest.Mock };
  let reviewCommentFindingStore: { set: jest.Mock };
  let primaryReviewStore: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
  let dicoshot: { sendCustom: jest.Mock };
  let reviewFailureNotice: { notify: jest.Mock; clear: jest.Mock };
  let service: ReviewOrchestratorService;

  const context: ReviewJobContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    installationId: 123,
  };

  const completedPayload: ReviewCompletedPayload = {
    reviewJobId: 'repo_1_sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    summary: 'ok',
    reviews: [],
    modelVersion: 'qwen2.5-coder-32b',
    promptVersion: 'v1',
  };

  const failedPayload: ReviewFailedPayload = {
    reviewJobId: 'repo_1_sha',
    headSha: 'sha',
    reason: 'timeout',
  };

  beforeEach(() => {
    delete process.env.GITHUB_BOT_LOGIN;
    createReview = jest.fn().mockResolvedValue({ data: { id: 555 } });
    updateReview = jest.fn().mockResolvedValue({ data: { id: 555 } });
    createReviewComment = jest.fn().mockResolvedValue({ data: { id: 777 } });
    paginate = jest.fn().mockResolvedValue([]);
    listFiles = jest.fn().mockRejectedValue(new Error('files unavailable'));
    deleteReviewComment = jest.fn().mockResolvedValue(undefined);
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: {
          pulls: {
            createReview,
            updateReview,
            createReviewComment,
            listFiles: 'listFiles',
            listReviewComments: 'listReviewComments',
            listCommentsForReview: 'listCommentsForReview',
            deleteReviewComment,
          },
        },
        // listFiles는 PR 파일 목록 전용 mock으로, 나머지(리뷰 코멘트 목록)는 paginate로 보낸다.
        paginate: (endpoint: unknown, params: unknown): Promise<unknown> =>
          endpoint === 'listFiles'
            ? (listFiles() as Promise<unknown>)
            : (paginate(endpoint, params) as Promise<unknown>),
      }),
      getScopedToken: jest.fn(),
    };
    reviewJobContextStore = { get: jest.fn().mockResolvedValue(context) };
    reviewCommentFindingStore = { set: jest.fn().mockResolvedValue(undefined) };
    primaryReviewStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    dicoshot = { sendCustom: jest.fn() };
    reviewFailureNotice = {
      notify: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReviewOrchestratorService(
      installationTokenManager,
      reviewJobContextStore as unknown as ReviewJobContextStore,
      reviewCommentFindingStore as unknown as ReviewCommentFindingStore,
      primaryReviewStore as unknown as PrimaryReviewStore,
      dicoshot as unknown as DicoshotService,
      reviewFailureNotice as unknown as ReviewFailureNoticeService,
    );
  });

  it('job context가 없으면 아무 것도 하지 않고 스킵한다', async () => {
    reviewJobContextStore.get.mockResolvedValue(null);

    await service.handle(completedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).not.toHaveBeenCalled();
  });

  it('failed payload는 리뷰를 등록하지 않고 Discord 알림 + PR 실패 안내를 보낸다', async () => {
    await service.handle(failedPayload);

    expect(createReview).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'AI 리뷰 분석 실패', color: 'danger' }),
    );
    expect(reviewFailureNotice.notify).toHaveBeenCalledWith(
      context,
      failedPayload,
    );
    expect(reviewFailureNotice.clear).not.toHaveBeenCalled();
  });

  it('리뷰 등록에 성공하면 이전 실패 안내 코멘트를 정리한다', async () => {
    await service.handle(completedPayload);

    expect(createReview).toHaveBeenCalled();
    expect(reviewFailureNotice.clear).toHaveBeenCalledWith(context);
  });

  it('리뷰 등록 자체가 실패하면 실패 안내 코멘트를 정리하지 않는다', async () => {
    createReview.mockRejectedValue(makeHttpError(422));

    await service.handle(completedPayload);

    expect(reviewFailureNotice.clear).not.toHaveBeenCalled();
  });

  it.each([
    ['context_overflow', 'PR이 너무 커서 컨텍스트에 담을 수 없음'],
    ['output_truncated', 'AI 출력이 잘려 복구도 실패'],
  ] as const)(
    'reason이 %s면 Discord 알림 설명에 사람이 읽을 문구를 포함한다',
    async (reason, expectedText) => {
      await service.handle({ ...failedPayload, reason });

      const call = dicoshot.sendCustom.mock.calls[0] as [
        { description: string },
      ];
      expect(call[0].description).toContain(expectedText);
    },
  );

  it('reviews가 빈 배열이면 summary만 담아 빈 comments로 createReview를 호출한다', async () => {
    await service.handle(completedPayload);

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        commit_id: 'sha',
        event: 'COMMENT',
        body: '# Code Review\n\nok',
        comments: [],
      }),
    );
    expect(primaryReviewStore.set).toHaveBeenCalledWith(1, 1, 555);
  });

  it('filePath/line이 유효하지 않은 finding은 제외하고 나머지만 등록한다', async () => {
    const valid: ReviewCompletedPayload['reviews'][number] = {
      severity: 'minor',
      confidence: 0.5,
      filePath: 'valid.ts',
      line: 5,
      title: 'valid',
      message: 'msg',
      evidence: [],
    };
    const invalidByEmptyPath = { ...valid, filePath: '' };
    const invalidByZeroLine = { ...valid, line: 0 };
    const payload: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [valid, invalidByEmptyPath, invalidByZeroLine],
    };

    await service.handle(payload);

    const [{ comments }] = createReview.mock.calls[0] as [
      { comments: { path: string }[] },
    ];
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe('valid.ts');
  });

  it('evidence/confidence가 누락된 finding이 와도 TypeError 없이 처리한다', async () => {
    const malformedReview = {
      severity: 'minor',
      filePath: 'a.ts',
      line: 1,
      title: 'malformed',
      message: 'msg',
    } as unknown as ReviewCompletedPayload['reviews'][number];
    const payload: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [malformedReview],
    };

    await expect(service.handle(payload)).resolves.toBeUndefined();
    expect(createReview).toHaveBeenCalled();
  });

  it('severity와 무관하게 suggestedFix는 항상 평문 "제안:" 텍스트로 포맷한다', async () => {
    const payload: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [
        {
          severity: 'critical',
          confidence: 0.9,
          filePath: 'a.ts',
          line: 10,
          title: 'critical issue',
          message: 'fix this',
          evidence: [],
          suggestedFix: 'const x = 1;',
        },
        {
          severity: 'minor',
          confidence: 0.5,
          filePath: 'b.ts',
          line: 20,
          title: 'minor issue',
          message: 'nit',
          evidence: [],
          suggestedFix: 'const y = 2;',
        },
      ],
    };

    await service.handle(payload);

    const [{ comments }] = createReview.mock.calls[0] as [
      { comments: { body: string }[] },
    ];
    expect(comments[0].body).not.toContain('```suggestion');
    expect(comments[0].body).toContain('제안: const x = 1;');
    expect(comments[1].body).not.toContain('```suggestion');
    expect(comments[1].body).toContain('제안: const y = 2;');
  });

  it('createReview가 4xx 에러를 던지면 Discord 알림 후 에러를 재throw하지 않고 종료한다', async () => {
    createReview.mockRejectedValue(makeHttpError(422));

    await expect(service.handle(completedPayload)).resolves.toBeUndefined();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'GitHub 리뷰 등록 실패' }),
    );
  });

  it('createReview가 5xx 에러를 던지면 Discord 알림 후 에러를 재throw한다', async () => {
    const error = makeHttpError(500);
    createReview.mockRejectedValue(error);

    await expect(service.handle(completedPayload)).rejects.toBe(error);
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'GitHub 리뷰 등록 실패' }),
    );
  });

  it('finding이 있으면 생성된 리뷰 코멘트 id를 findingIndex와 함께 저장한다', async () => {
    const payload: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [
        {
          severity: 'minor',
          confidence: 0.5,
          filePath: 'a.ts',
          line: 1,
          title: 'a',
          message: 'msg-a',
          evidence: [],
        },
        {
          severity: 'major',
          confidence: 0.8,
          filePath: 'b.ts',
          line: 2,
          title: 'b',
          message: 'msg-b',
          evidence: [],
        },
      ],
    };
    // listCommentsForReview는 별도 paginate 호출 — createReview에 보낸 순서와
    // 동일한 순서로 생성된 코멘트가 반환된다고 가정한다.
    paginate.mockResolvedValue([{ id: 111 }, { id: 222 }]);

    await service.handle(payload);

    expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(111, {
      reviewJobId: payload.reviewJobId,
      findingIndex: 0,
    });
    expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(222, {
      reviewJobId: payload.reviewJobId,
      findingIndex: 1,
    });
  });

  it('finding이 없으면 코멘트 매핑 조회를 하지 않는다', async () => {
    await service.handle(completedPayload);

    expect(paginate).not.toHaveBeenCalled();
    expect(reviewCommentFindingStore.set).not.toHaveBeenCalled();
  });

  it('매핑 저장 조회가 실패해도 리뷰 등록 자체는 성공으로 끝난다', async () => {
    const payload: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [
        {
          severity: 'minor',
          confidence: 0.5,
          filePath: 'a.ts',
          line: 1,
          title: 'a',
          message: 'msg-a',
          evidence: [],
        },
      ],
    };
    paginate.mockRejectedValue(new Error('list failed'));

    await expect(service.handle(payload)).resolves.toBeUndefined();
  });

  it('GITHUB_BOT_LOGIN이 없으면 이전 코멘트 조회 없이 바로 createReview를 호출한다', async () => {
    await service.handle(completedPayload);

    expect(paginate).not.toHaveBeenCalled();
    expect(createReview).toHaveBeenCalled();
  });

  it('봇이 남긴 이전 최상위 코멘트만 삭제하고, 사람 답글/다른 유저 코멘트는 남긴다', async () => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';
    paginate.mockResolvedValue([
      { id: 1, user: { login: 'dovi-code-assist[bot]' }, in_reply_to_id: null },
      {
        id: 2,
        user: { login: 'dovi-code-assist[bot]' },
        in_reply_to_id: 999,
      },
      { id: 3, user: { login: 'someone-else' }, in_reply_to_id: null },
    ]);

    await service.handle(completedPayload);

    expect(deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
    expect(createReview).toHaveBeenCalled();
  });

  it('봇 루트 코멘트에 사람 답글이 달려 있으면 스레드 전체를 보존한다', async () => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';
    paginate.mockResolvedValue([
      { id: 1, user: { login: 'dovi-code-assist[bot]' }, in_reply_to_id: null },
      { id: 2, user: { login: 'human-reviewer' }, in_reply_to_id: 1 },
      { id: 3, user: { login: 'dovi-code-assist[bot]' }, in_reply_to_id: null },
    ]);

    await service.handle(completedPayload);

    expect(deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 3 }),
    );
  });

  it('이전 코멘트 정리 중 에러가 나도 새 리뷰 등록은 계속 진행한다', async () => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';
    paginate.mockRejectedValue(new Error('list failed'));

    await expect(service.handle(completedPayload)).resolves.toBeUndefined();
    expect(createReview).toHaveBeenCalled();
  });

  describe('인라인 코멘트가 diff 밖 줄을 가리켜 GitHub가 422로 거부하는 경우', () => {
    const twoFindings: ReviewCompletedPayload = {
      ...completedPayload,
      reviews: [
        {
          severity: 'major',
          confidence: 0.8,
          filePath: 'a.ts',
          line: 1,
          title: 'valid',
          message: 'msg-valid',
          evidence: [],
        },
        {
          severity: 'major',
          confidence: 0.8,
          filePath: 'b.spec.ts',
          line: 109,
          title: 'outside-diff',
          message: 'msg-outside-diff',
          evidence: [],
        },
      ],
    };

    it('첫 리뷰: 본문만으로 리뷰를 만들고, 달 수 있는 건 인라인으로, 못 다는 건 본문에 모은다', async () => {
      createReview
        .mockRejectedValueOnce(makeHttpError(422))
        .mockResolvedValueOnce({ data: { id: 900 } });
      createReviewComment
        .mockResolvedValueOnce({ data: { id: 111 } })
        .mockRejectedValueOnce(makeHttpError(422));

      await expect(service.handle(twoFindings)).resolves.toBeUndefined();

      // 2번째 createReview는 인라인 코멘트 없이 본문만 담는다
      expect(createReview).toHaveBeenCalledTimes(2);
      const secondCall = createReview.mock.calls[1] as [
        { comments: unknown[] },
      ];
      expect(secondCall[0].comments).toEqual([]);
      expect(primaryReviewStore.set).toHaveBeenCalledWith(1, 1, 900);
      // 유효한 finding은 인라인으로 게시되고 반영 추적 매핑이 저장된다
      expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(111, {
        reviewJobId: twoFindings.reviewJobId,
        findingIndex: 0,
      });
      // 못 단 finding은 본문에 합쳐진다
      expect(updateReview).toHaveBeenCalledWith(
        expect.objectContaining({
          review_id: 900,
          body: expect.stringContaining('`b.spec.ts:109`') as string,
        }),
      );
      // 실패로 취급하지 않는다
      expect(dicoshot.sendCustom).not.toHaveBeenCalled();
    });

    it('이미 봇 리뷰가 있는 PR: 거부된 finding만 본문에 모으고 나머지는 그대로 게시한다', async () => {
      primaryReviewStore.get.mockResolvedValue(555);
      createReviewComment
        .mockRejectedValueOnce(makeHttpError(422))
        .mockResolvedValueOnce({ data: { id: 222 } });

      await expect(service.handle(twoFindings)).resolves.toBeUndefined();

      expect(createReviewComment).toHaveBeenCalledTimes(2);
      expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(222, {
        reviewJobId: twoFindings.reviewJobId,
        findingIndex: 1,
      });
      expect(updateReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          review_id: 555,
          body: expect.stringContaining('`a.ts:1`') as string,
        }),
      );
      expect(dicoshot.sendCustom).not.toHaveBeenCalled();
    });

    it('모든 finding이 달리면 본문을 추가로 갱신하지 않는다', async () => {
      primaryReviewStore.get.mockResolvedValue(555);

      await service.handle(twoFindings);

      // 본문 갱신은 기존 리뷰 body 갱신 1회뿐
      expect(updateReview).toHaveBeenCalledTimes(1);
    });

    it('422가 아닌 에러(5xx)는 전환하지 않고 그대로 던진다', async () => {
      primaryReviewStore.get.mockResolvedValue(555);
      const error = makeHttpError(500);
      createReviewComment.mockRejectedValue(error);

      await expect(service.handle(twoFindings)).rejects.toBe(error);
    });

    it('finding이 없는데 422면(커밋 불일치 등) 전환하지 않고 기존처럼 실패 처리한다', async () => {
      createReview.mockRejectedValue(makeHttpError(422));

      await expect(service.handle(completedPayload)).resolves.toBeUndefined();

      expect(createReview).toHaveBeenCalledTimes(1);
      expect(dicoshot.sendCustom).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'GitHub 리뷰 등록 실패' }),
      );
    });
  });

  describe('같은 PR에 이미 봇 리뷰가 있는 경우 (push 반복)', () => {
    beforeEach(() => {
      primaryReviewStore.get.mockResolvedValue(555);
    });

    it('새 리뷰(createReview)를 만들지 않고 기존 리뷰의 body만 갱신한다', async () => {
      await service.handle(completedPayload);

      expect(createReview).not.toHaveBeenCalled();
      expect(updateReview).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          pull_number: 1,
          review_id: 555,
          body: '# Code Review\n\nok',
        }),
      );
      expect(primaryReviewStore.set).not.toHaveBeenCalled();
    });

    it('finding은 createReviewComment로 개별 등록하고 반환된 id로 매핑을 저장한다', async () => {
      createReviewComment
        .mockResolvedValueOnce({ data: { id: 111 } })
        .mockResolvedValueOnce({ data: { id: 222 } });
      const payload: ReviewCompletedPayload = {
        ...completedPayload,
        reviews: [
          {
            severity: 'minor',
            confidence: 0.5,
            filePath: 'a.ts',
            line: 1,
            title: 'a',
            message: 'msg-a',
            evidence: [],
          },
          {
            severity: 'major',
            confidence: 0.8,
            filePath: 'b.ts',
            line: 2,
            title: 'b',
            message: 'msg-b',
            evidence: [],
          },
        ],
      };

      await service.handle(payload);

      expect(createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 1,
          commit_id: 'sha',
          path: 'a.ts',
          line: 1,
        }),
      );
      expect(createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 1,
          commit_id: 'sha',
          path: 'b.ts',
          line: 2,
        }),
      );
      expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(111, {
        reviewJobId: payload.reviewJobId,
        findingIndex: 0,
      });
      expect(reviewCommentFindingStore.set).toHaveBeenCalledWith(222, {
        reviewJobId: payload.reviewJobId,
        findingIndex: 1,
      });
    });

    it('updateReview가 4xx 에러를 던지면 Discord 알림 후 재throw하지 않고 종료한다', async () => {
      updateReview.mockRejectedValue(makeHttpError(422));

      await expect(service.handle(completedPayload)).resolves.toBeUndefined();
      expect(dicoshot.sendCustom).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'GitHub 리뷰 등록 실패' }),
      );
    });

    it('updateReview가 404를 던지면 저장된 review id를 지우고 새 리뷰를 생성한다', async () => {
      updateReview.mockRejectedValue(makeHttpError(404));

      await service.handle(completedPayload);

      expect(primaryReviewStore.delete).toHaveBeenCalledWith(1, 1);
      expect(createReview).toHaveBeenCalled();
      expect(primaryReviewStore.set).toHaveBeenCalledWith(1, 1, 555);
      expect(dicoshot.sendCustom).not.toHaveBeenCalled();
    });
  });
  describe('게시 전 줄 검증 (diff 밖 finding 본문 강등)', () => {
    function finding(filePath: string, line: number, title: string) {
      return {
        severity: 'major' as const,
        confidence: 0.8,
        filePath,
        line,
        title,
        message: `msg-${title}`,
        evidence: [],
      };
    }

    const patch = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c'].join('\n');

    it('diff에 없는 줄의 finding은 인라인에서 빼고 본문에 강등해 한 번의 createReview로 게시한다', async () => {
      listFiles.mockResolvedValue([{ filename: 'a.ts', patch }]);

      await service.handle({
        ...completedPayload,
        reviews: [finding('a.ts', 2, 'ok'), finding('a.ts', 99, 'out')],
      });

      expect(createReview).toHaveBeenCalledTimes(1);
      const [args] = createReview.mock.calls[0] as [
        { body: string; comments: { path: string; line: number }[] },
      ];
      expect(args.comments).toEqual([
        expect.objectContaining({ path: 'a.ts', line: 2 }),
      ]);
      expect(args.body).toContain('### 위치를 특정할 수 없는 지적사항');
      expect(args.body).toContain('`a.ts:99`');
      expect(args.body).not.toContain('`a.ts:2`');
      expect(createReviewComment).not.toHaveBeenCalled();
    });

    it('모든 finding이 diff 밖이어도 본문 강등으로 리뷰는 게시된다', async () => {
      listFiles.mockResolvedValue([{ filename: 'a.ts', patch }]);

      await service.handle({
        ...completedPayload,
        reviews: [finding('a.ts', 99, 'out')],
      });

      const [args] = createReview.mock.calls[0] as [
        { body: string; comments: unknown[] },
      ];
      expect(args.comments).toEqual([]);
      expect(args.body).toContain('`a.ts:99`');
      expect(primaryReviewStore.set).toHaveBeenCalledWith(1, 1, 555);
    });

    it('PR 파일 목록에 없는 파일의 finding은 강등한다', async () => {
      listFiles.mockResolvedValue([{ filename: 'a.ts', patch }]);

      await service.handle({
        ...completedPayload,
        reviews: [finding('other.ts', 1, 'missing')],
      });

      const [args] = createReview.mock.calls[0] as [
        { body: string; comments: unknown[] },
      ];
      expect(args.comments).toEqual([]);
      expect(args.body).toContain('`other.ts:1`');
    });

    it('patch가 생략된 파일(큰 파일)은 검증할 수 없으므로 강등하지 않고 인라인으로 시도한다', async () => {
      listFiles.mockResolvedValue([{ filename: 'big.ts' }]);

      await service.handle({
        ...completedPayload,
        reviews: [finding('big.ts', 500, 'big')],
      });

      const [args] = createReview.mock.calls[0] as [
        { body: string; comments: { path: string }[] },
      ];
      expect(args.comments).toEqual([
        expect.objectContaining({ path: 'big.ts', line: 500 }),
      ]);
      expect(args.body).not.toContain('위치를 특정할 수 없는');
    });

    it('PR 파일 목록 조회가 실패하면 검증 없이 전부 인라인으로 시도한다', async () => {
      listFiles.mockRejectedValue(new Error('boom'));

      await service.handle({
        ...completedPayload,
        reviews: [finding('a.ts', 99, 'x')],
      });

      const [args] = createReview.mock.calls[0] as [{ comments: unknown[] }];
      expect(args.comments).toHaveLength(1);
    });

    it('강등 건수를 로그로 남긴다', async () => {
      listFiles.mockResolvedValue([{ filename: 'a.ts', patch }]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await service.handle({
        ...completedPayload,
        reviews: [finding('a.ts', 2, 'ok'), finding('a.ts', 99, 'out')],
      });

      expect(warn).toHaveBeenCalledWith(
        'review comments demoted reviewJobId=repo_1_sha inline=1 demoted=1',
      );
      warn.mockRestore();
    });

    it('이미 봇 리뷰가 있는 PR에서도 diff 밖 finding은 본문(updateReview)에 강등한다', async () => {
      primaryReviewStore.get.mockResolvedValue(555);
      listFiles.mockResolvedValue([{ filename: 'a.ts', patch }]);

      await service.handle({
        ...completedPayload,
        reviews: [finding('a.ts', 2, 'ok'), finding('a.ts', 99, 'out')],
      });

      expect(updateReview).toHaveBeenCalledTimes(1);
      const [args] = updateReview.mock.calls[0] as [{ body: string }];
      expect(args.body).toContain('`a.ts:99`');
      expect(createReviewComment).toHaveBeenCalledTimes(1);
      expect(createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'a.ts', line: 2 }),
      );
    });
  });
});
