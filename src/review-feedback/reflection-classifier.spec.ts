import { classifyReflection } from './reflection-classifier';

describe('classifyReflection', () => {
  it.each([
    '반영했습니다',
    '반영 완료',
    '적용했어요',
    '수정함',
    '고쳤습니다',
    'fixed in latest commit',
    'done',
    'Resolved, thanks!',
    'addressed in the new commit',
  ])('"%s" 는 reflected: true로 분류한다', (body) => {
    expect(classifyReflection(body)).toEqual({ reflected: true });
  });

  it.each([
    '반영하지 않았습니다',
    '반영 안 할게요',
    '미반영합니다',
    '이건 보류할게요',
    '스킵하겠습니다',
    '거부합니다',
    "won't fix",
    'wontfix - not a real issue',
    'not applicable here',
  ])('"%s" 는 reflected: false로 분류하고 reason에 원문을 담는다', (body) => {
    expect(classifyReflection(body)).toEqual({
      reflected: false,
      reason: body,
    });
  });

  it('둘 다 매치되지 않는 애매한 텍스트는 null을 반환한다', () => {
    expect(classifyReflection('네 확인했습니다')).toBeNull();
    expect(classifyReflection('감사합니다')).toBeNull();
  });

  it('빈 문자열은 null을 반환한다', () => {
    expect(classifyReflection('   ')).toBeNull();
  });

  it('reason은 200자로 잘린다', () => {
    const long = '반영하지 않았습니다. ' + 'x'.repeat(300);
    const result = classifyReflection(long);
    expect(result?.reason).toHaveLength(200);
  });
});
