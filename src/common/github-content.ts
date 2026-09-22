import type { Octokit } from '@octokit/rest';

/**
 * 파일 내용을 못 가져온 이유.
 *
 * 예전에는 모든 실패를 `null` 하나로 반환했다. 동작은 안전했지만(호출부가 content 없이 진행),
 * "이 파일이 왜 리뷰에서 빠졌나"를 추적할 방법이 없었다. 실제로 175바이트 파일이 컨텍스트에서
 * 누락된 원인을 찾느라 크기 제한 세 곳을 확인하고 GitHub API를 직접 호출해봐야 했고, 그 사이
 * 사용자에게는 "크기 제한" 이라는 틀린 설명이 전달됐다.
 */
export type FileContentSkipReason =
  | 'directory'
  | 'not-a-file'
  | 'no-content'
  | 'size-exceeded'
  | 'not-found'
  | 'fetch-failed';

export interface FileContentResult {
  /** 성공 시 파일 내용, 실패 시 `null`. */
  content: string | null;
  /** `content`가 `null`일 때만 채워진다. */
  skipReason?: FileContentSkipReason;
  /** API가 알려준 실제 크기 — `size-exceeded` 원인을 볼 때 제한값 튜닝 근거가 된다. */
  size?: number;
}

/**
 * 커밋(ref) 시점의 파일 내용을 가져온다.
 *
 * 실패는 예외로 던지지 않는다 — content는 리뷰 품질을 높이는 보강 정보라서, 한 파일을 못 읽었다고
 * 수집 전체를 실패시킬 이유가 없다. 대신 이유를 함께 돌려주므로 호출부가 로그로 남길 수 있다.
 */
export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
  sizeLimit: number,
): Promise<FileContentResult> {
  let data: Awaited<ReturnType<typeof octokit.rest.repos.getContent>>['data'];
  try {
    ({ data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    }));
  } catch (err) {
    // 404는 흔한 정상 경로다 (설정 파일이 없는 레포, PR에서 삭제된 파일). 나머지 실패와 구분해
    // 호출부가 로그 레벨을 달리 줄 수 있게 한다.
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    return {
      content: null,
      skipReason: status === 404 ? 'not-found' : 'fetch-failed',
    };
  }

  if (Array.isArray(data)) return { content: null, skipReason: 'directory' };
  if (data.type !== 'file') return { content: null, skipReason: 'not-a-file' };
  if (data.size > sizeLimit) {
    return { content: null, skipReason: 'size-exceeded', size: data.size };
  }
  // 1MB 를 넘는 파일은 GitHub 이 content 를 비워 보낸다 (download_url 로만 받을 수 있다).
  // sizeLimit 이 그보다 크게 설정된 경우에만 여기까지 온다.
  if (!data.content) {
    return { content: null, skipReason: 'no-content', size: data.size };
  }

  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    size: data.size,
  };
}

/** 로그에 그대로 붙일 수 있는 한 줄 설명. */
export function describeSkipReason(
  reason: FileContentSkipReason,
  sizeLimit: number,
  size?: number,
): string {
  switch (reason) {
    case 'size-exceeded':
      return `크기 초과 (${size ?? '?'} bytes > 제한 ${sizeLimit} bytes)`;
    case 'no-content':
      return `API 가 content 를 주지 않음 (${size ?? '?'} bytes — 1MB 초과 파일은 content 가 비어 온다)`;
    case 'not-found':
      return '해당 ref 에 파일 없음 (404)';
    case 'fetch-failed':
      return 'GitHub API 호출 실패';
    case 'directory':
      return '경로가 디렉터리';
    case 'not-a-file':
      return '경로가 파일이 아님 (심링크·서브모듈)';
  }
}
