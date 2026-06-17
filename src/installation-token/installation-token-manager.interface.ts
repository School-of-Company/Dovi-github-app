import { Octokit } from '@octokit/rest';

export const INSTALLATION_TOKEN_MANAGER = 'INSTALLATION_TOKEN_MANAGER';

export interface InstallationTokenManager {
  getOctokit(installationId: number): Promise<Octokit>;
}
