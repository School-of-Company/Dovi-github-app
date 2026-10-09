import { matchesGlob } from './glob';

describe('matchesGlob', () => {
  it.each([
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/deep/er/a.ts', true],
    ['src/**', 'lib/a.ts', false],
    ['src/**', 'src', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/a.ts', true],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['**/*.ts', 'src/a.js', false],
    ['src/**/a.ts', 'src/a.ts', true],
    ['src/**/a.ts', 'src/x/y/a.ts', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['src/a?.ts', 'src/ab.ts', true],
    ['src/a?.ts', 'src/a/.ts', false],
    ['docs/**/*.md', 'docs/guide/intro.md', true],
  ])('%s 는 %s 에 대해 %s', (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected);
  });

  it.each([
    ['*.lock', 'yarn.lock', true],
    ['*.lock', 'frontend/yarn.lock', true],
    ['Dockerfile', 'services/api/Dockerfile', true],
    ['*.generated.ts', 'src/gen/user.generated.ts', true],
    ['*.lock', 'src/lockfile.ts', false],
  ])(
    '슬래시 없는 패턴 %s 는 어느 디렉터리의 파일 이름에든 매치한다 (%s → %s)',
    (pattern, path, expected) => {
      expect(matchesGlob(pattern, path)).toBe(expected);
    },
  );

  it('{a,b} 대안을 지원한다', () => {
    expect(matchesGlob('src/**/*.{ts,tsx}', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/**/*.{ts,tsx}', 'src/ui/b.tsx')).toBe(true);
    expect(matchesGlob('src/**/*.{ts,tsx}', 'src/c.js')).toBe(false);
  });

  it('정규식 특수문자는 글자 그대로 취급한다', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('a.b', 'axb')).toBe(false);
    expect(matchesGlob('src/(core)/a+b.ts', 'src/(core)/a+b.ts')).toBe(true);
  });

  it('./ 로 시작하는 패턴도 처리한다', () => {
    expect(matchesGlob('./src/**', 'src/a.ts')).toBe(true);
  });

  it('닫히지 않은 { 같은 잘못된 패턴은 아무것도 매치하지 않는다', () => {
    expect(matchesGlob('src/{a,b', 'src/a')).toBe(false);
    expect(matchesGlob('src/{a,b', 'src/{a,b')).toBe(false);
  });

  it('대소문자를 구분한다', () => {
    expect(matchesGlob('src/**', 'SRC/a.ts')).toBe(false);
  });
});
