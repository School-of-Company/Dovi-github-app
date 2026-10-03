import {
  appendUnanchoredFindings,
  buildReviewComments,
  formatReviewSummary,
} from './review-comment.formatter';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';

describe('formatReviewSummary', () => {
  it('summary 앞에 고정 헤더를 붙인다', () => {
    expect(formatReviewSummary('요약 내용')).toBe('# Code Review\n\n요약 내용');
  });
});

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

  it('critical severity여도 suggestedFix를 suggestion 블록이 아닌 평문으로 렌더링한다', () => {
    const [{ body }] = buildReviewComments([
      {
        ...baseFinding,
        severity: 'critical',
        suggestedFix: '이 부분을 이렇게 바꾸는 게 좋습니다.',
      },
    ]);

    expect(body).not.toContain('```suggestion');
    expect(body).toContain('제안: 이 부분을 이렇게 바꾸는 게 좋습니다.');
  });

  describe('appendUnanchoredFindings', () => {
    it('finding이 없으면 본문을 그대로 돌려준다', () => {
      expect(appendUnanchoredFindings('# Code Review\n\nok', [])).toBe(
        '# Code Review\n\nok',
      );
    });

    it('위치를 특정할 수 없는 finding을 파일:줄과 함께 본문 끝에 모은다', () => {
      const result = appendUnanchoredFindings('# Code Review\n\nok', [
        { path: 'a.spec.ts', line: 109, body: '**[major] 제목**\n\n설명' },
      ]);

      expect(result).toContain('# Code Review\n\nok');
      expect(result).toContain('### 위치를 특정할 수 없는 지적사항');
      expect(result).toContain('`a.spec.ts:109`');
      expect(result).toContain('**[major] 제목**');
    });

    it('10건까지만 싣고 나머지는 "외 N건"으로 표기한다', () => {
      const findings = Array.from({ length: 13 }, (_, i) => ({
        path: `f${i}.ts`,
        line: i + 1,
        body: `body-${i}`,
      }));

      const result = appendUnanchoredFindings('body', findings);

      expect(result).toContain('`f9.ts:10`');
      expect(result).not.toContain('`f10.ts:11`');
      expect(result).toContain('외 3건');
    });

    it('10건 이하면 "외 N건"을 붙이지 않는다', () => {
      const result = appendUnanchoredFindings('body', [
        { path: 'a.ts', line: 1, body: 'x' },
      ]);

      expect(result).not.toContain('외 ');
    });

    it('GitHub 본문 길이 상한을 넘지 않도록 자른다', () => {
      const result = appendUnanchoredFindings('body', [
        { path: 'a.ts', line: 1, body: 'x'.repeat(70000) },
      ]);

      expect(result.length).toBeLessThan(65536);
      expect(result).toContain('길이 제한으로 일부 생략');
    });
  });
});
