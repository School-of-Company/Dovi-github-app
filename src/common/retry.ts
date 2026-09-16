import { isClientError } from './http-error';

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

// 가정/학교망 특성상 외부(GitHub API 등)로 나가는 아웃바운드 연결이 간헐적으로
// 몇 초씩 타임아웃되는 경우가 있어, 짧은 backoff로 재시도한다.
// 4xx(잘못된 요청, 권한 없음 등)는 재시도해도 결과가 바뀌지 않고, 403(secondary
// rate limit)은 오히려 재시도가 GitHub abuse detection의 페널티 대상이 되므로
// 즉시 던진다.
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isClientError(err)) throw err;

      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
      }
    }
  }
  throw lastErr;
}
