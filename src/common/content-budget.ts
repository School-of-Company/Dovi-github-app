export interface BudgetedFile {
  filePath: string;
  content?: string;
}

// content 총합이 예산을 넘으면 큰 파일부터 content를 비운다(파일 자체 메타데이터는 유지).
// Kafka 브로커의 기본 message.max.bytes(~1MB)를 넘기지 않기 위한 방어.
// 반환값은 content가 제외된 파일 경로 목록(로깅용).
export function enforceContentBudget<T extends BudgetedFile>(
  files: T[],
  totalBudgetBytes: number,
): string[] {
  const withContent = files.filter((file) => file.content !== undefined);
  let total = withContent.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content!, 'utf-8'),
    0,
  );
  if (total <= totalBudgetBytes) return [];

  const dropped: string[] = [];
  const sorted = [...withContent].sort(
    (a, b) =>
      Buffer.byteLength(b.content!, 'utf-8') -
      Buffer.byteLength(a.content!, 'utf-8'),
  );
  for (const file of sorted) {
    if (total <= totalBudgetBytes) break;
    total -= Buffer.byteLength(file.content!, 'utf-8');
    file.content = undefined;
    dropped.push(file.filePath);
  }
  return dropped;
}
