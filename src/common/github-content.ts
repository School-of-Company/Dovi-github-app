import type { Octokit } from '@octokit/rest';

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
  sizeLimit: number,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (
      Array.isArray(data) ||
      data.type !== 'file' ||
      !data.content ||
      data.size > sizeLimit
    ) {
      return null;
    }

    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}
