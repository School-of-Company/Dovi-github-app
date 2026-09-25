export interface GithubWebhookPayload {
  action: string;
  // push 이벤트 전용 필드. push는 다른 이벤트와 달리 action이 없다.
  ref?: string;
  before?: string;
  after?: string;
  installation?: {
    id: number;
  };
  pull_request?: {
    number: number;
    draft: boolean;
    title: string;
    body: string | null;
    head: {
      sha: string;
      // fork PR 판별용. fork 저장소에서 온 PR은 이 repo가 base repository와
      // 다르다 (샌드박스 프로브 등 clone이 필요한 기능은 v1에서 fork PR 제외).
      repo: {
        id: number;
        full_name: string;
      } | null;
    };
    base: {
      sha: string;
    };
  };
  comment?: {
    id: number;
    in_reply_to_id?: number | null;
    path: string;
    line: number | null;
    diff_hunk: string;
    body: string;
  };
  issue?: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  repository: {
    id: number;
    full_name: string;
    default_branch: string;
  };
  sender: {
    type: string;
    login: string;
  };
}
