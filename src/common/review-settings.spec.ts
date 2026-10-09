import {
  capInlineComments,
  isReviewTarget,
  meetsMinSeverity,
  parseReviewSettings,
  severityRank,
} from './review-settings';

const doc = (...lines: string[]) =>
  [
    '# DOVI',
    '',
    '## Review Settings',
    ...lines,
    '',
    '## Index Branch',
    'develop',
  ].join('\n');

describe('parseReviewSettings', () => {
  it('섹션이 없으면 기본값(제한 없음)이고 경고도 없다', () => {
    const { settings, warnings } = parseReviewSettings('# DOVI\n내용');

    expect(settings).toEqual({ include: [], exclude: [] });
    expect(warnings).toEqual([]);
  });

  it('모든 설정을 읽는다', () => {
    const { settings, warnings } = parseReviewSettings(
      doc(
        'minSeverity: major',
        'maxInlineComments: 10',
        'include: src/**, lib/**',
        'exclude: **/*.generated.ts, docs/**',
      ),
    );

    expect(settings).toEqual({
      minSeverity: 'major',
      maxInlineComments: 10,
      include: ['src/**', 'lib/**'],
      exclude: ['**/*.generated.ts', 'docs/**'],
    });
    expect(warnings).toEqual([]);
  });

  it('키는 대소문자를 구분하지 않고, 목록 기호(-)와 섹션 레벨(#, ###)도 허용한다', () => {
    const { settings } = parseReviewSettings(
      [
        '### review settings',
        '- MINSEVERITY: Critical',
        '* maxinlinecomments: 5',
      ].join('\n'),
    );

    expect(settings.minSeverity).toBe('critical');
    expect(settings.maxInlineComments).toBe(5);
  });

  it('nit은 가장 낮은 단계(suggestion)의 별칭이다', () => {
    expect(
      parseReviewSettings(doc('minSeverity: nit')).settings.minSeverity,
    ).toBe('suggestion');
  });

  it('다음 섹션을 넘어서는 읽지 않는다', () => {
    const { settings } = parseReviewSettings(
      doc('minSeverity: major').replace('develop', 'minSeverity: critical'),
    );

    expect(settings.minSeverity).toBe('major');
  });

  describe('잘못된 값은 그 항목만 기본값으로 두고 경고한다', () => {
    it.each([
      ['minSeverity: urgent', 'minSeverity'],
      ['maxInlineComments: 0', 'maxInlineComments'],
      ['maxInlineComments: 101', 'maxInlineComments'],
      ['maxInlineComments: -3', 'maxInlineComments'],
      ['maxInlineComments: 2.5', 'maxInlineComments'],
      ['maxInlineComments: many', 'maxInlineComments'],
      ['colour: red', '알 수 없는 설정'],
      ['그냥 문장', '형식이 아니라'],
    ])('%s', (line, warningPart) => {
      const { settings, warnings } = parseReviewSettings(doc(line));

      expect(settings.minSeverity).toBeUndefined();
      expect(settings.maxInlineComments).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(warningPart);
    });

    it('잘못된 항목이 있어도 올바른 항목은 적용한다', () => {
      const { settings, warnings } = parseReviewSettings(
        doc('minSeverity: urgent', 'maxInlineComments: 7'),
      );

      expect(settings.maxInlineComments).toBe(7);
      expect(warnings).toHaveLength(1);
    });
  });

  it('glob은 최대 50개, 패턴 하나는 200자까지만 받는다', () => {
    const many = Array.from({ length: 60 }, (_, i) => `d${i}/**`).join(', ');
    const long = `x${'a'.repeat(250)}`;

    const parsed = parseReviewSettings(
      doc(`exclude: ${many}`, `include: ${long}, ok/**`),
    );

    expect(parsed.settings.exclude).toHaveLength(50);
    expect(parsed.settings.include).toEqual(['ok/**']);
    expect(parsed.warnings.some((w) => w.includes('최대 50개'))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes('200자'))).toBe(true);
  });

  it.each([
    ['true', true],
    ['ON', true],
    ['yes', true],
    ['false', false],
    ['off', false],
  ])('incrementalReview: %s', (value, expected) => {
    const { settings, warnings } = parseReviewSettings(
      doc(`incrementalReview: ${value}`),
    );

    expect(settings.incrementalReview).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it('incrementalReview가 불리언이 아니면 무시하고 경고한다 (꺼짐 = 전체 리뷰)', () => {
    const { settings, warnings } = parseReviewSettings(
      doc('incrementalReview: maybe'),
    );

    expect(settings.incrementalReview).toBeUndefined();
    expect(warnings.join('\n')).toContain('incrementalReview');
  });

  it('빈 값(include: )은 빈 목록이다', () => {
    expect(parseReviewSettings(doc('include:')).settings.include).toEqual([]);
  });
});

describe('severity', () => {
  it('critical > major > minor > suggestion 순이다', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('major'));
    expect(severityRank('major')).toBeGreaterThan(severityRank('minor'));
    expect(severityRank('minor')).toBeGreaterThan(severityRank('suggestion'));
  });

  it('최소 심각도 이상만 통과한다', () => {
    expect(meetsMinSeverity('major', 'major')).toBe(true);
    expect(meetsMinSeverity('critical', 'major')).toBe(true);
    expect(meetsMinSeverity('minor', 'major')).toBe(false);
    expect(meetsMinSeverity('suggestion', 'minor')).toBe(false);
    expect(meetsMinSeverity('suggestion', 'suggestion')).toBe(true);
  });

  it('알 수 없는 심각도는 가장 낮은 단계로 본다', () => {
    expect(severityRank('weird')).toBe(0);
  });
});

describe('isReviewTarget', () => {
  const none = { include: [], exclude: [] };

  it('설정이 없으면 전부 대상이다', () => {
    expect(isReviewTarget('src/a.ts', none)).toBe(true);
  });

  it('include가 있으면 그중 하나에 매치해야 한다', () => {
    const s = { include: ['src/**'], exclude: [] };

    expect(isReviewTarget('src/a.ts', s)).toBe(true);
    expect(isReviewTarget('docs/a.md', s)).toBe(false);
  });

  it('exclude에 매치하면 제외한다', () => {
    const s = { include: [], exclude: ['**/*.generated.ts', 'docs/**'] };

    expect(isReviewTarget('src/user.generated.ts', s)).toBe(false);
    expect(isReviewTarget('docs/a.md', s)).toBe(false);
    expect(isReviewTarget('src/user.ts', s)).toBe(true);
  });

  it('include와 exclude가 모두 매치하면 exclude가 이긴다', () => {
    const s = { include: ['src/**'], exclude: ['src/gen/**'] };

    expect(isReviewTarget('src/a.ts', s)).toBe(true);
    expect(isReviewTarget('src/gen/a.ts', s)).toBe(false);
  });
});

describe('capInlineComments', () => {
  const c = (id: string, severity: string) => ({ id, severity });

  it('상한이 없거나 이하면 그대로 둔다', () => {
    const list = [c('a', 'minor'), c('b', 'major')];

    expect(capInlineComments(list, undefined)).toEqual({
      inline: list,
      overflow: [],
    });
    expect(capInlineComments(list, 2)).toEqual({ inline: list, overflow: [] });
  });

  it('상한을 넘으면 심각도가 높은 것을 남기고 나머지는 overflow로 돌려준다', () => {
    const list = [
      c('a', 'suggestion'),
      c('b', 'critical'),
      c('c', 'minor'),
      c('d', 'major'),
    ];

    const { inline, overflow } = capInlineComments(list, 2);

    expect(inline.map((x) => x.id)).toEqual(['b', 'd']);
    expect(overflow.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('남긴 코멘트는 원래 순서를 유지하고, 같은 심각도는 앞선 것이 우선이다', () => {
    const list = [c('a', 'major'), c('b', 'major'), c('c', 'major')];

    const { inline, overflow } = capInlineComments(list, 2);

    expect(inline.map((x) => x.id)).toEqual(['a', 'b']);
    expect(overflow.map((x) => x.id)).toEqual(['c']);
  });

  it('남은 칸이 0이면 전부 overflow다', () => {
    const list = [c('a', 'major')];

    expect(capInlineComments(list, 0)).toEqual({ inline: [], overflow: list });
  });
});
