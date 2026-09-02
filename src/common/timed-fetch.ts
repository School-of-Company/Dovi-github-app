const REQUEST_TIMEOUT_MS = 4000;

// Octokit의 기본 연결 타임아웃(약 10초)이 재시도와 겹치면 응답이 지나치게
// 느려져서, 시도당 타임아웃을 짧게 잘라 재시도 주기를 빠르게 만든다.
export function createTimedFetch(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}
