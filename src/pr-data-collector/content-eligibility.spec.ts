import { shouldSendContent } from './content-eligibility';

describe('shouldSendContent', () => {
  it.each([
    'src/main/kotlin/com/example/UserService.kt',
    'build.gradle.kts',
    'src/main/java/com/example/Foo.java',
    'src/app.ts',
    'src/App.tsx',
    'scripts/deploy.py',
  ])('AST 지원 언어 %s 는 보낸다 (Kotlin 포함)', (path) => {
    expect(shouldSendContent(path)).toBe(true);
  });

  it.each([
    'cmd/server/main.go',
    'src/lib.rs',
    'src/main.c',
    'include/util.h',
    'src/Program.cs',
    'ios/App/ViewController.swift',
    'app/models/user.rb',
    'public/index.php',
    'scripts/deploy.sh',
    'db/migration/V1__init.sql',
    'web/src/Button.vue',
    'web/styles/app.scss',
    'build.gradle',
  ])(
    'AST 미지원이어도 텍스트 소스 %s 는 보낸다 (ai-server가 줄 윈도우로 처리)',
    (path) => {
      expect(shouldSendContent(path)).toBe(true);
    },
  );

  it('확장자는 대소문자를 구분하지 않는다', () => {
    expect(shouldSendContent('src/Legacy.KT')).toBe(true);
    expect(shouldSendContent('src/Main.GO')).toBe(true);
  });

  it.each([
    ['문서', 'README.md'],
    ['설정(json)', 'package.json'],
    ['설정(yaml)', '.github/workflows/ci.yml'],
    ['lock 파일', 'package-lock.json'],
    ['lock 파일', 'pnpm-lock.yaml'],
    ['lock 파일', 'Cargo.lock'],
    ['바이너리', 'assets/logo.png'],
    ['바이너리', 'libs/app.jar'],
    ['확장자 없음', 'Dockerfile'],
    ['확장자 없음', 'Makefile'],
    ['점으로 끝남', 'src/weird.'],
  ])('%s (%s) 는 보내지 않는다', (_label, path) => {
    expect(shouldSendContent(path)).toBe(false);
  });

  it.each([
    'static/app.min.js',
    'static/app.min.css',
    'dist/app.js.map',
    'proto/service_pb2.py',
    'proto/service_pb2_grpc.py',
    'gen/service.pb.go',
    'lib/model.g.dart',
    'lib/model.freezed.dart',
    'Views/Form.designer.cs',
  ])('생성·minified 파일 %s 는 텍스트 소스여도 보내지 않는다', (path) => {
    expect(shouldSendContent(path)).toBe(false);
  });

  it.each([
    'node_modules/lodash/index.js',
    'frontend/node_modules/react/index.js',
    'vendor/github.com/pkg/errors/errors.go',
    'dist/main.js',
    'build/generated/Foo.kt',
    'src/__pycache__/mod.py',
    '.venv/lib/site.py',
  ])('생성·의존성 디렉터리 안의 %s 는 보내지 않는다', (path) => {
    expect(shouldSendContent(path)).toBe(false);
  });

  it('디렉터리 이름만 비슷한 경우(build.gradle, distance.ts)는 막지 않는다', () => {
    expect(shouldSendContent('build.gradle')).toBe(true);
    expect(shouldSendContent('src/distance.ts')).toBe(true);
    expect(shouldSendContent('src/builder/Foo.kt')).toBe(true);
  });
});
