// PR 파일 patch(unified diff)에서 리뷰 코멘트를 달 수 있는 RIGHT(새 파일 기준) 줄 번호를 모은다.
// `+` 줄과 컨텍스트 줄만 RIGHT에 해당하고, `-` 줄과 `\ No newline at end of file`은 제외한다.
// hunk 헤더의 줄 수(`-a,b +c,d`)로 hunk 끝을 판단해, 내용이 빈 컨텍스트 줄이 공백 없이
// 와도 안전하게 센다.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseCommentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  const rows = patch.split('\n');

  let i = 0;
  while (i < rows.length) {
    const header = HUNK_HEADER.exec(rows[i]);
    i += 1;
    if (!header) continue;

    let oldRemaining = header[1] === undefined ? 1 : Number(header[1]);
    let newRemaining = header[3] === undefined ? 1 : Number(header[3]);
    let newLine = Number(header[2]);

    while (i < rows.length && (oldRemaining > 0 || newRemaining > 0)) {
      const row = rows[i];
      i += 1;
      if (row.startsWith('\\')) continue;
      if (row.startsWith('-')) {
        oldRemaining -= 1;
      } else if (row.startsWith('+')) {
        lines.add(newLine);
        newLine += 1;
        newRemaining -= 1;
      } else {
        lines.add(newLine);
        newLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
      }
    }
  }

  return lines;
}
