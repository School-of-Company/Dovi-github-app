import {
  appendUnanchoredFindings,
  buildReviewComments,
  formatReviewSummary,
} from './review-comment.formatter';
import { extractFingerprint } from './finding-fingerprint';
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

  it('코멘트 본문 끝에 지문 마커를 심고 fingerprint 필드와 일치한다', () => {
    const [comment] = buildReviewComments([baseFinding]);

    expect(comment.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(comment.body.trimEnd().endsWith('-->')).toBe(true);
    expect(extractFingerprint(comment.body)).toBe(comment.fingerprint);
  });

  it('같은 지적은 같은 지문, 다른 지적은 다른 지문이다', () => {
    const [a, a2, b] = buildReviewComments([
      baseFinding,
      { ...baseFinding },
      { ...baseFinding, title: '다른 지적' },
    ]);

    expect(a.fingerprint).toBe(a2.fingerprint);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

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

    it('긴 경로 대신 파일명:줄만 보여 주고 해당 커밋의 그 줄로 가는 링크를 건다', () => {
      const result = appendUnanchoredFindings(
        'body',
        [
          {
            path: 'src/main/java/com/example/order/OrderService.java',
            line: 57,
            body: '설명',
          },
        ],
        { owner: 'org', repo: 'repo', sha: 'abc123' },
      );

      expect(result).toContain(
        '#### [`OrderService.java:57`](https://github.com/org/repo/blob/abc123/src/main/java/com/example/order/OrderService.java#L57)',
      );
      expect(result).not.toContain('#### `src/main');
    });

    it('경로의 특수문자는 링크에서 인코딩한다', () => {
      const result = appendUnanchoredFindings(
        'body',
        [{ path: 'docs/가이드 문서.md', line: 3, body: 'x' }],
        { owner: 'org', repo: 'repo', sha: 'abc' },
      );

      expect(result).toContain(
        '/blob/abc/docs/%EA%B0%80%EC%9D%B4%EB%93%9C%20%EB%AC%B8%EC%84%9C.md#L3',
      );
    });

    it('같은 파일명이 서로 다른 경로에 있으면 상위 디렉터리를 붙여 구분한다', () => {
      const result = appendUnanchoredFindings('body', [
        { path: 'src/a/index.ts', line: 1, body: 'x' },
        { path: 'src/b/index.ts', line: 2, body: 'y' },
        { path: 'src/c/main.ts', line: 3, body: 'z' },
      ]);

      expect(result).toContain('#### `a/index.ts:1`');
      expect(result).toContain('#### `b/index.ts:2`');
      expect(result).toContain('#### `main.ts:3`');
    });

    it('링크 기준이 없으면 링크 없이 파일명:줄만 표시한다', () => {
      const result = appendUnanchoredFindings('body', [
        { path: 'src/a.ts', line: 9, body: 'x' },
      ]);

      expect(result).toContain('#### `a.ts:9`');
      expect(result).not.toContain('https://');
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
