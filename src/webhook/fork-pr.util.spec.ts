import { isForkPr } from './fork-pr.util';
import type { GithubWebhookPayload } from './dto/github-webhook-payload';

function payloadWithHeadRepo(
  headRepo: { id: number; full_name: string } | null,
): GithubWebhookPayload {
  return {
    action: 'opened',
    repository: { id: 1, full_name: 'owner/repo', default_branch: 'main' },
    sender: { type: 'User', login: 'alice' },
    pull_request: {
      number: 1,
      draft: false,
      title: 't',
      body: '',
      head: { sha: 'sha', repo: headRepo },
      base: { sha: 'base-sha' },
    },
  };
}

describe('isForkPr', () => {
  it('head repo id가 base repo(이 저장소)와 같으면 fork가 아니다', () => {
    expect(
      isForkPr(payloadWithHeadRepo({ id: 1, full_name: 'owner/repo' })),
    ).toBe(false);
  });

  it('head repo id가 base repo와 다르면 fork PR이다', () => {
    expect(
      isForkPr(payloadWithHeadRepo({ id: 2, full_name: 'someone/repo' })),
    ).toBe(true);
  });

  it('head repo가 삭제되어 null이면 fork PR로 간주한다', () => {
    expect(isForkPr(payloadWithHeadRepo(null))).toBe(true);
  });

  it('pull_request가 없는 payload는 fork로 간주한다 (안전한 기본값)', () => {
    expect(
      isForkPr({
        action: 'created',
        repository: { id: 1, full_name: 'owner/repo', default_branch: 'main' },
        sender: { type: 'User', login: 'alice' },
      }),
    ).toBe(true);
  });
});
