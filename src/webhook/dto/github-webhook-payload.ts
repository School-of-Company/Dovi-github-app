export interface GithubWebhookPayload {
  action: string;
  installation: {
    id: number;
  };
  pull_request: {
    number: number;
    draft: boolean;
    head: {
      sha: string;
    };
  };
  repository: {
    id: number;
    full_name: string;
  };
  sender: {
    type: string;
  };
}
