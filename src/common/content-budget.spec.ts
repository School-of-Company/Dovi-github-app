import { enforceContentBudget } from './content-budget';
import type { BudgetedFile } from './content-budget';

function file(
  filePath: string,
  contentBytes?: number,
  patchBytes?: number,
): BudgetedFile {
  return {
    filePath,
    content: contentBytes === undefined ? undefined : 'c'.repeat(contentBytes),
    patch: patchBytes === undefined ? undefined : 'p'.repeat(patchBytes),
  };
}

describe('enforceContentBudget', () => {
  it('content 총합이 예산 이하면 아무것도 비우지 않는다', () => {
    const files = [file('a', 100), file('b', 100)];

    const result = enforceContentBudget(files, 200);

    expect(result).toEqual({ droppedContent: [], droppedPatch: [] });
    expect(files.every((f) => f.content !== undefined)).toBe(true);
  });

  it('content 예산을 넘으면 큰 파일부터 content만 비운다 (patch는 유지)', () => {
    const files = [file('small', 50, 10), file('big', 300, 10)];

    const result = enforceContentBudget(files, 200);

    expect(result).toEqual({ droppedContent: ['big'], droppedPatch: [] });
    expect(files[1].content).toBeUndefined();
    expect(files[1].patch).toBeDefined();
  });

  it('총합 상한이 없으면 patch는 아무리 커도 건드리지 않는다 (기존 동작 유지)', () => {
    const files = [file('a', undefined, 10_000)];

    const result = enforceContentBudget(files, 200);

    expect(result.droppedPatch).toEqual([]);
    expect(files[0].patch).toBeDefined();
  });

  it('content+patch 총합이 상한을 넘으면 content를 먼저 더 비운다', () => {
    // content 150 (예산 200 이내) + patch 100 = 250 > 총합 상한 200
    const files = [file('a', 150, 50), file('b', undefined, 50)];

    const result = enforceContentBudget(files, 200, 200);

    expect(result).toEqual({ droppedContent: ['a'], droppedPatch: [] });
    expect(files[0].patch).toBeDefined();
  });

  it('content를 다 비워도 총합 상한을 넘으면 큰 patch부터 비운다', () => {
    const files = [
      file('small-patch', undefined, 50),
      file('big-patch', undefined, 300),
      file('mid-patch', undefined, 100),
    ];

    const result = enforceContentBudget(files, 1000, 200);

    expect(result.droppedPatch).toEqual(['big-patch']);
    expect(
      files.find((f) => f.filePath === 'big-patch')?.patch,
    ).toBeUndefined();
    expect(
      files.find((f) => f.filePath === 'small-patch')?.patch,
    ).toBeDefined();
  });

  it('patch를 비워도 파일 항목 자체는 남긴다', () => {
    const files = [file('huge', undefined, 1000)];

    enforceContentBudget(files, 1000, 100);

    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe('huge');
  });

  it('바이트 단위(UTF-8)로 계산한다', () => {
    // 한글 한 글자 = 3바이트 → 100글자 = 300바이트 > 예산 200
    const files: BudgetedFile[] = [
      { filePath: 'ko', content: '가'.repeat(100) },
    ];

    const result = enforceContentBudget(files, 200);

    expect(result.droppedContent).toEqual(['ko']);
  });
});
