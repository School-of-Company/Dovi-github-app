export interface GithubWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  pull_request?: {
    number: number;
    draft: boolean;
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
  };
  sender: {
    type: string;
    login: string;
  };
}
