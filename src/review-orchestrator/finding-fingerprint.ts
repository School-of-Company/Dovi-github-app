import { createHash } from 'crypto';

// 재리뷰 때 "이미 게시한 지적"을 알아보기 위한 지문. 게시한 코멘트 본문 끝에 눈에 안 보이는
// HTML 주석으로 심어 두므로, Redis 없이 GitHub 코멘트 자체에서 읽어낼 수 있다(Redis를 잃어도
// 중복되지 않고, TTL을 신경 쓸 필요가 없다).
const MARKER_PATTERN = /<!-- dovi:fp=([0-9a-f]{16}) -->/;

interface FingerprintInput {
  filePath: string;
  line: number;
  title: string;
  message: string;
  evidence?: string[];
  // ai-server가 계산해 보내는 지문(Dovi-ai-server#132). 있으면 그대로 쓴다.
  fingerprint?: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// 같은 지적이면 같은 지문이어야 한다.
// - 새 커밋으로 줄이 밀려도 같은 지적으로 인식하도록, evidence(문제의 코드)가 있으면 줄 번호를
//   지문에 넣지 않는다.
// - evidence가 없으면 식별할 근거가 title/message뿐이라 줄 번호까지 넣어 서로 다른 위치의
//   같은 문구 지적이 하나로 뭉개지지 않게 한다.
export function computeFindingFingerprint(finding: FingerprintInput): string {
  if (typeof finding.fingerprint === 'string' && finding.fingerprint.trim()) {
    return hash(`ai|${finding.fingerprint.trim()}`);
  }

  const evidence = normalize(
    Array.isArray(finding.evidence) ? finding.evidence.join('\n') : '',
  );
  const parts =
    evidence !== ''
      ? [finding.filePath, normalize(finding.title), evidence]
      : [
          finding.filePath,
          normalize(finding.title),
          normalize(finding.message ?? ''),
          String(finding.line),
        ];
  return hash(parts.join('|'));
}

export function fingerprintMarker(fingerprint: string): string {
  return `<!-- dovi:fp=${fingerprint} -->`;
}

// 게시된 코멘트 본문에서 지문을 꺼낸다. 이 기능 이전에 게시된 코멘트에는 없다(null).
export function extractFingerprint(
  body: string | null | undefined,
): string | null {
  return MARKER_PATTERN.exec(body ?? '')?.[1] ?? null;
}
