import type { GithubWebhookPayload } from './dto/github-webhook-payload';

// 같은 저장소 브랜치에서 만든 PR인지 판별한다. head repo가 base repo(이 저장소)와
// 다르면(또는 head repo가 삭제되어 null이면) fork PR로 간주한다. 샌드박스
// 프로브처럼 코드를 clone해야 하는 기능은 v1에서 fork PR을 대상에서 제외한다 —
// fork 저장소는 App이 설치되어 있지 않을 수 있어 동일한 installation token으로
// clone할 수 없기 때문이다.
export function isForkPr(payload: GithubWebhookPayload): boolean {
  const headRepo = payload.pull_request?.head.repo;
  if (!headRepo) return true;
  return headRepo.id !== payload.repository.id;
}
