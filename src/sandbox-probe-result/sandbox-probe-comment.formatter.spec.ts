import {
  formatSandboxProbeComment,
  SANDBOX_PROBE_STICKY_MARKER,
} from './sandbox-probe-comment.formatter';
import type { SandboxProbeCompletedPayload } from './dto/sandbox-probe-completed.payload';

function basePayload(
  overrides: Partial<SandboxProbeCompletedPayload> = {},
): SandboxProbeCompletedPayload {
  return {
    reviewJobId: '1:5:sha1234567',
    repositoryId: 1,
    prNumber: 5,
    headSha: 'sha1234567',
    status: 'passed',
    evidence: '',
    findings: [],
    ...overrides,
  };
}

describe('formatSandboxProbeComment', () => {
  it('sticky 마커를 항상 맨 앞에 포함한다', () => {
    const body = formatSandboxProbeComment(basePayload());
    expect(body.startsWith(SANDBOX_PROBE_STICKY_MARKER)).toBe(true);
  });

  it('상태별로 다른 라벨/이모지를 쓴다', () => {
    expect(
      formatSandboxProbeComment(basePayload({ status: 'passed' })),
    ).toContain('✅');
    expect(
      formatSandboxProbeComment(basePayload({ status: 'found_issue' })),
    ).toContain('🐛');
    expect(
      formatSandboxProbeComment(basePayload({ status: 'inconclusive' })),
    ).toContain('⚠️');
  });

  it('evidence 안의 "@멘션"을 무력화한다', () => {
    const body = formatSandboxProbeComment(
      basePayload({ evidence: 'error from @octocat build' }),
    );
    expect(body).not.toContain('@octocat');
    expect(body).toContain('@​octo');
  });

  it('evidence 안의 백틱 런보다 긴 코드펜스로 감싼다', () => {
    const body = formatSandboxProbeComment(
      basePayload({ evidence: 'contains ```` four backticks' }),
    );
    expect(body).toContain('`````');
  });

  it('findings를 최대 10개까지만 표시한다', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      probe: 'build' as const,
      title: `finding ${i}`,
      message: 'msg',
      filePath: null,
      line: null,
      evidence: '',
    }));
    const body = formatSandboxProbeComment(basePayload({ findings }));

    expect(body).toContain('finding 9');
    expect(body).not.toContain('finding 10');
  });

  it('filePath/line이 있으면 위치를 함께 표시한다', () => {
    const body = formatSandboxProbeComment(
      basePayload({
        findings: [
          {
            probe: 'init_order',
            title: 'circular init',
            message: 'msg',
            filePath: 'dist/form.entity.js',
            line: 12,
            evidence: '',
          },
        ],
      }),
    );
    expect(body).toContain('`dist/form.entity.js:12`');
  });

  it('filePath가 없으면 위치를 표시하지 않는다', () => {
    const body = formatSandboxProbeComment(
      basePayload({
        findings: [
          {
            probe: 'lifecycle',
            title: 'no shutdown hook',
            message: 'msg',
            filePath: null,
            line: null,
            evidence: '',
          },
        ],
      }),
    );
    expect(body).not.toContain('` (`');
  });

  it('본문이 너무 길면 전체 길이를 상한 아래로 자른다', () => {
    const body = formatSandboxProbeComment(
      basePayload({ evidence: 'x'.repeat(100_000) }),
    );
    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});
