export interface CollectPrDataCommand {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  headSha: string;
  baseSha: string;
  repositoryId: number;
}
