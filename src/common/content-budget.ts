export interface BudgetedFile {
  filePath: string;
  content?: string;
  patch?: string;
}

export interface BudgetResult {
  /** content가 제외된 파일 경로 (hunk만 남음). */
  droppedContent: string[];
  /** content를 다 비워도 총합 상한을 넘어 patch까지 제외된 파일 경로 (파일 항목만 남음). */
  droppedPatch: string[];
}

function byteLength(text: string | undefined): number {
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf-8');
}

// Kafka 브로커의 기본 message.max.bytes(~1MB)를 넘기지 않기 위한 방어.
//
// 1. content 총합이 contentBudgetBytes를 넘으면 큰 파일부터 content를 비운다.
// 2. content + patch 총합이 totalBudgetBytes를 넘으면 content를 더 비우고, 그래도
//    넘으면 patch까지 큰 파일부터 비운다. patch는 GitHub API가 파일 하나 단위로는
//    제한하지만 파일 수가 많은 PR에선 총합이 무제한이라, content만 예산으로 잡으면
//    patch만으로 메시지 크기를 넘겨 발행이 실패하고 리뷰가 통째로 유실될 수 있다.
//    patch가 리뷰의 1차 재료라 content(보조 컨텍스트)를 먼저 포기한다.
//
// 파일 항목(filePath/status) 자체는 항상 남겨 ai-server가 "이 파일이 바뀌었다"는
// 사실은 알 수 있게 한다.
export function enforceContentBudget<T extends BudgetedFile>(
  files: T[],
  contentBudgetBytes: number,
  totalBudgetBytes = Number.POSITIVE_INFINITY,
): BudgetResult {
  const sum = (field: 'content' | 'patch') =>
    files.reduce((acc, file) => acc + byteLength(file[field]), 0);

  let contentTotal = sum('content');
  let patchTotal = sum('patch');

  const dropLargestFirst = (
    field: 'content' | 'patch',
    isWithinBudget: () => boolean,
  ): string[] => {
    const dropped: string[] = [];
    const candidates = files
      .filter((file) => file[field] !== undefined)
      .sort((a, b) => byteLength(b[field]) - byteLength(a[field]));
    for (const file of candidates) {
      if (isWithinBudget()) break;
      const size = byteLength(file[field]);
      if (field === 'content') contentTotal -= size;
      else patchTotal -= size;
      file[field] = undefined;
      dropped.push(file.filePath);
    }
    return dropped;
  };

  const withinTotal = () => contentTotal + patchTotal <= totalBudgetBytes;

  const droppedContent = dropLargestFirst(
    'content',
    () => contentTotal <= contentBudgetBytes && withinTotal(),
  );
  const droppedPatch = dropLargestFirst('patch', withinTotal);

  return { droppedContent, droppedPatch };
}
