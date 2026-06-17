# Webhook Handler & PR Data Collector 구현 Spec

## 확정된 설계 결정

| #   | 항목                               | 결정                                                                                      |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Raw Body 처리                      | `express.json({ verify })` 콜백으로 `req.rawBody` 저장 + `WebhookSignatureGuard`에서 검증 |
| 2   | Webhook 응답 전략                  | 즉시 200 반환 + 백그라운드 `.catch(err => logger.error(err))`                             |
| 3   | changedFiles pagination            | `octokit.paginate()` 전체 순회                                                            |
| 4   | InstallationTokenManager interface | `getOctokit(installationId: number): Promise<Octokit>`                                    |
| 5   | 모듈 의존 방향                     | `WebhookModule` → `PrDataCollectorModule` (단방향 import)                                 |
| 6   | collect() 파라미터                 | `CollectPrDataCommand` DTO (webhook 구조와 분리)                                          |

---

## 디렉터리 구조

```
src/
├── main.ts                              # rawBody 미들웨어 설정
├── app.module.ts                        # WebhookModule, PrDataCollectorModule import
│
├── webhook/
│   ├── webhook.module.ts
│   ├── webhook.controller.ts            # POST /webhook
│   ├── guards/
│   │   └── webhook-signature.guard.ts  # X-Hub-Signature-256 검증
│   └── dto/
│       └── github-webhook-payload.ts   # webhook payload 타입
│
├── pr-data-collector/
│   ├── pr-data-collector.module.ts
│   ├── pr-data-collector.service.ts    # collect() 구현
│   └── dto/
│       ├── collect-pr-data.command.ts  # collect() 파라미터
│       └── review-request.payload.ts  # 반환 타입
│
└── installation-token/
    └── installation-token-manager.interface.ts  # interface만 정의
```

---

## 공통 타입

### `CollectPrDataCommand`

```typescript
interface CollectPrDataCommand {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  repositoryId: number;
}
```

### `ReviewRequestPayload`

```typescript
interface ReviewRequestPayload {
  reviewJobId: string; // {repositoryId}_{prNumber}_{headSha}
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  diff: string;
  changedFiles: {
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    patch?: string;
  }[];
}
```

### `InstallationTokenManager` interface

```typescript
interface InstallationTokenManager {
  getOctokit(installationId: number): Promise<Octokit>;
}
```

---

## 1. `main.ts` — rawBody 미들웨어

```typescript
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
```

- 전역 JSON 파싱 + rawBody 저장을 동시 처리
- `@types/express` Request 타입에 `rawBody: Buffer` 확장 필요

---

## 2. `WebhookSignatureGuard`

- `canActivate()`에서 `req.rawBody`, `X-Hub-Signature-256` 헤더로 HMAC-SHA256 검증
- 검증 실패 시 `UnauthorizedException` throw → NestJS가 401 반환
- `GITHUB_WEBHOOK_SECRET` 환경변수 주입

---

## 3. `WebhookController` — POST /webhook

```
요청 수신
  → WebhookSignatureGuard (서명 검증, 실패 시 401)
  → 이벤트 필터링:
      X-GitHub-Event !== 'pull_request'  → 200 skip
      action ∉ ['opened','synchronize','reopened']  → 200 skip
      pull_request.draft === true  → 200 skip
      sender.type !== 'User'  → 200 skip
  → CollectPrDataCommand 생성 (payload에서 필드 추출)
  → prDataCollectorService.collect(command).catch(err => logger.error(err))
  → 200 OK 즉시 반환
```

- `@Headers('x-github-event')` 로 이벤트 타입 확인
- 응답은 항상 200 (필터 통과/미통과 모두)

---

## 4. `PrDataCollectorService`

### `collect(command: CollectPrDataCommand): Promise<ReviewRequestPayload>`

1. `installationTokenManager.getOctokit(command.installationId)`로 인증된 Octokit 획득
2. diff 수집:
   - `GET /repos/{owner}/{repo}/pulls/{pull_number}` (Accept: `application/vnd.github.v3.diff`)
   - raw HTTP 요청 (Octokit은 diff Accept 헤더를 별도 처리)
   - diff 크기 > 10MB → 경고 로깅 후 `return` (throw 없이 스킵)
3. changedFiles 수집:
   - `octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 })`
   - 전체 파일 목록 수집
4. `ReviewRequestPayload` 조립:
   - `reviewJobId`: `` `${repositoryId}_${prNumber}_${headSha}` ``
5. GitHub API 에러 → `logger.error()` 후 `throw` (호출부 `.catch()`에서 처리)

---

## 5. 모듈 구성

### `PrDataCollectorModule`

```typescript
@Module({
  providers: [
    PrDataCollectorService,
    {
      provide: 'INSTALLATION_TOKEN_MANAGER',
      useClass: /* 추후 구현체 */,
    },
  ],
  exports: [PrDataCollectorService],
})
```

### `WebhookModule`

```typescript
@Module({
  imports: [PrDataCollectorModule],
  controllers: [WebhookController],
  providers: [WebhookSignatureGuard],
})
```

---

## 환경변수

| 변수명                  | 용도                                                     |
| ----------------------- | -------------------------------------------------------- |
| `GITHUB_APP_ID`         | GitHub App 식별 (InstallationTokenManager 구현 시 사용)  |
| `GITHUB_PRIVATE_KEY`    | PEM 형식 서명 키 (InstallationTokenManager 구현 시 사용) |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature 검증                                   |

---

## 패키지 설치 필요

```bash
npm install @octokit/rest @octokit/webhooks
npm install --save-dev @types/node
```

---

## 이번 구현 범위 외

- `InstallationTokenManager` 구현체 (interface만 정의)
- Kafka 연동 (`ReviewRequestPayload` 반환까지만)
