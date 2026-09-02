import type { DicoshotService } from 'dicoshot-nest';
import { ReviewOrchestratorService } from './review-orchestrator.service';
import type { ReviewJobContextStore } from '../redis/review-job-context.store';
import type { ReviewJobContext } from '../redis/review-job-context.type';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('ReviewOrchestratorService', () => {
  let createReview: jest.Mock;
  let paginate: jest.Mock;
  let deleteReviewComment: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let reviewJobContextStore: { get: jest.Mock };
  let dicoshot: { sendCustom: jest.Mock };
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
    createReview = jest.fn();
    paginate = jest.fn().mockResolvedValue([]);
    deleteReviewComment = jest.fn().mockResolvedValue(undefined);
    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue({
        rest: {
          pulls: {
            createReview,
            listReviewComments: 'listReviewComments',
            deleteReviewComment,
          },
        },
        paginate,
      }),
    };
    reviewJobContextStore = { get: jest.fn().mockResolvedValue(context) };
    dicoshot = { sendCustom: jest.fn() };

    service = new ReviewOrchestratorService(
      installationTokenManager,
      reviewJobContextStore as unknown as ReviewJobContextStore,
      dicoshot as unknown as DicoshotService,
    );
  });

  it('job context가 없으면 아무 것도 하지 않고 스킵한다', async () => {
    reviewJobContextStore.get.mockResolvedValue(null);

    await service.handle(completedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).not.toHaveBeenCalled();
  });

  it('failed payload는 GitHub API를 호출하지 않고 Discord 알림만 보낸다', async () => {
    await service.handle(failedPayload);

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(dicoshot.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'AI 리뷰 분석 실패', color: 'danger' }),
    );
  });

  it('reviews가 빈 배열이면 summary만 담아 빈 comments로 createReview를 호출한다', async () => {
    await service.handle(completedPayload);

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        commit_id: 'sha',
        event: 'COMMENT',
        body: 'ok',
        comments: [],
      }),
    );
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

  it('이전 코멘트 정리 중 에러가 나도 새 리뷰 등록은 계속 진행한다', async () => {
    process.env.GITHUB_BOT_LOGIN = 'dovi-code-assist';
    paginate.mockRejectedValue(new Error('list failed'));

    await expect(service.handle(completedPayload)).resolves.toBeUndefined();
    expect(createReview).toHaveBeenCalled();
  });
});
