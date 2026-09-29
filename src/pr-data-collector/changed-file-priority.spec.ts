import { sortByReviewPriority } from './changed-file-priority';

const paths = (files: { filePath: string }[]) => files.map((f) => f.filePath);
const toFiles = (list: string[]) => list.map((filePath) => ({ filePath }));

describe('sortByReviewPriority', () => {
  it('소스 → 테스트 → 문서 순으로 정렬한다', () => {
    const sorted = sortByReviewPriority(
      toFiles([
        'README.md',
        'docs/guide.md',
        'src/app.module.ts',
        'src/app.service.spec.ts',
        'test/app.e2e-spec.ts',
      ]),
    );

    expect(paths(sorted)).toEqual([
      'src/app.module.ts',
      'src/app.service.spec.ts',
      'test/app.e2e-spec.ts',
      'README.md',
      'docs/guide.md',
    ]);
  });

  it('같은 등급 안에서는 원래 순서를 유지한다', () => {
    const sorted = sortByReviewPriority(
      toFiles(['src/b.ts', 'src/a.ts', 'src/c.ts']),
    );

    expect(paths(sorted)).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
  });

  it.each([
    'src/foo.spec.ts',
    'src/foo.test.js',
    'pkg/handler_test.go',
    'app/test_pipeline.py',
    'tests/conftest.py',
    'src/__tests__/foo.ts',
    'spec/models/user_spec.rb',
  ])('%s는 테스트로 분류한다', (filePath) => {
    const sorted = sortByReviewPriority(toFiles([filePath, 'src/main.ts']));

    expect(paths(sorted)).toEqual(['src/main.ts', filePath]);
  });

  it.each(['README.md', 'docs/api.yaml', 'CHANGELOG.mdx', 'guide/intro.rst'])(
    '%s는 문서로 분류해 테스트보다도 뒤로 보낸다',
    (filePath) => {
      const sorted = sortByReviewPriority(
        toFiles([filePath, 'src/foo.spec.ts']),
      );

      expect(paths(sorted)).toEqual(['src/foo.spec.ts', filePath]);
    },
  );

  it.each([
    'package.json',
    'Dockerfile',
    '.github/workflows/ci.yml',
    'src/testing-utils.ts',
  ])(
    '%s는 소스/설정으로 분류한다 (이름에 test가 들어가도 패턴이 아니면 소스)',
    (filePath) => {
      const sorted = sortByReviewPriority(
        toFiles(['src/foo.spec.ts', filePath]),
      );

      expect(paths(sorted)).toEqual([filePath, 'src/foo.spec.ts']);
    },
  );
});
