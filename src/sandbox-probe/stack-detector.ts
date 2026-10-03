// 샌드박스 프로브가 지원하는 스택. 새 스택은 STACK_DETECTORS에 감지기를 추가하고, ai-server 워커에
// 같은 이름의 레시피(설치/빌드/기동 명령, 전용 프로브)가 준비된 뒤 SANDBOX_PROBE_STACKS로 켠다.
export type ProbeStack = 'nestjs' | 'nextjs' | 'react' | 'vue' | 'spring';

export type ReadRepoFile = (path: string) => Promise<string | null>;

export interface StackDetector {
  stack: ProbeStack;
  detect(read: ReadRepoFile): Promise<boolean>;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(
  read: ReadRepoFile,
): Promise<PackageJson | null> {
  const content = await read('package.json');
  if (content === null) return null;
  try {
    return JSON.parse(content) as PackageJson;
  } catch {
    return null;
  }
}

function hasDependency(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

function packageJsonDetector(
  stack: ProbeStack,
  dependency: string,
): StackDetector {
  return {
    stack,
    async detect(read) {
      const pkg = await readPackageJson(read);
      return pkg !== null && hasDependency(pkg, dependency);
    },
  };
}

// Gradle 플러그인은 `org.springframework.boot`, Maven/의존성은 `spring-boot-starter-*` 표기를 쓴다.
const SPRING_BOOT_PATTERN = /org\.springframework\.boot|spring-boot/i;
const SPRING_BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

const springDetector: StackDetector = {
  stack: 'spring',
  async detect(read) {
    for (const file of SPRING_BUILD_FILES) {
      const content = await read(file);
      if (content !== null && SPRING_BOOT_PATTERN.test(content)) return true;
    }
    return false;
  },
};

// 앞에서부터 처음 맞는 스택을 쓴다. Next.js는 react를 포함하므로 react보다 앞에 둔다.
export const STACK_DETECTORS: StackDetector[] = [
  packageJsonDetector('nestjs', '@nestjs/core'),
  packageJsonDetector('nextjs', 'next'),
  packageJsonDetector('react', 'react'),
  packageJsonDetector('vue', 'vue'),
  springDetector,
];

export async function detectStack(
  read: ReadRepoFile,
): Promise<ProbeStack | null> {
  for (const detector of STACK_DETECTORS) {
    if (await detector.detect(read)) return detector.stack;
  }
  return null;
}

const KNOWN_STACKS = new Set<string>(STACK_DETECTORS.map((d) => d.stack));
const DEFAULT_ENABLED_STACKS: ProbeStack[] = ['nestjs'];

// SANDBOX_PROBE_STACKS(쉼표 구분)에서 켜진 스택을 읽는다. 비어 있거나 알 수 없는 값뿐이면
// 기본값(nestjs)을 쓴다 — 워커가 준비되지 않은 스택의 PR이 잘못된 결과를 받는 일을 막는다.
export function parseEnabledStacks(raw: string | undefined): Set<ProbeStack> {
  const stacks = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProbeStack => KNOWN_STACKS.has(s));
  return new Set(stacks.length > 0 ? stacks : DEFAULT_ENABLED_STACKS);
}
