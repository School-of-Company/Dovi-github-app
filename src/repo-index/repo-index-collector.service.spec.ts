import { RepoIndexCollectorService } from './repo-index-collector.service';

function toBase64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

describe('RepoIndexCollectorService', () => {
  let getContent: jest.Mock;
  let compareCommitsWithBasehead: jest.Mock;
  let installationTokenManager: { getOctokit: jest.Mock };
  let service: RepoIndexCollectorService;

  beforeEach(() => {
    getContent = jest.fn().mockResolvedValue({ data: { type: 'dir' } });
    compareCommitsWithBasehead = jest.fn();

    const octokit = {
      rest: {
        repos: { getContent, compareCommitsWithBasehead },
      },
    };

    installationTokenManager = {
      getOctokit: jest.fn().mockResolvedValue(octokit),
    };

    service = new RepoIndexCollectorService(installationTokenManager);
  });

  function mockDoviMd(content: string): void {
    getContent.mockImplementation((params: { path: string }) => {
      if (params.path === 'DOVI.md') {
        return Promise.resolve({
          data: {
            type: 'file',
            content: toBase64(content),
            size: Buffer.byteLength(content, 'utf-8'),
          },
        });
      }
      return Promise.resolve({ data: { type: 'dir' } });
    });
  }

  describe('resolveIndexBranch', () => {
    it('DOVI.md에 Index Branch가 있으면 그 값을 반환한다', async () => {
      mockDoviMd('# DOVI\n\n## Index Branch\ndevelop\n');

      const branch = await service.resolveIndexBranch(
        1,
        'owner',
        'repo',
        'main',
      );

      expect(branch).toBe('develop');
      expect(getContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'DOVI.md', ref: 'main' }),
      );
    });

    it('DOVI.md가 없으면 default_branch로 fallback한다', async () => {
      const branch = await service.resolveIndexBranch(
        1,
        'owner',
        'repo',
        'main',
      );
      expect(branch).toBe('main');
    });

    it('DOVI.md는 있지만 Index Branch 섹션이 없으면 default_branch로 fallback한다', async () => {
      mockDoviMd('# DOVI\n\n그냥 설명\n');

      const branch = await service.resolveIndexBranch(
        1,
        'owner',
        'repo',
        'main',
      );
      expect(branch).toBe('main');
    });
  });

  describe('collect', () => {
    it('before가 전부 0(신규 브랜치)이면 null을 반환하고 API를 호출하지 않는다', async () => {
      const result = await service.collect(
        1,
        'owner',
        'repo',
        42,
        'develop',
        '0'.repeat(40),
        'after-sha',
      );

      expect(result).toBeNull();
      expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
    });

    it('added/modified 파일의 content를 after 기준으로 채워 반환한다', async () => {
      compareCommitsWithBasehead.mockResolvedValue({
        data: {
          files: [
            { filename: 'src/foo.ts', status: 'modified' },
            { filename: 'src/removed.ts', status: 'removed' },
          ],
        },
      });
      getContent.mockImplementation((params: { path: string }) => {
        if (params.path === 'src/foo.ts') {
          return Promise.resolve({
            data: {
              type: 'file',
              content: toBase64('export const x = 1;'),
              size: 20,
            },
          });
        }
        return Promise.resolve({ data: { type: 'dir' } });
      });

      const result = await service.collect(
        1,
        'owner',
        'repo',
        42,
        'develop',
        'before-sha',
        'after-sha',
      );

      expect(result).toEqual({
        repositoryId: 42,
        branch: 'develop',
        headSha: 'after-sha',
        changedFiles: [
          {
            filePath: 'src/foo.ts',
            status: 'modified',
            content: 'export const x = 1;',
          },
          { filePath: 'src/removed.ts', status: 'removed' },
        ],
      });
      expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
        expect.objectContaining({ basehead: 'before-sha...after-sha' }),
      );
      expect(getContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/foo.ts', ref: 'after-sha' }),
      );
    });

    it('secret 경로는 content를 채우지 않는다', async () => {
      compareCommitsWithBasehead.mockResolvedValue({
        data: { files: [{ filename: '.env.production', status: 'added' }] },
      });

      const result = await service.collect(
        1,
        'owner',
        'repo',
        42,
        'develop',
        'before-sha',
        'after-sha',
      );

      expect(result?.changedFiles[0].content).toBeUndefined();
      expect(getContent).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: '.env.production' }),
      );
    });

    it('지원하지 않는 status(copied 등)는 changedFiles에서 제외한다', async () => {
      compareCommitsWithBasehead.mockResolvedValue({
        data: { files: [{ filename: 'src/copied.ts', status: 'copied' }] },
      });

      const result = await service.collect(
        1,
        'owner',
        'repo',
        42,
        'develop',
        'before-sha',
        'after-sha',
      );

      expect(result?.changedFiles).toEqual([]);
    });

    it('compare 조회가 실패하면 null을 반환한다', async () => {
      compareCommitsWithBasehead.mockRejectedValue(new Error('not found'));

      const result = await service.collect(
        1,
        'owner',
        'repo',
        42,
        'develop',
        'before-sha',
        'after-sha',
      );

      expect(result).toBeNull();
    });
  });
});
