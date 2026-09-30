import { isRateLimitError } from './http-error';

function httpError(
  status: number,
  headers?: Record<string, string>,
): Error & { status: number; response?: { headers: Record<string, string> } } {
  return Object.assign(new Error('http error'), {
    status,
    ...(headers ? { response: { headers } } : {}),
  });
}

describe('isRateLimitError', () => {
  it('429는 레이트 리밋이다', () => {
    expect(isRateLimitError(httpError(429))).toBe(true);
  });

  it.each([[{ 'retry-after': '30' }], [{ 'x-ratelimit-remaining': '0' }]])(
    '403 + %j 는 레이트 리밋이다',
    (headers) => {
      expect(isRateLimitError(httpError(403, headers))).toBe(true);
    },
  );

  it('레이트 리밋 신호가 없는 403(권한 부족)은 아니다', () => {
    expect(isRateLimitError(httpError(403))).toBe(false);
    expect(
      isRateLimitError(httpError(403, { 'x-ratelimit-remaining': '4999' })),
    ).toBe(false);
  });

  it.each([400, 401, 404, 422, 500])('%d는 아니다', (status) => {
    expect(isRateLimitError(httpError(status))).toBe(false);
  });

  it('상태 코드가 없는 값은 아니다', () => {
    expect(isRateLimitError(new Error('x'))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});
