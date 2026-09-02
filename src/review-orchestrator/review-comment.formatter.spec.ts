import { buildReviewComments } from './review-comment.formatter';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';

describe('buildReviewComments', () => {
  const baseFinding: ReviewCompletedPayload['reviews'][number] = {
    severity: 'minor',
    confidence: 0.5,
    filePath: 'a.ts',
    line: 1,
    title: 'title',
    message: 'msg',
    evidence: [],
  };

  it('evidence가 있으면 diff 코드블록으로 감싸 원문 라인이 불릿과 섞이지 않게 한다', () => {
    const [{ body }] = buildReviewComments([
      {
        ...baseFinding,
        evidence: ['-from foo', '+from bar'],
      },
    ]);

    expect(body).toContain('```diff\n-from foo\n+from bar\n```');
    expect(body).not.toContain('- -from foo');
    expect(body).not.toContain('- +from bar');
  });

  it('evidence가 비어있으면 diff 블록을 추가하지 않는다', () => {
    const [{ body }] = buildReviewComments([baseFinding]);

    expect(body).not.toContain('```diff');
  });
});
