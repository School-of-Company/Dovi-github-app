// 레포별 리뷰 설정(DOVI.md의 include/exclude)용 최소 glob 매처. 의존성을 늘리지 않으려고 필요한
// 문법만 지원한다.
//   **   경로 구분자(/)를 넘어 모든 것에 매치 (`src/**`, `**/*.generated.ts`)
//   *    한 경로 조각 안의 모든 문자(/ 제외)
//   ?    한 글자(/ 제외)
//   {a,b} 둘 중 하나
// 슬래시가 없는 패턴(`*.lock`, `Dockerfile`)은 .gitignore처럼 어느 디렉터리에 있든 파일 이름에
// 매치한다. 대소문자를 구분한다.

function escapeRegex(char: string): string {
  return /[.+^$()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function toRegex(pattern: string): RegExp {
  let source = '';
  let braceDepth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/`는 "0개 이상의 디렉터리"라서 `src/**/a.ts`가 `src/a.ts`에도 매치한다.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      braceDepth++;
      source += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--;
      source += ')';
    } else if (char === ',' && braceDepth > 0) {
      source += '|';
    } else {
      source += escapeRegex(char);
    }
  }
  // 닫히지 않은 `{`는 잘못된 패턴이라 매치하지 않게 한다.
  if (braceDepth > 0) return /(?!)/;
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  const normalized = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  const regex = toRegex(normalized);
  if (regex.test(path)) return true;

  // 슬래시 없는 패턴은 파일 이름에 매치한다.
  if (!normalized.includes('/')) {
    return regex.test(path.slice(path.lastIndexOf('/') + 1));
  }
  return false;
}
