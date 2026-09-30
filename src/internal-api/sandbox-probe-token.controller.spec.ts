import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { INSTALLATION_TOKEN_MANAGER } from '../installation-token/installation-token-manager.interface';
import { InternalSecretGuard } from './internal-secret.guard';
import { SandboxProbeTokenController } from './sandbox-probe-token.controller';

const SECRET = 'test-internal-secret';
const ROUTE = '/internal/sandbox-probe/token';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error('github error'), { status });
}

describe('SandboxProbeTokenController (HTTP)', () => {
  let app: INestApplication<App>;
  let getScopedToken: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    process.env.GITHUB_APP_INTERNAL_SECRET = SECRET;
    getScopedToken = jest.fn().mockResolvedValue({
      token: 'ghs_secretTokenValue',
      expiresAt: '2026-09-30T12:00:00Z',
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [SandboxProbeTokenController],
      providers: [
        InternalSecretGuard,
        {
          provide: INSTALLATION_TOKEN_MANAGER,
          useValue: { getOctokit: jest.fn(), getScopedToken },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await app.close();
    delete process.env.GITHUB_APP_INTERNAL_SECRET;
  });

  it('올바른 시크릿이면 contents:read + 해당 저장소로 좁힌 토큰을 돌려준다', async () => {
    const res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', SECRET)
      .send({ installationId: 10, repositoryId: 42 })
      .expect(200);

    expect(res.body).toEqual({
      token: 'ghs_secretTokenValue',
      expiresAt: '2026-09-30T12:00:00Z',
    });
    expect(getScopedToken).toHaveBeenCalledWith(10, {
      permissions: { contents: 'read' },
      repositoryIds: [42],
    });
  });

  it('토큰 값은 로그에 남기지 않는다', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', SECRET)
      .send({ installationId: 10, repositoryId: 42 })
      .expect(200);

    const logged = (logSpy.mock.calls as unknown[][])
      .map((call) => String(call[0]))
      .join('\n');
    expect(logged).not.toContain('ghs_secretTokenValue');
  });

  it.each([
    ['시크릿 헤더가 없으면', undefined],
    ['시크릿이 틀리면', 'wrong-secret'],
    ['길이가 다른 시크릿이어도', 'x'],
  ])('%s 401을 돌려주고 토큰을 발급하지 않는다', async (_label, header) => {
    const req = request(app.getHttpServer()).post(ROUTE);
    if (header !== undefined) req.set('X-Dovi-Internal-Secret', header);

    await req.send({ installationId: 10, repositoryId: 42 }).expect(401);
    expect(getScopedToken).not.toHaveBeenCalled();
  });

  it('서버에 시크릿이 설정되지 않았으면 503으로 엔드포인트를 닫는다', async () => {
    delete process.env.GITHUB_APP_INTERNAL_SECRET;

    await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', '')
      .send({ installationId: 10, repositoryId: 42 })
      .expect(503);
    expect(getScopedToken).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ installationId: 10 }],
    [{ installationId: '10', repositoryId: 42 }],
    [{ installationId: 10, repositoryId: 0 }],
    [{ installationId: 10, repositoryId: 1.5 }],
  ])('요청 본문이 %j이면 400을 돌려준다', async (body) => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', SECRET)
      .send(body)
      .expect(400);
    expect(getScopedToken).not.toHaveBeenCalled();
  });

  it('GitHub가 발급을 거부하면(저장소가 installation에 없음 등) 422를 돌려준다', async () => {
    getScopedToken.mockRejectedValue(httpError(422));

    await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', SECRET)
      .send({ installationId: 10, repositoryId: 42 })
      .expect(422);
  });

  it('GitHub 5xx나 네트워크 오류는 500으로 돌려준다(워커가 재시도할 수 있게)', async () => {
    getScopedToken.mockRejectedValue(httpError(502));

    await request(app.getHttpServer())
      .post(ROUTE)
      .set('X-Dovi-Internal-Secret', SECRET)
      .send({ installationId: 10, repositoryId: 42 })
      .expect(500);
  });
});
