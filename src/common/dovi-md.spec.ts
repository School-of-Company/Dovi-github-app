import { parseIndexBranch } from './dovi-md';

describe('parseIndexBranch', () => {
  it('Index Branch 섹션 다음 줄을 브랜치명으로 반환한다', () => {
    const markdown = [
      '# DOVI Project Context',
      '',
      '## Index Branch',
      'develop',
      '',
    ].join('\n');
    expect(parseIndexBranch(markdown)).toBe('develop');
  });

  it('헤더 레벨이 달라도(#, ###) 매칭한다', () => {
    expect(parseIndexBranch('# Index Branch\nfeature/x')).toBe('feature/x');
    expect(parseIndexBranch('### Index Branch\nfeature/x')).toBe('feature/x');
  });

  it('대소문자를 구분하지 않는다', () => {
    expect(parseIndexBranch('## index branch\nmain')).toBe('main');
  });

  it('헤더와 값 사이 빈 줄은 건너뛴다', () => {
    expect(parseIndexBranch('## Index Branch\n\n\ndevelop')).toBe('develop');
  });

  it('값 없이 바로 다음 헤더가 나오면 null을 반환한다', () => {
    expect(parseIndexBranch('## Index Branch\n## Next Section')).toBeNull();
  });

  it('섹션 자체가 없으면 null을 반환한다', () => {
    expect(parseIndexBranch('# DOVI Project Context\n내용')).toBeNull();
  });
});
