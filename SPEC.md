# Review Dispatcher & Review Result Consumer 구현 Spec

## 확정된 설계 결정

| #   | 항목                                    | 결정                                                                                                                           |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 환경변수 관리                           | 기존 방식 유지, `process.env` 직접 참조 (`@nestjs/config` 미도입)                                                              |
| 2   | GitHub App 인증                         | `@octokit/auth-app`의 `createAppAuth()` 사용. JWT 서명/만료 재발급은 라이브러리에 위임, installation token만 Redis에 직접 캐싱 |
| 3   | Redis Store 구조                        | `IdempotencyStore`, `JobStateStore` 독립 Injectable 클래스로 분리                                                              |
| 4   | IdempotencyStore 기록 시점              | Dispatch 시점에는 조회만 함. `ReviewResultConsumer`가 `completed` 처리에 성공한 직후에만 기록                                  |
| 5   | WebhookService → ReviewDispatcher 연결  | `WebhookService`가 `ReviewDispatcherService`를 직접 주입받아 `collect()` 성공 시 `dispatch()` 호출                             |
| 6   | `ReviewOrchestrator` interface          | 단일 메서드 `handle(payload: ReviewCompletedPayload \| ReviewFailedPayload): Promise<void>`                                    |
| 7   | KafkaModule 설계                        | `KafkaProducerService` + 추상 `BaseKafkaConsumer` 클래스 제공. 토픽/구독 디테일은 각 기능 모듈이 정의                          |
| 8   | Consumer 메시지 처리 실패               | catch하지 않고 throw. JSON 파싱 실패도 동일하게 처리 (DLQ/Outbox는 이번 범위 외)                                               |
| 9   | Kafka Consumer CRASH 시 동작            | 로깅만 하고 프로세스는 유지 (`process.exit` 없음)                                                                              |
| 10  | JobStateStore `completed`/`failed` 기록 | `ReviewResultConsumer`가 `orchestrator.handle()` 성공 직후 직접 기록                                                           |
| 11  | `InstallationTokenManager` 구현 위치    | 독립 `InstallationTokenModule` 신설, `@Global()`로 전역 등록                                                                   |
| 12  | `GITHUB_PRIVATE_KEY` 개행 처리          | `.replace(/\\n/g, '\n')` 적용                                                                                                  |
| 13  | 테스트 범위                             | 핵심 분기 로직(중복 판단, completed/failed 분기) 위주 단위 테스트만 추가                                                       |

---

## 디렉터리 구조

```
src/
├── app.module.ts                              # RedisModule, KafkaModule, InstallationTokenModule,
│                                                 WebhookModule, ReviewResultConsumerModule import
│
├── redis/
│   ├── redis.module.ts                        # @Global, REDIS_CLIENT(ioredis) provider
│   ├── idempotency.store.ts                   # IdempotencyStore
│   ├── job-state.store.ts                     # JobStateStore
│   └── job-state.type.ts                      # JobState 타입
│
├── kafka/
│   ├── kafka.module.ts                        # @Global, KAFKA_CLIENT(kafkajs) provider
│   ├── kafka-producer.service.ts               # KafkaProducerService
│   └── base-kafka.consumer.ts                  # BaseKafkaConsumer (abstract)
│
├── installation-token/
│   ├── installation-token.module.ts            # @Global (신규)
│   ├── installation-token-manager.service.ts    # 실제 구현체 (신규)
│   └── installation-token-manager.interface.ts  # 기존 interface (변경 없음)
│
├── review-dispatcher/
│   ├── review-dispatcher.module.ts
│   └── review-dispatcher.service.ts             # dispatch()
│
├── review-orchestrator/
│   ├── review-orchestrator.interface.ts         # interface만 정의 (5번에서 구현)
│   └── dto/
│       ├── review-completed.payload.ts
│       └── review-failed.payload.ts
│
├── review-result-consumer/
│   ├── review-result-consumer.module.ts
│   └── review-result-consumer.service.ts        # BaseKafkaConsumer 상속
│
├── webhook/
│   └── webhook.service.ts                       # ReviewDispatcherService 주입 (수정)
│
└── pr-data-collector/
    └── pr-data-collector.module.ts               # INSTALLATION_TOKEN_MANAGER placeholder 제거 (수정)
```

---

## 공통 타입

### `JobState`

```typescript
type JobState = 'requested' | 'processing' | 'completed' | 'failed';
```

### `ReviewCompletedPayload`

```typescript
interface ReviewCompletedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  owner: string;
  repo: string;
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
interface ReviewFailedPayload {
  reviewJobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  reason: 'parse_error' | 'timeout' | 'server_error';
}
```

### `ReviewOrchestrator` interface

```typescript
interface ReviewOrchestrator {
  handle(payload: ReviewCompletedPayload | ReviewFailedPayload): Promise<void>;
}
```

---

## 1. `RedisModule`

```typescript
export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => new Redis(process.env.REDIS_URL!),
    },
    IdempotencyStore,
    JobStateStore,
  ],
  exports: [REDIS_CLIENT, IdempotencyStore, JobStateStore],
})
export class RedisModule {}
```

### `IdempotencyStore`

- key: `review:idempotency:{reviewJobId}`, value: `"1"`, TTL: 24시간
- `exists(reviewJobId: string): Promise<boolean>`
- `markProcessed(reviewJobId: string): Promise<void>`

### `JobStateStore`

- key: `review:state:{reviewJobId}`, value: `JobState`, TTL: 1시간 (매 `set()` 호출마다 TTL 갱신)
- `get(reviewJobId: string): Promise<JobState | null>`
- `set(reviewJobId: string, state: JobState): Promise<void>`

---

## 2. `KafkaModule`

```typescript
export const KAFKA_CLIENT = 'KAFKA_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: () =>
        new Kafka({
          clientId: 'dovi-github-app',
          brokers: process.env.KAFKA_BOOTSTRAP_SERVERS!.split(','),
        }),
    },
    KafkaProducerService,
  ],
  exports: [KAFKA_CLIENT, KafkaProducerService],
})
export class KafkaModule {}
```

### `KafkaProducerService`

```typescript
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly producer: Producer;

  constructor(@Inject(KAFKA_CLIENT) kafka: Kafka) {
    this.producer = kafka.producer();
  }

  async onModuleInit() {
    await this.producer.connect();
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
  }

  async send(topic: string, payload: object, key?: string): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(payload) }],
    });
  }
}
```

### `BaseKafkaConsumer` (abstract)

- 구독 토픽/`groupId`는 서브클래스 생성자에서 전달
- `autoCommit: false`, `eachMessage`에서 `handleMessage()` 호출 후 수동 `commitOffsets()`
- `handleMessage()`가 throw하면 commit하지 않고 그대로 전파 (재시도는 컨슈머 재시작/리밸런싱 시점에 동일 오프셋부터 재수행)
- `CRASH` 이벤트는 로깅만 수행 (`process.exit` 호출 없음)

```typescript
export abstract class BaseKafkaConsumer implements OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  private readonly consumer: Consumer;

  constructor(
    kafka: Kafka,
    private readonly groupId: string,
    private readonly topics: string[],
  ) {
    this.consumer = kafka.consumer({ groupId: this.groupId });
  }

  protected async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.topics });

    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      this.logger.error('Kafka consumer crashed', payload.error);
    });

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        await this.handleMessage(topic, message);
        await this.consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (Number(message.offset) + 1).toString(),
          },
        ]);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  protected abstract handleMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<void>;
}
```

---

## 3. `InstallationTokenManagerService` (`installation-token/`)

```typescript
@Injectable()
export class InstallationTokenManagerService implements InstallationTokenManager {
  private readonly TOKEN_TTL_SECONDS = 50 * 60;
  private readonly appAuth = createAppAuth({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  });

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getOctokit(installationId: number): Promise<Octokit> {
    const cacheKey = `github:token:${installationId}`;
    const cachedToken = await this.redis.get(cacheKey);
    if (cachedToken) {
      return new Octokit({ auth: cachedToken });
    }

    const { token } = await this.appAuth({
      type: 'installation',
      installationId,
    });
    await this.redis.set(cacheKey, token, 'EX', this.TOKEN_TTL_SECONDS);

    return new Octokit({ auth: token });
  }
}
```

- 캐시 hit 시 재발급 없이 캐싱된 토큰으로 새 `Octokit` 인스턴스 생성
- 캐시 miss 시 `createAppAuth()`로 JWT 서명 + installation token 발급 → Redis 저장 → `Octokit` 생성
- 동시에 같은 `installationId`로 두 요청이 miss를 동시에 겪으면 토큰이 중복 발급될 수 있음 (분산락 없음, 이번 범위 외)

### `InstallationTokenModule`

```typescript
@Global()
@Module({
  providers: [
    {
      provide: INSTALLATION_TOKEN_MANAGER,
      useClass: InstallationTokenManagerService,
    },
  ],
  exports: [INSTALLATION_TOKEN_MANAGER],
})
export class InstallationTokenModule {}
```

`PrDataCollectorModule`의 기존 placeholder provider(`useFactory: () => throw ...`)는 제거하고, 전역으로 등록된 `INSTALLATION_TOKEN_MANAGER`를 그대로 사용한다.

---

## 4. `ReviewDispatcherService`

### `dispatch(payload: ReviewRequestPayload): Promise<void>`

```
1. idempotencyStore.exists(reviewJobId)
   → true면 logger.log() 후 return (스킵, 에러 아님)
2. jobStateStore.get(reviewJobId)
   → 'completed' | 'processing' 이면 logger.log() 후 return (스킵)
3. jobStateStore.set(reviewJobId, 'requested')
4. kafkaProducer.send(KAFKA_REVIEW_REQUEST_TOPIC, payload, key: reviewJobId)
   → 실패 시 logger.error() 후 throw
```

- Kafka 메시지 key는 `reviewJobId` (파티션 친화성, 향후 동일 리뷰 작업 메시지 순서 보장 목적)
- `IdempotencyStore`에 값을 쓰지 않음 — 완료 확정 시점(`ReviewResultConsumer`)에만 기록되므로, 발행 실패/리뷰 실패는 24시간 내에도 재시도 가능

### `ReviewDispatcherModule`

```typescript
@Module({
  providers: [ReviewDispatcherService],
  exports: [ReviewDispatcherService],
})
export class ReviewDispatcherModule {}
```

(`RedisModule`, `KafkaModule`은 `@Global()`이므로 별도 import 불필요)

### `WebhookService` 변경

```typescript
this.prDataCollectorService
  .collect(command)
  .then((payload) => {
    if (payload === null) {
      this.logger.warn(`PR #${...} 수집 스킵 (diff 크기 초과)`);
      return;
    }
    return this.reviewDispatcherService.dispatch(payload);
  })
  .catch((err: unknown) => {
    this.logger.error(`PR 데이터 수집/리뷰 발행 실패 (PR #${...})`, err);
  });
```

`WebhookModule`은 `ReviewDispatcherModule`을 추가로 import한다.

---

## 5. `ReviewResultConsumerService`

`BaseKafkaConsumer`를 상속하며 `groupId: 'github-app-review-result'`, 토픽 `[KAFKA_REVIEW_COMPLETED_TOPIC, KAFKA_REVIEW_FAILED_TOPIC]`을 구독한다.

```typescript
@Injectable()
export class ReviewResultConsumerService
  extends BaseKafkaConsumer
  implements OnModuleInit
{
  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(REVIEW_ORCHESTRATOR)
    private readonly orchestrator: ReviewOrchestrator,
    private readonly jobStateStore: JobStateStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {
    super(kafka, 'github-app-review-result', [
      process.env.KAFKA_REVIEW_COMPLETED_TOPIC!,
      process.env.KAFKA_REVIEW_FAILED_TOPIC!,
    ]);
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  protected async handleMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<void> {
    if (topic === process.env.KAFKA_REVIEW_COMPLETED_TOPIC) {
      const payload: ReviewCompletedPayload = JSON.parse(
        message.value!.toString(),
      );
      await this.orchestrator.handle(payload);
      await this.jobStateStore.set(payload.reviewJobId, 'completed');
      await this.idempotencyStore.markProcessed(payload.reviewJobId);
      return;
    }

    if (topic === process.env.KAFKA_REVIEW_FAILED_TOPIC) {
      const payload: ReviewFailedPayload = JSON.parse(
        message.value!.toString(),
      );
      await this.orchestrator.handle(payload);
      await this.jobStateStore.set(payload.reviewJobId, 'failed');
      return;
    }
  }
}
```

- JSON 파싱 실패도 다른 처리 실패와 동일하게 throw → commit 안 함 → 재시도 (poison pill 가능성은 이번 범위 외, 후속 Dead Letter 작업으로 분리)
- `completed` 처리에서만 `idempotencyStore.markProcessed()` 호출 (확정 완료된 리뷰만 24시간 idempotency 보호)

### `ReviewResultConsumerModule`

```typescript
@Module({
  providers: [
    ReviewResultConsumerService,
    {
      provide: REVIEW_ORCHESTRATOR,
      useFactory: () => {
        throw new Error(
          'ReviewOrchestrator is not implemented. Provide a concrete class.',
        );
      },
    },
  ],
})
export class ReviewResultConsumerModule {}
```

(`PrDataCollectorModule`의 기존 placeholder 패턴과 동일하게, 5번 작업에서 실제 구현체로 교체)

---

## Redis Key 컨벤션

```
IdempotencyStore:
  review:idempotency:{reviewJobId}
  value: "1"
  TTL: 24시간

JobStateStore:
  review:state:{reviewJobId}
  value: requested | processing | completed | failed
  TTL: 1시간

InstallationToken:
  github:token:{installationId}
  value: token string
  TTL: 50분
```

---

## 환경변수

| 변수명                         | 용도                                                |
| ------------------------------ | --------------------------------------------------- |
| `GITHUB_APP_ID`                | GitHub App 식별 (`InstallationTokenManagerService`) |
| `GITHUB_PRIVATE_KEY`           | PEM 형식 서명 키 (`\n` 리터럴 → 개행 변환 필요)     |
| `KAFKA_BOOTSTRAP_SERVERS`      | Kafka 브로커 주소 (comma-separated)                 |
| `KAFKA_REVIEW_REQUEST_TOPIC`   | `pr.review.requested`                               |
| `KAFKA_REVIEW_COMPLETED_TOPIC` | `pr.review.completed`                               |
| `KAFKA_REVIEW_FAILED_TOPIC`    | `pr.review.failed`                                  |
| `REDIS_URL`                    | Redis 연결 문자열                                   |

---

## 패키지 설치 필요

```bash
npm install kafkajs ioredis @octokit/auth-app
```

---

## 테스트 범위

- `ReviewDispatcherService.dispatch()`: idempotency hit / jobState completed·processing / 정상 발행 / Kafka 발행 실패 시 throw 4가지 분기
- `ReviewResultConsumerService.handleMessage()`: completed 토픽 처리(jobState + idempotency 기록 확인) / failed 토픽 처리(jobState만 기록) 2가지 분기
- Redis/Kafka 클라이언트는 모두 mock 처리, 실제 연결 없이 단위 테스트만 작성

---

## 이번 구현 범위 외

- `ReviewOrchestrator` 실제 구현체 (interface만 정의, 5번에서 구현)
- `DistributedLock` (5번 Orchestrator에서 사용)
- Dead Letter Queue / Outbox 패턴 (Consumer 처리 실패·JSON 파싱 실패에 대한 후속 보강)
- `InstallationTokenManagerService`의 동시 캐시 miss 시 중복 토큰 발급 방지 (분산락 미적용)
- `@nestjs/config` 도입 (기존 `process.env` 직접 참조 방식 유지)
