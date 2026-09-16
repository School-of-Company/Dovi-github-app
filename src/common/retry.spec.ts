import { withRetry } from './retry';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error('http error'), { status });
}

describe('withRetry', () => {
  it('성공하면 재시도 없이 결과를 반환한다', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('일시적 오류는 3번까지 재시도한 뒤 실패를 던진다', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('network error'));

    await expect(withRetry(fn)).rejects.toThrow('network error');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('재시도 중 성공하면 그 결과를 반환한다', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('4xx 오류는 재시도하지 않고 즉시 던진다', async () => {
    const fn = jest.fn().mockRejectedValue(httpError(422));

    await expect(withRetry(fn)).rejects.toMatchObject({ status: 422 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('5xx 오류는 재시도 대상이다', async () => {
    const fn = jest.fn().mockRejectedValue(httpError(500));

    await expect(withRetry(fn)).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
