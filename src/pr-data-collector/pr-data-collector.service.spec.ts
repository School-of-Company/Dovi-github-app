import { PrDataCollectorService } from './pr-data-collector.service';

function toBase64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

describe('PrDataCollectorService', () => {
  const command = {
    installationId: 1,
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    repositoryId: 42,
  };

  let getContent: jest.Mock;
  let listFiles: jest.Mock;
  let paginate: jest.Mock;
  let pullsGet: jest.Mock;
  let getTree: jest.Mock;
  let octokit: unknown;
  let installationTokenManager: { getOctokit: jest.Mock };
  let service: PrDataCollectorService;

  beforeEach(() => {
    getContent = jest.fn().mockResolvedValue({
      data: { type: 'dir' },
    });
    listFiles = jest.fn();
    paginate = jest.fn((): unknown => listFiles());
    pullsGet = jest.fn().mockResolvedValue({ data: 'diff --git a/x b/x' });
    getTree = jest.fn().mockRejectedValue(new Error('no tree'));

    octokit = {
      paginate,
      rest: {
        pulls: { get: pullsGet, listFiles },
        repos: { getContent },
        git: { getTree },
      },
    };

    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue(octokit),
    };

    service = new PrDataCollectorService(installationTokenManager);
  });

  function mockChangedFiles(
    files: Array<{ filename: string; status: string; patch?: string }>,
  ): void {
    listFiles.mockResolvedValue(files);
  }

  function mockFileContent(path: string, content: string, size?: number) {
    getContent.mockImplementation((params: { path: string }) => {
      if (params.path === path) {
        return Promise.resolve({
          data: {
            type: 'file',
            content: toBase64(content),
            size: size ?? Buffer.byteLength(content, 'utf-8'),
          },
        });
      }
      return Promise.resolve({ data: { type: 'dir' } });
    });
  }

  it('AST 지원 확장자의 added/modified 파일은 headSha 기준 content를 채워 보낸다', async () => {
    mockChangedFiles([
      { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1 +1 @@' },
    ]);
    mockFileContent('src/foo.ts', 'export const foo = 1;');

    const result = await service.collect(command);

    expect(result?.changedFiles).toEqual([
      {
        filePath: 'src/foo.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@',
        content: 'export const foo = 1;',
      },
    ]);
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        path: 'src/foo.ts',
        ref: 'head-sha',
      }),
    );
  });

  it('removed 파일은 content를 조회하지 않는다', async () => {
    mockChangedFiles([
      { filename: 'src/foo.ts', status: 'removed', patch: '@@ -1 +0 @@' },
    ]);

    const result = await service.collect(command);

    expect(result?.changedFiles[0]).toEqual({
      filePath: 'src/foo.ts',
      status: 'removed',
      patch: '@@ -1 +0 @@',
      content: undefined,
    });
    expect(getContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/foo.ts' }),
    );
  });

  it('tree-sitter 미지원 확장자는 content를 채우지 않는다', async () => {
    mockChangedFiles([
      { filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@' },
    ]);
    mockFileContent('README.md', '# hello');

    const result = await service.collect(command);

    expect(result?.changedFiles[0].content).toBeUndefined();
  });

  it('secret 경로는 content를 채우지 않는다', async () => {
    mockChangedFiles([
      {
        filename: 'secrets/config.ts',
        status: 'added',
        patch: '@@ -0,0 +1 @@',
      },
    ]);
    mockFileContent('secrets/config.ts', 'export const secret = 1;');

    const result = await service.collect(command);

    expect(result?.changedFiles[0].content).toBeUndefined();
  });

  it('크기 제한(200KB)을 초과하면 content를 채우지 않는다', async () => {
    mockChangedFiles([
      { filename: 'src/big.ts', status: 'added', patch: '@@ -0,0 +1 @@' },
    ]);
    mockFileContent('src/big.ts', 'x', 300 * 1024);

    const result = await service.collect(command);

    expect(result?.changedFiles[0].content).toBeUndefined();
  });

  it('changedFiles content 총합이 512KB 예산을 넘으면 큰 파일부터 content를 비운다', async () => {
    const sizes: Record<string, number> = {
      'src/a.ts': 199 * 1024,
      'src/b.ts': 190 * 1024,
      'src/c.ts': 150 * 1024,
      'src/d.ts': 100 * 1024,
    };
    mockChangedFiles(
      Object.keys(sizes).map((filename) => ({
        filename,
        status: 'modified',
        patch: '@@ -1 +1 @@',
      })),
    );
    getContent.mockImplementation((params: { path: string }) => {
      const size = sizes[params.path];
      if (size === undefined) return Promise.resolve({ data: { type: 'dir' } });
      return Promise.resolve({
        data: { type: 'file', content: toBase64('x'.repeat(size)), size },
      });
    });

    const result = await service.collect(command);
    const byPath = new Map(
      result?.changedFiles.map((f) => [f.filePath, f.content]),
    );

    // 199+190+150+100 = 639KB > 512KB 예산 → 가장 큰 a.ts(199KB)만 비우면
    // 440KB로 예산 이내가 되므로 a.ts만 제외되고 나머지는 유지된다.
    expect(byPath.get('src/a.ts')).toBeUndefined();
    expect(byPath.get('src/b.ts')).toHaveLength(190 * 1024);
    expect(byPath.get('src/c.ts')).toHaveLength(150 * 1024);
    expect(byPath.get('src/d.ts')).toHaveLength(100 * 1024);
  });

  it('getContent 조회가 실패하면 content 없이 나머지 필드는 그대로 반환한다', async () => {
    mockChangedFiles([
      { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1 +1 @@' },
    ]);
    getContent.mockRejectedValue(new Error('not found'));

    const result = await service.collect(command);

    expect(result?.changedFiles[0]).toEqual({
      filePath: 'src/foo.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@',
      content: undefined,
    });
  });
});
