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
