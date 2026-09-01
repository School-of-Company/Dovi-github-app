const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// 가정/학교망 특성상 외부(GitHub API 등)로 나가는 아웃바운드 연결이 간헐적으로
// 몇 초씩 타임아웃되는 경우가 있어, 짧은 backoff로 재시도한다.
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
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
