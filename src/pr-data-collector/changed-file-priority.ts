// ai-server는 받은 changedFiles 순서대로 리뷰 대상을 만들고, diff 예산이 차면
// 나머지 파일을 리뷰에서 뺀다(Dovi-ai-server app/review/diff.py의 analyze(),
// pipeline.py의 _MAX_DIFF_TOTAL_CHARS). GitHub가 주는 파일명순 그대로 보내면
// README/docs가 src보다 앞에 와서 예산을 먼저 차지하므로, 리뷰 가치가 높은 파일이
// 앞에 오도록 정렬한다.
//
// lockfile·바이너리·생성 파일은 ai-server가 어차피 건너뛰므로 따로 다루지 않는다.

const enum Priority {
  Source = 0,
  Test = 1,
  Doc = 2,
}

// 픽스처·목·스냅샷 디렉터리도 테스트 등급으로 보낸다. 큰 JSON 픽스처가 소스 등급에
// 남으면 소스보다 먼저 예산을 차지할 수 있다.
const TEST_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'e2e',
  '__mocks__',
  '__snapshots__',
  '__fixtures__',
  'fixtures',
  'testdata',
]);
const TEST_FILE_PATTERN =
  /(\.(spec|test|e2e-spec)\.[^/]+$)|(_(test|spec)\.[^/]+$)|(^test_[^/]+\.py$)/i;
// JUnit/Kotest/XCTest 관례(FooTest.java, FooTests.kt, FooSpec.kt). 대소문자를 구분해야
// latest.java·contest.kt 같은 이름이 걸리지 않는다.
const JVM_STYLE_TEST_FILE_PATTERN =
  /[a-z0-9](Test|Tests|Spec)\.(java|kt|kts|scala|groovy|swift|cs)$/;
const DOC_EXTENSIONS = /\.(md|mdx|rst)$/i;
// 파일명 기반 테스트 판정에서 뺄 데이터 파일. openapi.spec.yaml 같은 API 명세는
// 이름에 .spec.이 들어가도 테스트가 아니라 계약이다(픽스처 디렉터리 안이면 그쪽 규칙으로 테스트).
const DATA_EXTENSIONS = /\.(ya?ml|json|toml)$/i;
// 확장자는 .md지만 에이전트/코딩 어시스턴트 동작을 정하는 지시 파일. 문서로 밀면
// 이런 파일이 핵심 변경인 PR에서 가장 먼저 리뷰 예산에서 잘린다.
const INSTRUCTION_FILE_NAMES = new Set([
  'claude.md',
  'agents.md',
  'gemini.md',
  'skill.md',
  'copilot-instructions.md',
]);

function isInstructionFile(segments: string[], fileName: string): boolean {
  // .claude/, .agents/, .github/, .cursor/ 같은 점 디렉터리 아래 md는 설정으로 본다.
  return (
    INSTRUCTION_FILE_NAMES.has(fileName.toLowerCase()) ||
    (segments.length > 1 && segments[0].startsWith('.'))
  );
}

function priorityOf(filePath: string): Priority {
  const segments = filePath.split('/');
  const fileName = segments[segments.length - 1];

  if (
    (segments[0].toLowerCase() === 'docs' || DOC_EXTENSIONS.test(fileName)) &&
    !isInstructionFile(segments, fileName)
  ) {
    return Priority.Doc;
  }
  const isDataFile = DATA_EXTENSIONS.test(fileName);
  if (
    segments.slice(0, -1).some((dir) => TEST_DIRS.has(dir.toLowerCase())) ||
    (!isDataFile && TEST_FILE_PATTERN.test(fileName)) ||
    JVM_STYLE_TEST_FILE_PATTERN.test(fileName)
  ) {
    return Priority.Test;
  }
  return Priority.Source;
}

// 소스·설정 → 테스트 → 문서 순. Array.prototype.sort는 안정 정렬(ES2019+)이라
// 같은 등급 안에서는 원래 순서가 유지된다.
export function sortByReviewPriority<T extends { filePath: string }>(
  files: T[],
): T[] {
  return files
    .map((file) => ({ file, priority: priorityOf(file.filePath) }))
    .sort((a, b) => a.priority - b.priority)
    .map(({ file }) => file);
}
