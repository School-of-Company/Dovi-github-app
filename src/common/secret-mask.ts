// LLM(ai-server → 모델 → Langfuse 트레이스)으로 보내기 전에 파일 내용의 하드코딩된
// 시크릿을 가린다. 경로 기반 제외(secret-path.ts)는 `.env` 같은 파일만 거르므로, 소스
// 안에 박힌 키는 이쪽에서 막는다.
//
// 원칙
// - 줄 수와 줄 위치를 보존한다: 치환은 한 줄 안에서만 일어난다(리뷰 코멘트가 줄 번호에
//   의존한다). 여러 줄짜리 PRIVATE KEY 블록도 줄마다 따로 가린다.
// - 보수적으로: 오탐으로 코드가 깨져 보이는 것보다 유출 방지가 우선이지만, 해시·UUID·
//   일반 식별자는 건드리지 않도록 형식이 뚜렷한 패턴과 "이름=따옴표 친 값"만 대상으로 한다.
// - 값은 어디에도 남기지 않는다(로그에는 건수만).

export interface MaskResult {
  text: string;
  /** 가려진 시크릿 건수 (로그용, 값은 절대 포함하지 않는다) */
  count: number;
}

export interface MaskOptions {
  /** unified diff의 patch 문자열이면 true — 각 줄 맨 앞의 `+`/`-`/공백 접두사를 보존한다. */
  diff?: boolean;
}

const MASK = '***';

// 앞 4글자만 남겨 어떤 종류의 키인지는 알 수 있게 한다(예: `ghp_***`).
function keepPrefix(value: string): string {
  return `${value.slice(0, 4)}${MASK}`;
}

const TOKEN_PATTERNS: RegExp[] = [
  // GitHub: ghp_/gho_/ghu_/ghs_/ghr_ + 36자 이상, fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack 토큰 / 웹훅
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
  // Discord 웹훅
  /https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
  // JWT (header.payload.signature — header/payload는 base64url JSON이라 `eyJ`로 시작)
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Anthropic / OpenAI 스타일 키
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/g,
];

// password / secret / token / api_key 등 이름에 `:` 또는 `=`로 이어진 **따옴표 친 문자열
// 리터럴**만 가린다. 따옴표 없는 값(`token = this.getToken()`, 타입 선언 `password: string`)
// 이나 환경변수 참조는 코드이지 시크릿이 아니므로 대상이 아니다.
const ASSIGNMENT_PATTERN =
  /(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)[\w.-]*["']?\s*[:=]\s*)(["'`])([^"'`\s]{8,})\2/gi;

// 접속 URL에 박힌 비밀번호: scheme://user:password@host (DB, Redis, AMQP 등). 사용자 이름은
// 남기고 비밀번호만 가린다.
const URL_CREDENTIALS_PATTERN =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`]+:)([^@\s/"'`]{3,})(@)/gi;

// 값이 아니라 자리표시자·참조인 경우는 시크릿이 아니다.
const PLACEHOLDER_VALUE =
  /^(?:\$\{|\$\(|<|\{\{|%|process\.env|env\.|os\.environ|your[_-]|change[_-]?me|example|sample|dummy|placeholder|test|x{4,}|\*{3,}|\.{3,})/i;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
// 한 줄 안에 BEGIN~END가 다 있는 경우(문자열 리터럴에 `\n`으로 이스케이프된 키 등).
const INLINE_PRIVATE_KEY =
  /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g;

function maskLine(line: string, counter: { count: number }): string {
  let result = line;

  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match) => {
      counter.count += 1;
      return keepPrefix(match);
    });
  }

  result = result.replace(
    ASSIGNMENT_PATTERN,
    (match, head: string, quote: string, value: string) => {
      // 숫자만이면 한도·포트 같은 설정값(maxTokens = "10000000")일 가능성이 높다.
      if (
        value.includes(MASK) ||
        /^\d+$/.test(value) ||
        PLACEHOLDER_VALUE.test(value)
      ) {
        return match;
      }
      counter.count += 1;
      return `${head}${quote}${MASK}${quote}`;
    },
  );

  result = result.replace(
    URL_CREDENTIALS_PATTERN,
    (match, head: string, password: string, at: string) => {
      if (password.includes(MASK) || PLACEHOLDER_VALUE.test(password)) {
        return match;
      }
      counter.count += 1;
      return `${head}${MASK}${at}`;
    },
  );

  return result;
}

export function maskSecrets(
  input: string,
  options: MaskOptions = {},
): MaskResult {
  const counter = { count: 0 };
  const lines = input.split('\n');
  let inPrivateKey = false;

  const masked = lines.map((line) => {
    // diff 접두사(+/-/공백)는 내용이 아니다. 키 블록 판정과 치환은 그 뒤 내용만 본다.
    const prefix = options.diff && line.length > 0 ? line[0] : '';
    const body = options.diff && line.length > 0 ? line.slice(1) : line;

    if (inPrivateKey) {
      if (PRIVATE_KEY_END.test(body)) {
        inPrivateKey = false;
        return line;
      }
      counter.count += body.trim() === '' ? 0 : 1;
      return body.trim() === '' ? line : `${prefix}${MASK}`;
    }

    if (PRIVATE_KEY_BEGIN.test(body)) {
      if (PRIVATE_KEY_END.test(body)) {
        // 한 줄짜리 키는 줄 안에서 본문만 가린다(BEGIN/END 마커는 남겨 줄 구조를 유지).
        return `${prefix}${body.replace(
          INLINE_PRIVATE_KEY,
          (_m, begin: string, end: string) => {
            counter.count += 1;
            return `${begin}${MASK}${end}`;
          },
        )}`;
      }
      inPrivateKey = true;
      return line;
    }

    return `${prefix}${maskLine(body, counter)}`;
  });

  return { text: masked.join('\n'), count: counter.count };
}

export interface MaskedFileReport {
  filePath: string;
  count: number;
}

// 변경 파일 목록의 content/patch를 제자리에서 가리고, 가려진 파일의 건수만 돌려준다
// (로그용 — 값은 포함하지 않는다). patch는 content를 못 가져온 파일(삭제, 미지원 확장자,
// 시크릿 경로)에도 실려 있으므로 content 조회 여부와 무관하게 전부 처리한다.
export function maskChangedFiles(
  files: { filePath: string; content?: string; patch?: string }[],
): MaskedFileReport[] {
  const reports: MaskedFileReport[] = [];
  for (const file of files) {
    let count = 0;
    if (file.content !== undefined) {
      const masked = maskSecrets(file.content);
      file.content = masked.text;
      count += masked.count;
    }
    if (file.patch !== undefined) {
      const masked = maskSecrets(file.patch, { diff: true });
      file.patch = masked.text;
      count += masked.count;
    }
    if (count > 0) reports.push({ filePath: file.filePath, count });
  }
  return reports;
}
