import type { DicoshotService } from 'dicoshot-nest';
import { ReviewOrchestratorService } from './review-orchestrator.service';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

function makeHttpError(status: number): Error & { status: number } {
  return Object.assign(new Error('request failed'), { status });
}

describe('ReviewOrchestratorService', () => {
  let createReview: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let dicoshot: { sendCustom: jest.Mock };
  let service: ReviewOrchestratorService;

  const completedPayload: ReviewCompletedPayload = {
    reviewJobId: 'repo_1_sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    owner: 'owner',
    repo: 'repo',
    installationId: 123,
    summary: 'ok',
    reviews: [],
  };

  const failedPayload: ReviewFailedPayload = {
    reviewJobId: 'repo_1_sha',
    repositoryId: 1,
    prNumber: 1,
    headSha: 'sha',
    installationId: 123,
    reason: 'timeout',
  };

  beforeEach(() => {
    createReview = jest.fn();
    installationTokenManager = {
      getOctokit: jest
        .fn()
        .mockResolvedValue({ rest: { pulls: { createReview } } }),
    };
    dicoshot = { sendCustom: jest.fn() };

    service = new ReviewOrchestratorService(
      installationTokenManager,
      dicoshot as unknown as DicoshotService,
    );
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

  it('critical + suggestedFix가 있는 finding은 suggestion 블록으로, 나머지는 일반 텍스트로 포맷한다', async () => {
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
    expect(comments[0].body).toContain('```suggestion\nconst x = 1;\n```');
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
});
