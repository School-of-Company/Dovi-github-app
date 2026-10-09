// 알림(Discord)에 찍을 오류 설명. `err.message`만 쓰면 네트워크 연결 실패에서 빈 문자열이 된다 —
// Node의 fetch는 연결에 실패하면 `TypeError('fetch failed')`에 원인(cause)을 달아 던지고, 그 cause가
// 주소별 실패를 묶은 `AggregateError`(message가 항상 빈 문자열)라서 octokit이 만든 오류의 message가
// ''가 된다(status 500). 그러면 알림에 원인이 하나도 안 보여 "왜 실패하는지" 알 수 없다.
//
// 그래서 cause 사슬을 따라가며 오류 종류·상태·코드·메시지를 모아 한 줄로 보여준다.

const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATED_ERRORS = 3;
const MAX_LENGTH = 600;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function isObject(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null;
}

function describeOne(err: ErrorLike): string {
  const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
  const details: string[] = [];
  if (typeof err.status === 'number') details.push(`status=${err.status}`);
  if (typeof err.code === 'string' || typeof err.code === 'number') {
    details.push(`code=${String(err.code)}`);
  }
  const head = details.length > 0 ? `${name}(${details.join(', ')})` : name;

  const parts: string[] = [];
  if (typeof err.message === 'string' && err.message.trim() !== '') {
    parts.push(err.message.trim());
  }
  // AggregateError는 message가 비어 있고 실제 원인이 errors에 들어 있다(주소별 연결 실패 등).
  if (Array.isArray(err.errors)) {
    const inner = err.errors
      .slice(0, MAX_AGGREGATED_ERRORS)
      .map((e) =>
        isObject(e) && typeof e.message === 'string' && e.message
          ? e.message
          : String(e),
      );
    if (inner.length > 0) parts.push(`[${inner.join('; ')}]`);
  }
  return parts.length > 0 ? `${head}: ${parts.join(' ')}` : head;
}

export function describeError(err: unknown): string {
  if (!isObject(err)) {
    const text = String(err);
    return text === '' ? 'unknown error' : text.slice(0, MAX_LENGTH);
  }

  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && isObject(current) && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    chain.push(describeOne(current));
    current = current.cause;
  }

  const text = chain.join(' ← ');
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}
