import type { Octokit } from '@octokit/rest';
import { describeSkipReason, fetchFileContent } from './github-content';

const SIZE_LIMIT = 200 * 1024;

function octokitReturning(data: unknown): Octokit {
  return {
    rest: { repos: { getContent: jest.fn().mockResolvedValue({ data }) } },
  } as unknown as Octokit;
}

function octokitThrowing(err: unknown): Octokit {
  return {
    rest: { repos: { getContent: jest.fn().mockRejectedValue(err) } },
  } as unknown as Octokit;
}

function fileData(content: string, size?: number) {
  return {
    type: 'file',
    size: size ?? Buffer.byteLength(content, 'utf-8'),
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };
}

async function fetch(octokit: Octokit, sizeLimit = SIZE_LIMIT) {
  return fetchFileContent(octokit, 'o', 'r', 'sha', 'src/a.ts', sizeLimit);
}

describe('fetchFileContent', () => {
  it('파일 내용을 디코딩해 돌려주고 크기도 함께 준다', async () => {
    const source = 'export class A {}\n';
    const result = await fetch(octokitReturning(fileData(source)));

    expect(result.content).toBe(source);
    expect(result.skipReason).toBeUndefined();
    expect(result.size).toBe(Buffer.byteLength(source, 'utf-8'));
  });

  it('작은 파일은 크기 때문에 제외되지 않는다', async () => {
    // 175바이트 파일이 "크기 제한" 때문에 빠졌다고 보고된 사건의 회귀 테스트.
    const tiny = 'import { Injectable } from "@nestjs/common";\n';
    const result = await fetch(octokitReturning(fileData(tiny)));

    expect(result.content).toBe(tiny);
    expect(result.skipReason).toBeUndefined();
  });

  it('제한을 넘으면 size-exceeded 와 실제 크기를 준다', async () => {
    const result = await fetch(octokitReturning(fileData('x', SIZE_LIMIT + 1)));

    expect(result.content).toBeNull();
    expect(result.skipReason).toBe('size-exceeded');
    expect(result.size).toBe(SIZE_LIMIT + 1);
  });

  it('content 가 비어 오면 size-exceeded 가 아니라 no-content 다', async () => {
    // GitHub 은 1MB 초과 파일에 content 를 비워 보낸다 — 크기 초과와 구분되어야 한다.
    const result = await fetch(
      octokitReturning({ type: 'file', size: 2_000_000, content: '' }),
      5_000_000,
    );

    expect(result.skipReason).toBe('no-content');
    expect(result.size).toBe(2_000_000);
  });

  it('디렉터리와 심링크를 서로 다른 이유로 구분한다', async () => {
    expect((await fetch(octokitReturning([]))).skipReason).toBe('directory');
    expect(
      (await fetch(octokitReturning({ type: 'symlink', size: 10 }))).skipReason,
    ).toBe('not-a-file');
  });

  it('404 는 not-found, 그 밖의 실패는 fetch-failed 로 나눈다', async () => {
    // 404(설정 파일이 없는 레포)는 정상 경로라 호출부가 로그를 생략할 수 있어야 한다.
    expect((await fetch(octokitThrowing({ status: 404 }))).skipReason).toBe(
      'not-found',
    );
    expect((await fetch(octokitThrowing({ status: 500 }))).skipReason).toBe(
      'fetch-failed',
    );
    expect(
      (await fetch(octokitThrowing(new Error('socket hang up')))).skipReason,
    ).toBe('fetch-failed');
  });
});

describe('describeSkipReason', () => {
  it('크기 초과는 실제 크기와 제한값을 같이 보여준다', () => {
    const message = describeSkipReason('size-exceeded', SIZE_LIMIT, 300_000);

    expect(message).toContain('300000');
    expect(message).toContain(String(SIZE_LIMIT));
  });

  it('모든 이유에 설명이 있다', () => {
    const reasons = [
      'directory',
      'not-a-file',
      'no-content',
      'size-exceeded',
      'not-found',
      'fetch-failed',
    ] as const;

    for (const reason of reasons) {
      expect(describeSkipReason(reason, SIZE_LIMIT).length).toBeGreaterThan(0);
    }
  });
});
