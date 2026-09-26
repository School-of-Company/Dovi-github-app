import type {
  SandboxProbeCompletedPayload,
  SandboxProbeFinding,
  SandboxProbeStatus,
} from './dto/sandbox-probe-completed.payload';

// 이 마커가 있는 코멘트를 찾아 upsert한다(재푸시마다 코멘트가 쌓이지 않도록).
export const SANDBOX_PROBE_STICKY_MARKER = '<!-- dovi:sandbox-probe -->';

const MAX_EVIDENCE_LENGTH = 8 * 1024;
const MAX_FINDING_EVIDENCE_LENGTH = 4 * 1024;
const MAX_FINDINGS = 10;
// GitHub 코멘트 본문 상한(65536자) 아래 여유를 둔다.
const MAX_COMMENT_BODY_LENGTH = 60_000;

const STATUS_LABEL: Record<SandboxProbeStatus, string> = {
  passed: '✅ 통과',
  found_issue: '🐛 문제 발견',
  inconclusive: '⚠️ 판단 불가',
};

// "@" 바로 뒤에 영숫자/하이픈이 이어지면 GitHub이 멘션으로 파싱해 알림을 보낸다.
// evidence/title/message는 프로브가 실행한 임의 코드의 출력(에러 메시지, 로그)을
// 담을 수 있어, zero-width space를 끼워 넣어 파싱을 무력화한다.
function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[a-zA-Z0-9])/g, '@​');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n… (truncated)`;
}

// evidence 안에 백틱 런이 있어도 코드펜스가 깨지지 않도록, 텍스트 안의 가장 긴
// 백틱 런보다 긴 펜스를 쓴다.
function fence(text: string): string {
  const runs = text.match(/`+/g)?.map((run) => run.length) ?? [];
  const longestRun = runs.length > 0 ? Math.max(...runs) : 0;
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

function formatFinding(finding: SandboxProbeFinding, index: number): string {
  const location =
    finding.filePath !== null
      ? ` (\`${finding.filePath}${finding.line !== null ? `:${finding.line}` : ''}\`)`
      : '';
  const evidence = truncate(finding.evidence, MAX_FINDING_EVIDENCE_LENGTH);

  const parts = [
    `**${index + 1}. [${finding.probe}] ${neutralizeMentions(finding.title)}**${location}`,
    '',
    neutralizeMentions(finding.message),
  ];
  if (evidence.trim() !== '') {
    parts.push('', fence(neutralizeMentions(evidence)));
  }
  return parts.join('\n');
}

export function formatSandboxProbeComment(
  payload: SandboxProbeCompletedPayload,
): string {
  const lines = [
    SANDBOX_PROBE_STICKY_MARKER,
    `## ${STATUS_LABEL[payload.status]} — 샌드박스 프로브 (커밋 \`${payload.headSha.slice(0, 7)}\`)`,
    '',
  ];

  const evidence = truncate(payload.evidence, MAX_EVIDENCE_LENGTH);
  if (evidence.trim() !== '') {
    lines.push(fence(neutralizeMentions(evidence)), '');
  }

  if (payload.findings.length > 0) {
    lines.push('### 상세', '');
    payload.findings
      .slice(0, MAX_FINDINGS)
      .forEach((finding, index) =>
        lines.push(formatFinding(finding, index), ''),
      );
  }

  return truncate(lines.join('\n').trimEnd(), MAX_COMMENT_BODY_LENGTH);
}
