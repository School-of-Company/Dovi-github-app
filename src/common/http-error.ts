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

// 대상 리소스(코멘트/리뷰 등)가 GitHub에서 이미 삭제된 경우(404/410).
export function isGoneError(err: unknown): boolean {
  return isClientError(err) && (err.status === 404 || err.status === 410);
}
