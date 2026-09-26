// 헤더 아래 첫 비어있지 않은 줄을 값으로 반환한다. 다음 헤더(#으로 시작)를 만나면
// 값이 없는 것으로 간주해 null을 반환한다. parseIndexBranch/parseSandboxProbeOptIn이
// 공유하는 파싱 로직.
function parseHeaderValue(
  markdown: string,
  headerPattern: RegExp,
): string | null {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex((line) =>
    headerPattern.test(line.trim()),
  );
  if (headerIndex === -1) return null;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) return null;
    return trimmed;
  }
  return null;
}

// DOVI.md에 아래처럼 명시된 인덱싱 기준 브랜치를 읽어온다 (repo-index 이슈 참고):
//
// ## Index Branch
// develop
//
// 헤더 다음의 첫 비어있지 않은 줄을 값으로 사용하고, 다음 헤더(#으로 시작)를 만나면 중단한다.
export function parseIndexBranch(markdown: string): string | null {
  return parseHeaderValue(markdown, /^#+\s*index branch\s*$/i);
}

// 샌드박스 프로브(빌드/기동 검증)를 이 레포에서 켤지 여부. 조직 전체 설치 상태에서
// 스택 감지만으로 모든 NestJS 레포가 자동 대상이 되는 걸 막기 위해 레포별 opt-in이
// 필요하다 — 섹션이 없거나 값이 true/on/enabled/yes 가 아니면 꺼진 것으로 본다.
//
// ## Sandbox Probe
// true
export function parseSandboxProbeOptIn(markdown: string): boolean {
  const value = parseHeaderValue(markdown, /^#+\s*sandbox probe\s*$/i);
  if (value === null) return false;
  return /^(true|on|enabled|yes)$/i.test(value);
}
