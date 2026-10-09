import { describeError } from './describe-error';

describe('describeError', () => {
  it('message가 빈 octokit 네트워크 오류도 cause 사슬을 따라 원인을 보여준다', () => {
    const aggregate = Object.assign(
      new AggregateError([
        Object.assign(new Error('connect ETIMEDOUT 140.82.112.5:443'), {
          code: 'ETIMEDOUT',
        }),
        new Error('connect ENETUNREACH 2606:50c0:8000::1:443'),
      ]),
      { code: 'ETIMEDOUT' },
    );
    const fetchFailed = Object.assign(new TypeError('fetch failed'), {
      cause: aggregate,
    });
    const httpError = Object.assign(new Error(''), {
      name: 'HttpError',
      status: 500,
      cause: fetchFailed,
    });

    const text = describeError(httpError);

    expect(text).toBe(
      'HttpError(status=500) ← TypeError: fetch failed ← AggregateError(code=ETIMEDOUT): ' +
        '[connect ETIMEDOUT 140.82.112.5:443; connect ENETUNREACH 2606:50c0:8000::1:443]',
    );
  });

  it('message가 있는 일반 오류는 이름과 메시지를 보여준다', () => {
    expect(describeError(new Error('boom'))).toBe('Error: boom');
  });

  it('status와 code를 괄호로 붙인다', () => {
    const err = Object.assign(new Error('Not Found'), {
      name: 'RequestError',
      status: 404,
    });

    expect(describeError(err)).toBe('RequestError(status=404): Not Found');
  });

  it('message와 cause가 모두 없어도 빈 문자열이 되지 않는다', () => {
    expect(describeError(new Error(''))).toBe('Error');
    expect(describeError(new Error('')).length).toBeGreaterThan(0);
  });

  it.each([
    ['문자열', 'plain failure', 'plain failure'],
    ['빈 문자열', '', 'unknown error'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['숫자', 42, '42'],
  ])('Error가 아닌 값(%s)도 처리한다', (_label, value, expected) => {
    expect(describeError(value)).toBe(expected);
  });

  it('순환하는 cause에서 무한 루프에 빠지지 않는다', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;

    expect(describeError(a)).toBe('Error: a ← Error: b');
  });

  it('cause 사슬은 최대 4단계까지만 따라간다', () => {
    let err: Error = new Error('e0');
    for (let i = 1; i <= 8; i++) {
      err = Object.assign(new Error(`e${i}`), { cause: err });
    }

    expect(describeError(err).split(' ← ')).toHaveLength(4);
  });

  it('AggregateError의 내부 오류는 3개까지만 보여준다', () => {
    const err = new AggregateError(
      [1, 2, 3, 4, 5].map((n) => new Error(`inner${n}`)),
    );

    const text = describeError(err);

    expect(text).toContain('inner3');
    expect(text).not.toContain('inner4');
  });

  it('너무 긴 설명은 잘라 알림 길이를 제한한다', () => {
    const text = describeError(new Error('x'.repeat(5000)));

    expect(text.length).toBeLessThanOrEqual(601);
    expect(text.endsWith('…')).toBe(true);
  });
});
