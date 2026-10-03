import { detectStack, parseEnabledStacks } from './stack-detector';

function reader(files: Record<string, string>) {
  return (path: string) => Promise.resolve(files[path] ?? null);
}

const pkg = (deps: Record<string, string>, dev = false) =>
  JSON.stringify(dev ? { devDependencies: deps } : { dependencies: deps });

describe('detectStack', () => {
  it('@nestjs/core가 있으면 nestjs', async () => {
    const read = reader({ 'package.json': pkg({ '@nestjs/core': '^11' }) });
    await expect(detectStack(read)).resolves.toBe('nestjs');
  });

  it('devDependencies의 의존성도 인식한다', async () => {
    const read = reader({ 'package.json': pkg({ vue: '^3' }, true) });
    await expect(detectStack(read)).resolves.toBe('vue');
  });

  it('next는 react를 함께 쓰더라도 nextjs로 판단한다', async () => {
    const read = reader({
      'package.json': pkg({ next: '^15', react: '^19' }),
    });
    await expect(detectStack(read)).resolves.toBe('nextjs');
  });

  it('react만 있으면 react', async () => {
    const read = reader({ 'package.json': pkg({ react: '^19' }) });
    await expect(detectStack(read)).resolves.toBe('react');
  });

  it('build.gradle에 spring-boot가 있으면 spring', async () => {
    const read = reader({
      'build.gradle':
        "plugins { id 'org.springframework.boot' version '3.3.0' }",
    });
    await expect(detectStack(read)).resolves.toBe('spring');
  });

  it('build.gradle.kts / pom.xml도 인식한다', async () => {
    await expect(
      detectStack(
        reader({ 'build.gradle.kts': 'id("org.springframework.boot")' }),
      ),
    ).resolves.toBe('spring');
    await expect(
      detectStack(
        reader({ 'pom.xml': '<artifactId>spring-boot-starter</artifactId>' }),
      ),
    ).resolves.toBe('spring');
  });

  it('spring-boot가 없는 gradle 프로젝트는 감지하지 않는다', async () => {
    const read = reader({ 'build.gradle': "plugins { id 'java' }" });
    await expect(detectStack(read)).resolves.toBeNull();
  });

  it('package.json이 깨졌거나 알려진 스택이 없으면 null', async () => {
    await expect(
      detectStack(reader({ 'package.json': '{ broken' })),
    ).resolves.toBeNull();
    await expect(
      detectStack(reader({ 'package.json': pkg({ lodash: '^4' }) })),
    ).resolves.toBeNull();
    await expect(detectStack(reader({}))).resolves.toBeNull();
  });
});

describe('parseEnabledStacks', () => {
  it('미설정이면 기본값 nestjs만 켠다', () => {
    expect([...parseEnabledStacks(undefined)]).toEqual(['nestjs']);
    expect([...parseEnabledStacks('')]).toEqual(['nestjs']);
  });

  it('쉼표로 구분한 스택을 켜고 공백/대소문자는 무시한다', () => {
    expect([...parseEnabledStacks(' NestJS , react ,vue')]).toEqual([
      'nestjs',
      'react',
      'vue',
    ]);
  });

  it('알 수 없는 값은 버리고, 전부 알 수 없으면 기본값을 쓴다', () => {
    expect([...parseEnabledStacks('nestjs,rails')]).toEqual(['nestjs']);
    expect([...parseEnabledStacks('rails')]).toEqual(['nestjs']);
  });
});
