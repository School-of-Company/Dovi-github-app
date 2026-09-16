export interface ReflectionClassification {
  reflected: boolean;
  reason?: string;
}

// 봇 리뷰 코멘트 스레드에 달린 답글 텍스트로 반영 여부를 추정한다.
// 정확한 의도 파악이 불가능한 휴리스틱이므로, 애매하면(둘 다 매치되거나 둘 다
// 안 되면) 잘못된 신호를 보내는 대신 null을 반환해 조용히 무시한다.
const NOT_REFLECTED_PATTERNS = [
  /반영\s*(하지|안|못)/,
  /미반영/,
  /보류/,
  /스킵/,
  /거부/,
  /(안|못)\s*고(쳤|침|치)/,
  /아직\s*(안|못|수정|반영|적용)/,
  /won'?t\s*fix/i,
  /wontfix/i,
  /not\s*fix(ing|ed)?/i,
  /\bskip(ped)?\b/i,
  /not\s*applicable/i,
  /not\s+(yet\s+)?(done|resolved|addressed|applied|fixed)\b/i,
  /\bnot\s+yet\b/i,
];

const REFLECTED_PATTERNS = [
  /반영\s*(했|함|완료|됨)/,
  /적용\s*(했|함|완료|됨)/,
  /수정\s*(했|함|완료|됨)/,
  /고쳤/,
  /\bfixed\b/i,
  /\bdone\b/i,
  /\bresolved\b/i,
  /\baddressed\b/i,
  /\bapplied\b/i,
];

const REASON_MAX_LENGTH = 200;

export function classifyReflection(
  body: string,
): ReflectionClassification | null {
  const text = body.trim();
  if (text === '') return null;

  const notReflected = NOT_REFLECTED_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
  // 부정 패턴은 "안/못/not" 같은 명시적 부정어를 포함하도록 설계되어 있어
  // 긍정 패턴(예: /고쳤/, /\bdone\b/)과 동시에 매치되더라도 부정 쪽이 더 신뢰도가
  // 높다 ("아직 안 고쳤어요"는 /고쳤/도 매치하지만 명백히 미반영이다).
  if (notReflected) {
    return { reflected: false, reason: text.slice(0, REASON_MAX_LENGTH) };
  }

  const reflected = REFLECTED_PATTERNS.some((pattern) => pattern.test(text));
  if (!reflected) return null;
  return { reflected: true };
}
