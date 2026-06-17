export interface CollectPrDataCommand {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  repositoryId: number;
}
