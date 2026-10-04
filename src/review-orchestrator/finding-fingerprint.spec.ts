import {
  computeFindingFingerprint,
  extractFingerprint,
  fingerprintMarker,
} from './finding-fingerprint';

const base = {
  filePath: 'src/a.ts',
  line: 10,
  title: 'Null 체크 누락',
  message: 'user가 null일 수 있습니다.',
  evidence: ['const name = user.name;'],
};

describe('computeFindingFingerprint', () => {
  it('16자리 hex를 돌려준다', () => {
    expect(computeFindingFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('같은 지적이면 같은 지문이다', () => {
    expect(computeFindingFingerprint(base)).toBe(
      computeFindingFingerprint({ ...base }),
    );
  });

  it('공백·대소문자 차이는 같은 지문이다', () => {
    const noisy = {
      ...base,
      title: '  NULL   체크  누락 ',
      evidence: ['const   name  =  user.name;'],
    };

    expect(computeFindingFingerprint(noisy)).toBe(
      computeFindingFingerprint(base),
    );
  });

  it('evidence가 있으면 줄이 밀려도(새 커밋) 같은 지적으로 인식한다', () => {
    expect(computeFindingFingerprint({ ...base, line: 42 })).toBe(
      computeFindingFingerprint(base),
    );
  });

  it('message가 달라져도 title과 evidence가 같으면 같은 지적이다 (모델이 문구를 다시 쓰는 경우)', () => {
    expect(
      computeFindingFingerprint({ ...base, message: '다른 설명 문구입니다.' }),
    ).toBe(computeFindingFingerprint(base));
  });

  it.each([
    ['파일이 다르면', { filePath: 'src/b.ts' }],
    ['제목이 다르면', { title: '다른 문제' }],
    ['evidence가 다르면', { evidence: ['const other = x.y;'] }],
  ])('%s 다른 지문이다', (_label, override) => {
    expect(computeFindingFingerprint({ ...base, ...override })).not.toBe(
      computeFindingFingerprint(base),
    );
  });

  it('evidence가 없으면 줄 번호까지 포함해 서로 다른 위치의 같은 문구를 구분한다', () => {
    const noEvidence = { ...base, evidence: [] };

    expect(computeFindingFingerprint({ ...noEvidence, line: 10 })).not.toBe(
      computeFindingFingerprint({ ...noEvidence, line: 20 }),
    );
    expect(computeFindingFingerprint({ ...noEvidence, line: 10 })).toBe(
      computeFindingFingerprint({ ...noEvidence, line: 10 }),
    );
  });

  it('evidence가 배열이 아니어도 예외 없이 처리한다', () => {
    const malformed = { ...base, evidence: undefined as unknown as string[] };

    expect(() => computeFindingFingerprint(malformed)).not.toThrow();
  });

  it('ai-server가 보낸 fingerprint가 있으면 그것을 기준으로 한다', () => {
    const a = computeFindingFingerprint({ ...base, fingerprint: 'abc123' });
    const b = computeFindingFingerprint({
      ...base,
      title: '완전히 다른 제목',
      evidence: ['전혀 다른 코드'],
      fingerprint: 'abc123',
    });

    expect(a).toBe(b);
    expect(a).not.toBe(computeFindingFingerprint(base));
  });
});

describe('fingerprintMarker / extractFingerprint', () => {
  it('마커를 만들고 코멘트 본문에서 다시 꺼낼 수 있다', () => {
    const fp = computeFindingFingerprint(base);
    const body = `**[minor] 제목**\n\n설명\n\n${fingerprintMarker(fp)}`;

    expect(extractFingerprint(body)).toBe(fp);
  });

  it('마커는 HTML 주석이라 GitHub에서 눈에 보이지 않는다', () => {
    expect(fingerprintMarker('0123456789abcdef')).toBe(
      '<!-- dovi:fp=0123456789abcdef -->',
    );
  });

  it.each([
    null,
    undefined,
    '',
    '지문 없는 예전 코멘트',
    '<!-- dovi:fp=short -->',
  ])('마커가 없거나 형식이 틀리면(%p) null이다', (body) => {
    expect(extractFingerprint(body)).toBeNull();
  });
});
