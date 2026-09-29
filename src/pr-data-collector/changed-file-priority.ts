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

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);
const TEST_FILE_PATTERN =
  /(\.(spec|test)\.[^/]+$)|(_test\.[^/]+$)|(^test_[^/]+\.py$)/i;
const DOC_EXTENSIONS = /\.(md|mdx|rst)$/i;

function priorityOf(filePath: string): Priority {
  const segments = filePath.split('/');
  const fileName = segments[segments.length - 1];

  if (segments[0].toLowerCase() === 'docs' || DOC_EXTENSIONS.test(fileName)) {
    return Priority.Doc;
  }
  if (
    segments.slice(0, -1).some((dir) => TEST_DIRS.has(dir.toLowerCase())) ||
    TEST_FILE_PATTERN.test(fileName)
  ) {
    return Priority.Test;
  }
  return Priority.Source;
}

// 소스·설정 → 테스트 → 문서 순. 같은 등급 안에서는 원래 순서를 유지한다(안정 정렬).
export function sortByReviewPriority<T extends { filePath: string }>(
  files: T[],
): T[] {
  return files
    .map((file, index) => ({
      file,
      index,
      priority: priorityOf(file.filePath),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ file }) => file);
}
