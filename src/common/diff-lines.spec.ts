import { parseCommentableLines } from './diff-lines';

describe('parseCommentableLines', () => {
  it('추가·컨텍스트 줄만 RIGHT 줄 번호로 세고 삭제 줄은 제외한다', () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      ' keep1',
      '-old',
      '+new',
      ' keep2',
      ' keep3',
    ].join('\n');

    expect([...parseCommentableLines(patch)]).toEqual([1, 2, 3, 4]);
  });

  it('여러 hunk의 줄 번호를 각 hunk 헤더 기준으로 센다', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
      '@@ -10,1 +20,3 @@',
      ' x',
      '+y',
      '+z',
    ].join('\n');

    const lines = parseCommentableLines(patch);

    expect([...lines].sort((p, q) => p - q)).toEqual([1, 2, 20, 21, 22]);
    expect(lines.has(10)).toBe(false);
  });

  it('새 파일(@@ -0,0 +1,N @@)은 모든 줄이 대상이다', () => {
    const patch = ['@@ -0,0 +1,3 @@', '+a', '+b', '+c'].join('\n');

    expect([...parseCommentableLines(patch)]).toEqual([1, 2, 3]);
  });

  it('삭제만 있는 hunk는 RIGHT 줄이 없다', () => {
    const patch = ['@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');

    expect(parseCommentableLines(patch).size).toBe(0);
  });

  it('`\\ No newline at end of file`은 줄 번호를 소비하지 않는다', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+c',
      '\\ No newline at end of file',
    ].join('\n');

    expect([...parseCommentableLines(patch)]).toEqual([1, 2]);
  });

  it('공백 없이 온 빈 컨텍스트 줄도 hunk 줄 수 안에서는 컨텍스트로 센다', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '', ' c'].join('\n');

    expect([...parseCommentableLines(patch)]).toEqual([1, 2, 3]);
  });

  it('줄 수 생략(@@ -1 +1 @@)은 1줄로 해석한다', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b'].join('\n');

    expect([...parseCommentableLines(patch)]).toEqual([1]);
  });

  it('hunk가 없는 patch는 빈 집합이다', () => {
    expect(parseCommentableLines('').size).toBe(0);
  });
});
