// DOVI.md에 아래처럼 명시된 인덱싱 기준 브랜치를 읽어온다 (repo-index 이슈 참고):
//
// ## Index Branch
// develop
//
// 헤더 다음의 첫 비어있지 않은 줄을 값으로 사용하고, 다음 헤더(#으로 시작)를 만나면 중단한다.
export function parseIndexBranch(markdown: string): string | null {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex((line) =>
    /^#+\s*index branch\s*$/i.test(line.trim()),
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
