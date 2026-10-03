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

// 요청 형식은 맞지만 GitHub가 내용을 처리할 수 없다고 거부한 경우(422).
// 리뷰 코멘트의 line이 PR diff 범위 밖이면 "line could not be resolved"로 온다.
export function isUnprocessableError(err: unknown): boolean {
  return isClientError(err) && err.status === 422;
}

// 대상 리소스(코멘트/리뷰 등)가 GitHub에서 이미 삭제된 경우(404/410).
export function isGoneError(err: unknown): boolean {
  return isClientError(err) && (err.status === 404 || err.status === 410);
}
