# ReviewOrchestrator 구현 Spec

## 확정된 설계 결정

| #   | 항목                                    | 결정                                                                                                                                                  |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Octokit 인증을 위한 installationId 확보 | `ReviewRequestPayload`/`ReviewCompletedPayload`/`ReviewFailedPayload`에 `installationId: number` 추가, 외부 리뷰 서비스가 요청값을 결과에 echo-back   |
| 2   | PR 등록 방식                            | `Pulls.createReview` 1회 호출로 일괄 등록 (`comments[]` + `body`)                                                                                     |
| 3   | 리뷰 `event` 타입                       | 항상 `'COMMENT'` 고정. 자동 `APPROVE`/`REQUEST_CHANGES` 없음 (AI가 승인/변경요청 권한을 갖지 않음)                                                    |
| 4   | `reviews: []`(findings 없음) 처리       | `summary`만 담아 빈 `comments: []`로 `createReview` 호출 (Gemini Code Assist 스타일 "리뷰 완료" 코멘트)                                               |
| 5   | `failed` 케이스 PR 반영                 | PR에는 아무것도 남기지 않음. Discord 알림만 발송                                                                                                      |
| 6   | Discord 알림 라이브러리                 | `dicoshot-nest`(`DicoshotModule`/`DicoshotService`) 사용. `sendCustom({title, description, color})`으로 커스텀 알림                                   |
| 7   | Discord 알림 범위                       | (a) `ReviewFailedPayload` 수신 시 (b) Orchestrator의 GitHub API 호출 자체 실패 시, 둘 다 알림                                                         |
| 8   | Discord 알림 전송 자체가 실패하는 경우  | 로깅만 하고 무시 (원본 에러/Kafka 재시도 로직에 영향 주지 않음)                                                                                       |
| 9   | 앱 시작/종료 알림                       | `notifyOnStartup`/`notifyOnShutdown` 기본값(`true`) 유지                                                                                              |
| 10  | `DISCORD_WEBHOOK_URL` 누락 시           | 부팅 실패하지 않음 (라이브러리 기본 동작인 자동 비활성화에 위임, 필수 환경변수로 강제하지 않음)                                                       |
| 11  | suggestion 블록 적용 범위               | `severity === 'critical'`인 finding만 ` ```suggestion ` 코드 제안 블록 적용. 나머지는 일반 텍스트                                                     |
| 12  | 이전 헤드 기준 리뷰 정리                | 정리하지 않음. `synchronize`로 재실행될 때마다 새 리뷰가 누적됨 (Gemini와 동일한 동작)                                                                |
| 13  | `confidence` 필드 활용                  | 필터링 없음. 참고용으로 댓글 본문에만 노출 (필터링은 AI 분석 서비스의 책임 영역)                                                                      |
| 14  | "영구적으로 실패하는" completed 메시지  | Octokit `RequestError.status`가 4xx면 재시도하지 않고 로그+Discord 알림 후 정상 종료 처리(offset 커밋). 5xx/네트워크 에러는 기존처럼 throw하여 재시도 |
| 15  | 테스트 범위                             | failed 분기 / 빈 reviews 분기 / critical suggestion 포맷 / Octokit 4xx 실패(커밋) / Octokit 5xx 실패(재throw) 핵심 분기만 단위 테스트                 |

---

## 디렉터리 구조

```
src/
├── app.module.ts                                # DicoshotModule.register(...) import 추가
│
├── review-orchestrator/
│   ├── review-orchestrator.module.ts             # 신규 — REVIEW_ORCHESTRATOR provider, DicoshotModule import
│   ├── review-orchestrator.interface.ts          # 변경 없음
│   ├── review-orchestrator.service.ts            # 신규 — 실제 구현체
│   ├── review-orchestrator.service.spec.ts        # 신규 — 단위 테스트
│   ├── review-comment.formatter.ts                # 신규 — finding[] → Octokit comments[] 매핑 (suggestion 블록 포함)
│   └── dto/
│       ├── review-completed.payload.ts            # installationId 필드 추가
│       └── review-failed.payload.ts                # installationId 필드 추가
│
├── pr-data-collector/
│   ├── dto/
│   │   ├── review-request.payload.ts               # installationId 필드 추가
│   │   └── collect-pr-data.command.ts              # 변경 없음 (이미 installationId 보유)
│   └── pr-data-collector.service.ts                 # collect() 반환값에 installationId 포함
│
└── review-result-consumer/
    └── review-result-consumer.module.ts             # placeholder provider 제거, ReviewOrchestratorModule import
```

---

## DTO 변경

### `ReviewRequestPayload`

```typescript
export interface ReviewRequestPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  installationId: number; // 추가
  diff: string;
  changedFiles: ChangedFile[];
}
```

### `ReviewCompletedPayload`

```typescript
export interface ReviewCompletedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
  installationId: number; // 추가
  summary: string;
  reviews: {
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    confidence: number;
    filePath: string;
    line: number;
    title: string;
    message: string;
    evidence: string[];
    suggestedFix?: string;
  }[];
}
```

### `ReviewFailedPayload`

```typescript
export interface ReviewFailedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string; // 추가 (코드 리뷰 반영: Discord 알림 가독성)
  repo: string; // 추가 (코드 리뷰 반영: Discord 알림 가독성)
  installationId: number; // 추가
  reason: 'parse_error' | 'timeout' | 'server_error';
}
```

> **외부 의존**: LLM 분석 서비스(별도 팀원 구현)가 `ReviewRequestPayload.installationId`/`owner`/`repo`를 그대로 결과 payload에 echo-back 해주는 계약 변경 필요. 이 리포지토리 범위 밖이므로 별도로 전달.

### `PrDataCollectorService.collect()` 변경

```typescript
return {
  reviewJobId: `${repositoryId}_${prNumber}_${headSha}`,
  repositoryId,
  prNumber,
  headSha,
  owner,
  repo,
  installationId, // 추가
  diff,
  changedFiles,
};
```

---

## `ReviewOrchestratorService`

### `handle(payload): Promise<void>`

```typescript
async handle(
  payload: ReviewCompletedPayload | ReviewFailedPayload,
): Promise<void> {
  if ('reason' in payload) {
    await this.notifyFailure(payload);
    return;
  }

  const octokit = await this.installationTokenManager.getOctokit(
    payload.installationId,
  );

  try {
    await octokit.rest.pulls.createReview({
      owner: payload.owner,
      repo: payload.repo,
      pull_number: payload.prNumber,
      commit_id: payload.headSha,
      event: 'COMMENT',
      body: payload.summary,
      comments: buildReviewComments(payload.reviews),
    });
  } catch (err) {
    await this.notifyOrchestratorError(payload, err);

    if (err instanceof RequestError && err.status >= 400 && err.status < 500) {
      this.logger.error(
        `영구적으로 실패한 리뷰 등록 (status=${err.status}), 재시도하지 않고 종료: ${payload.reviewJobId}`,
        err,
      );
      return; // offset 커밋되도록 swallow
    }

    throw err; // 5xx/네트워크 에러는 재시도
  }
}
```

- `'reason' in payload`로 completed/failed 분기 (DTO에 별도 discriminant 필드 추가하지 않고 기존 형태 유지)
- `JobStateStore`/`IdempotencyStore` 기록은 건드리지 않음 — 기존처럼 `ReviewResultConsumerService`가 `handle()` 성공(또는 4xx swallow로 정상 반환) 직후 처리

### `review-comment.formatter.ts` — `buildReviewComments()`

```typescript
export function buildReviewComments(
  reviews: ReviewCompletedPayload['reviews'],
): { path: string; line: number; body: string }[] {
  if (!Array.isArray(reviews)) {
    return []; // 코드 리뷰 반영: 외부 입력 경계(Kafka) 방어
  }
  return reviews.map((review) => ({
    path: review.filePath,
    line: review.line,
    body: formatCommentBody(review),
  }));
}

function formatCommentBody(
  review: ReviewCompletedPayload['reviews'][number],
): string {
  const confidence =
    typeof review.confidence === 'number'
      ? Math.round(review.confidence * 100)
      : 0;
  const header = `**[${review.severity}] ${review.title}** (신뢰도: ${confidence}%)`;
  const evidenceList = Array.isArray(review.evidence) ? review.evidence : [];
  const evidence = evidenceList.length
    ? `\n\n${evidenceList.map((e) => `- ${e}`).join('\n')}`
    : '';

  if (review.severity === 'critical' && review.suggestedFix) {
    return `${header}\n\n${review.message}${evidence}\n\n\`\`\`suggestion\n${review.suggestedFix}\n\`\`\``;
  }

  const fix = review.suggestedFix ? `\n\n제안: ${review.suggestedFix}` : '';
  return `${header}\n\n${review.message}${evidence}${fix}`;
}
```

### Discord 알림 — `notifyFailure()` / `notifyOrchestratorError()`

```typescript
private async notifyFailure(payload: ReviewFailedPayload): Promise<void> {
  await this.safeNotify({
    title: 'AI 리뷰 분석 실패',
    description: `${payload.owner}/${payload.repo}#${payload.prNumber} (reviewJobId=${payload.reviewJobId}) reason=${payload.reason}`,
    color: 'danger',
  });
}

private async notifyOrchestratorError(
  payload: ReviewCompletedPayload,
  err: unknown,
): Promise<void> {
  await this.safeNotify({
    title: 'GitHub 리뷰 등록 실패',
    description: `${payload.owner}/${payload.repo}#${payload.prNumber} (reviewJobId=${payload.reviewJobId}): ${err instanceof Error ? err.message : String(err)}`,
    color: 'danger',
  });
}

private async safeNotify(message: CustomMessageOptions): Promise<void> {
  try {
    await this.dicoshot.sendCustom(message);
  } catch (notifyErr) {
    this.logger.warn('Discord 알림 전송 실패', notifyErr);
  }
}
```

---

## `ReviewOrchestratorModule`

```typescript
@Module({
  imports: [
    DicoshotModule.register({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      applicationName: 'dovi-github-app',
    }),
  ],
  providers: [
    {
      provide: REVIEW_ORCHESTRATOR,
      useClass: ReviewOrchestratorService,
    },
  ],
  exports: [REVIEW_ORCHESTRATOR],
})
export class ReviewOrchestratorModule {}
```

- `DicoshotModule`은 `@Global()`이 아니므로(라이브러리 자체 설계), 이 모듈에서 직접 import해야 `DicoshotService`를 주입받을 수 있음
- `InstallationTokenModule`은 이미 `@Global()`이라 별도 import 불필요

### `ReviewResultConsumerModule` 변경

```typescript
@Module({
  imports: [ReviewOrchestratorModule],
  providers: [ReviewResultConsumerService],
})
export class ReviewResultConsumerModule {}
```

- 기존 placeholder provider(`useValue: notImplementedOrchestrator`) 제거

### `AppModule` 변경

`ReviewResultConsumerModule`이 `ReviewOrchestratorModule`을 내부적으로 import하므로 `AppModule`에는 추가 변경 없음.

---

## 환경변수 (추가)

| 변수명                | 용도                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| `DISCORD_WEBHOOK_URL` | Discord 알림 webhook (미설정 시 `dicoshot-nest`가 자동 비활성화, 부팅 실패 없음) |

---

## 패키지 설치 필요

```bash
npm install dicoshot-nest dicoshot-core
```

---

## 테스트 범위

`ReviewOrchestratorService.handle()`:

1. `ReviewFailedPayload` 수신 → GitHub API 호출 없이 `dicoshot.sendCustom()`만 호출되는지
2. `ReviewCompletedPayload`, `reviews: []` → `createReview`가 `comments: []`, `body: summary`로 호출되는지
3. `severity: 'critical'` + `suggestedFix` 있는 finding → 댓글 body에 ` ```suggestion ` 블록이 포함되는지, 나머지 severity는 일반 텍스트인지
4. `createReview`가 `RequestError(status=422)`를 던짐 → `sendCustom()` 호출 후 에러를 삼키고 정상 반환(rethrow 안 함)
5. `createReview`가 `RequestError(status=500)` 또는 일반 에러를 던짐 → `sendCustom()` 호출 후 에러를 재throw

Octokit, `DicoshotService`, `InstallationTokenManager`는 모두 mock 처리.

---

## 이번 구현 범위 외

- 외부 LLM 리뷰 서비스가 실제로 `installationId`를 echo-back 하도록 구현하는 것 (다른 팀원 작업, 계약만 정의)
- `/dovi review` 같은 PR 코멘트 기반 수동 재실행 트리거 (이번 ReviewOrchestrator 범위가 아니라 Webhook 쪽 신규 기능, 별도 작업)
- 동일 PR에 누적된 과거 AI 리뷰를 정리(dismiss)하는 기능
- `confidence` 기반 필터링 (AI 분석 서비스 책임 영역)
- DistributedLock, DLQ/Outbox (기존 SPEC.md와 동일하게 범위 외 유지)
