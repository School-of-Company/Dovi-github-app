import { Octokit } from '@octokit/rest';

export const INSTALLATION_TOKEN_MANAGER = 'INSTALLATION_TOKEN_MANAGER';

// installation token을 발급할 때 권한/대상 저장소를 좁히기 위한 옵션.
// GitHub의 "Create an installation access token" API가 받는 permissions/
// repositoryIds 파라미터를 그대로 반영한다 — 지정하지 않은 권한은 App 설치
// 시점의 전체 권한을 그대로 쓰고, repositoryIds를 지정하면 해당 저장소로만
// 토큰이 스코프된다.
export interface TokenScope {
  permissions: Record<string, 'read' | 'write' | 'admin'>;
  repositoryIds?: number[];
}

export interface InstallationTokenManager {
  getOctokit(installationId: number): Promise<Octokit>;

  // 스코프가 좁혀진 raw 토큰이 필요한 호출부(예: git clone 자격증명)를 위한
  // 메서드. 스코프별로 캐시가 분리되므로, 좁힌 토큰이 전체 권한 캐시를
  // 오염시키지 않는다.
  getScopedToken(installationId: number, scope: TokenScope): Promise<string>;
}
