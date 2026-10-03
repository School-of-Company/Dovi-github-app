import { SandboxProbeDispatcherService } from './sandbox-probe-dispatcher.service';
import type { InstallationTokenManager } from '../installation-token/installation-token-manager.interface';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { SandboxProbeJobContextStore } from '../redis/sandbox-probe-job-context.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function notFoundError(): Error & { status: number } {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

function makeOctokit(overrides: {
  doviMd?: string;
  packageJson?: string;
  buildFiles?: Record<string, string>;
  files?: string[];
}) {
  const getContent = jest.fn((params: { path: string }) => {
    if (params.path === 'DOVI.md') {
      if (overrides.doviMd === undefined) throw notFoundError();
      return Promise.resolve({
        data: {
          type: 'file',
          size: Buffer.byteLength(overrides.doviMd, 'utf-8'),
          content: Buffer.from(overrides.doviMd, 'utf-8').toString('base64'),
        },
      });
    }
    if (params.path === 'package.json') {
      if (overrides.packageJson === undefined) throw notFoundError();
      return Promise.resolve({
        data: {
          type: 'file',
          size: Buffer.byteLength(overrides.packageJson, 'utf-8'),
          content: Buffer.from(overrides.packageJson, 'utf-8').toString(
            'base64',
          ),
        },
      });
    }
    const buildFile = overrides.buildFiles?.[params.path];
    if (buildFile !== undefined) {
      return Promise.resolve({
        data: {
          type: 'file',
          size: Buffer.byteLength(buildFile, 'utf-8'),
          content: Buffer.from(buildFile, 'utf-8').toString('base64'),
        },
      });
    }
    // 스택 감지가 확인하는 그 밖의 빌드 파일(build.gradle, pom.xml 등)은 없는 것으로 본다.
    throw notFoundError();
  });

  const paginate = jest
    .fn()
    .mockResolvedValue(
      (overrides.files ?? []).map((filename) => ({ filename })),
    );

  return {
    getContent,
    paginate,
    octokit: {
      rest: { repos: { getContent }, pulls: { listFiles: 'listFiles' } },
      paginate,
    },
  };
}

const NESTJS_PACKAGE_JSON = JSON.stringify({
  dependencies: { '@nestjs/core': '^11.0.0' },
});

describe('SandboxProbeDispatcherService', () => {
  let installationTokenManager: { getOctokit: jest.Mock };
  let idempotencyStore: { acquire: jest.Mock; release: jest.Mock };
  let sandboxProbeJobContextStore: {
    set: jest.Mock;
    markActiveRepository: jest.Mock;
  };
  let kafkaProducer: { send: jest.Mock };
  let service: SandboxProbeDispatcherService;

  const baseTrigger = {
    installationId: 10,
    owner: 'owner',
    repo: 'repo',
    repositoryId: 1,
    defaultBranch: 'main',
    prNumber: 5,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    isFork: false,
  };

  beforeEach(() => {
    process.env.SANDBOX_PROBE_PUBLISH_ENABLED = 'true';
    delete process.env.SANDBOX_PROBE_STACKS;
    process.env.KAFKA_SANDBOX_PROBE_REQUEST_TOPIC =
      'pr.sandbox.probe.requested';

    idempotencyStore = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    sandboxProbeJobContextStore = {
      set: jest.fn().mockResolvedValue(undefined),
      markActiveRepository: jest.fn().mockResolvedValue(undefined),
    };
    kafkaProducer = { send: jest.fn().mockResolvedValue(undefined) };
    installationTokenManager = { getOctokit: jest.fn() };

    service = new SandboxProbeDispatcherService(
      installationTokenManager as unknown as InstallationTokenManager,
      idempotencyStore as unknown as IdempotencyStore,
      sandboxProbeJobContextStore as unknown as SandboxProbeJobContextStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  function setOctokit(overrides: Parameters<typeof makeOctokit>[0]) {
    const { octokit } = makeOctokit(overrides);
    installationTokenManager.getOctokit.mockResolvedValue(octokit);
    return octokit;
  }

  it('킬스위치가 꺼져 있으면 octokit도 조회하지 않고 스킵한다', async () => {
    process.env.SANDBOX_PROBE_PUBLISH_ENABLED = 'false';

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('fork PR이면 octokit도 조회하지 않고 스킵한다', async () => {
    service.notifyPrOpened({ ...baseTrigger, isFork: true });
    await flush();

    expect(installationTokenManager.getOctokit).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('DOVI.md에 opt-in이 없으면 스킵한다', async () => {
    setOctokit({ packageJson: NESTJS_PACKAGE_JSON, files: ['src/a.ts'] });

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('opt-in은 됐지만 NestJS 스택이 아니면 스킵한다', async () => {
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: JSON.stringify({ dependencies: { express: '^4.0.0' } }),
      files: ['src/a.ts'],
    });

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('문서 전용 PR이면 스킵한다', async () => {
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: NESTJS_PACKAGE_JSON,
      files: ['docs/guide.md', 'README.md'],
    });

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it('lockfile만 바뀐 PR은 문서 전용으로 취급하지 않고 발행한다', async () => {
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: NESTJS_PACKAGE_JSON,
      files: ['package-lock.json'],
    });

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(kafkaProducer.send).toHaveBeenCalled();
  });

  it('모든 조건을 만족하면 job context를 저장하고 이벤트를 발행한다', async () => {
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: NESTJS_PACKAGE_JSON,
      files: ['src/app.module.ts'],
    });

    service.notifyPrOpened(baseTrigger);
    await flush();

    const expectedReviewJobId = '1:5:head-sha';
    expect(idempotencyStore.acquire).toHaveBeenCalledWith(
      `sandbox:${expectedReviewJobId}`,
    );
    expect(sandboxProbeJobContextStore.set).toHaveBeenCalledWith(
      expectedReviewJobId,
      { owner: 'owner', repo: 'repo', prNumber: 5, installationId: 10 },
    );
    expect(
      sandboxProbeJobContextStore.markActiveRepository,
    ).toHaveBeenCalledWith(10, 1);
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.sandbox.probe.requested',
      {
        reviewJobId: expectedReviewJobId,
        repositoryId: 1,
        repoFullName: 'owner/repo',
        prNumber: 5,
        headSha: 'head-sha',
        baseSha: 'base-sha',
        installationId: 10,
        stack: 'nestjs',
      },
      expectedReviewJobId,
    );
  });

  it('이미 발행된 job이면(dedup) 다시 발행하지 않는다', async () => {
    idempotencyStore.acquire.mockResolvedValue(false);
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: NESTJS_PACKAGE_JSON,
      files: ['src/app.module.ts'],
    });

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(sandboxProbeJobContextStore.set).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
    expect(
      sandboxProbeJobContextStore.markActiveRepository,
    ).not.toHaveBeenCalled();
  });

  it('Kafka 발행 실패 시 idempotency 점유를 되돌린다', async () => {
    setOctokit({
      doviMd: '## Sandbox Probe\ntrue',
      packageJson: NESTJS_PACKAGE_JSON,
      files: ['src/app.module.ts'],
    });
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    service.notifyPrOpened(baseTrigger);
    await flush();

    expect(idempotencyStore.release).toHaveBeenCalledWith(
      'sandbox:1:5:head-sha',
    );
  });
  describe('스택 감지와 허용 스택', () => {
    const SPRING_BUILD = {
      'build.gradle':
        "plugins { id 'org.springframework.boot' version '3.3.0' }",
    };

    function sentStack(): unknown {
      const [, payload] = kafkaProducer.send.mock.calls[0] as [
        string,
        { stack: string },
      ];
      return payload.stack;
    }

    it('기본값에서는 NestJS 외 스택(스프링)은 감지돼도 발행하지 않는다', async () => {
      setOctokit({
        doviMd: '## Sandbox Probe\ntrue',
        buildFiles: SPRING_BUILD,
        files: ['src/main/java/App.java'],
      });

      service.notifyPrOpened(baseTrigger);
      await flush();

      expect(kafkaProducer.send).not.toHaveBeenCalled();
      expect(idempotencyStore.acquire).not.toHaveBeenCalled();
    });

    it('SANDBOX_PROBE_STACKS에 spring이 있으면 stack=spring으로 발행한다', async () => {
      process.env.SANDBOX_PROBE_STACKS = 'nestjs,spring';
      setOctokit({
        doviMd: '## Sandbox Probe\ntrue',
        buildFiles: SPRING_BUILD,
        files: ['src/main/java/App.java'],
      });

      service.notifyPrOpened(baseTrigger);
      await flush();

      expect(sentStack()).toBe('spring');
    });

    it('프론트(react)도 허용하면 stack=react로 발행한다', async () => {
      process.env.SANDBOX_PROBE_STACKS = 'react';
      setOctokit({
        doviMd: '## Sandbox Probe\ntrue',
        packageJson: JSON.stringify({ dependencies: { react: '^19' } }),
        files: ['src/App.tsx'],
      });

      service.notifyPrOpened(baseTrigger);
      await flush();

      expect(sentStack()).toBe('react');
    });

    it('알려진 스택이 아니면 허용 목록과 무관하게 발행하지 않는다', async () => {
      process.env.SANDBOX_PROBE_STACKS = 'nestjs,react,vue,spring,nextjs';
      setOctokit({
        doviMd: '## Sandbox Probe\ntrue',
        packageJson: JSON.stringify({ dependencies: { lodash: '^4' } }),
        files: ['src/a.js'],
      });

      service.notifyPrOpened(baseTrigger);
      await flush();

      expect(kafkaProducer.send).not.toHaveBeenCalled();
    });
  });
});
