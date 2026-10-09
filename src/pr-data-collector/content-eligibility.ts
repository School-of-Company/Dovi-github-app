// changedFiles[].content(변경 후 파일 전체 원문)를 보낼 파일인지 판단한다.
//
// ai-server는 content를 두 가지로 쓴다(Dovi-ai-server app/review/chunking.py).
//  - AST 지원 언어(.py/.js/.ts/.java/.kt 등): 변경된 함수·클래스 경계 전체를 컨텍스트로
//  - 그 밖의 텍스트 파일: 변경 줄 ±15줄 윈도우를 컨텍스트로 (NUL 포함 파일은 무시)
// content가 없으면 diff hunk만 보고 리뷰해 정의를 확인하지 못한 추측성 지적이 늘어난다.
// 그래서 AST 지원 여부와 무관하게 "텍스트 소스"면 보내고, 바이너리·lock·생성·minified는
// ai-server가 어차피 건너뛰므로 API 호출·페이로드 크기를 아끼려고 여기서 미리 거른다.

const TEXT_SOURCE_EXTENSIONS = new Set([
  // JVM
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.gradle',
  // JavaScript / TypeScript / 프레임워크 단일 파일 컴포넌트
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
  // Python
  '.py',
  // 시스템 · 컴파일 언어
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.cs',
  // 모바일
  '.swift',
  '.m',
  '.dart',
  // 스크립트 · 기타
  '.rb',
  '.php',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.pl',
  '.sql',
  // 웹
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
]);

// ai-server의 app/review/diff.py(_GENERATED_SUFFIXES, _GENERATED_DIRS)와 같은 기준 + 자주 쓰는
// 생성 파일. ai-server가 리뷰 대상에서 빼는 파일이라 content를 보내봐야 버려진다.
const GENERATED_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.map',
  '_pb2.py',
  '_pb2_grpc.py',
  '.pb.go',
  '.g.dart',
  '.freezed.dart',
  '.designer.cs',
];
const GENERATED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  '__pycache__',
  '.venv',
]);

export function shouldSendContent(filePath: string): boolean {
  const lowered = filePath.toLowerCase();

  const dot = lowered.lastIndexOf('.');
  if (dot === -1 || !TEXT_SOURCE_EXTENSIONS.has(lowered.slice(dot))) {
    return false;
  }
  if (GENERATED_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) {
    return false;
  }
  const directories = lowered.split('/').slice(0, -1);
  return !directories.some((dir) => GENERATED_DIRS.has(dir));
}
