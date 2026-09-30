export function isClientError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    (err as { status: number }).status >= 400 &&
    (err as { status: number }).status < 500
  );
}

// 레이트 리밋(429, 또는 403 + retry-after/x-ratelimit-remaining: 0)은 4xx지만 일시적이라
// 재시도하면 성공한다. isClientError(영구 실패로 포기)와 구분해서 다뤄야 한다.
export function isRateLimitError(err: unknown): boolean {
  if (!isClientError(err)) return false;
  if (err.status === 429) return true;
  if (err.status !== 403) return false;
  const headers = (
    err as { response?: { headers?: Record<string, string | undefined> } }
  ).response?.headers;
  return (
    headers?.['retry-after'] !== undefined ||
    headers?.['x-ratelimit-remaining'] === '0'
  );
}

// 대상 리소스(코멘트/리뷰 등)가 GitHub에서 이미 삭제된 경우(404/410).
export function isGoneError(err: unknown): boolean {
  return isClientError(err) && (err.status === 404 || err.status === 410);
}
