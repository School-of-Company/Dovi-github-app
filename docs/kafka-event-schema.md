# Kafka 이벤트 네이밍/스키마 정리

`Dovi-github-app`(NestJS/TypeScript, producer/consumer)과 `Dovi-ai-server`(FastAPI/pydantic, consumer/producer)가 주고받는
Kafka 이벤트의 토픽 이름과 페이로드 필드 명명 규칙을 정리한다. `Dovi-ai-server`의 스키마(`app/review/schema.py`)를 기준으로
`Dovi-github-app` 쪽 타입을 정합하였다 (PR: `fix/kafka-review-event-schema-align`).

## 토픽 이름

`<도메인>.<대상>.<이벤트>` 형태의 dot-separated, 소문자 스네이크 없는 케밥성 네이밍을 사용한다.

| 토픽                         | 방향                   | 환경변수 (github-app)                 |
| ---------------------------- | ---------------------- | ------------------------------------- |
| `pr.review.requested`        | github-app → ai-server | `KAFKA_REVIEW_REQUEST_TOPIC`          |
| `pr.review.completed`        | ai-server → github-app | `KAFKA_REVIEW_COMPLETED_TOPIC`        |
| `pr.review.failed`           | ai-server → github-app | `KAFKA_REVIEW_FAILED_TOPIC`           |
| `pr.sandbox.probe.requested` | github-app → ai-server | `KAFKA_SANDBOX_PROBE_REQUEST_TOPIC`   |
| `pr.sandbox.probe.completed` | ai-server → github-app | `KAFKA_SANDBOX_PROBE_COMPLETED_TOPIC` |

## 메시지 key

Kafka 메시지 key는 `reviewJobId`(문자열)를 그대로 사용한다.

## `reviewJobId` 포맷

`{repositoryId}:{prNumber}:{headSha}` — 콜론(`:`) 구분자.

- 생성 주체는 `Dovi-github-app`의 `PrDataCollectorService.collect()` (요청 이벤트를 최초로 만드는 쪽).
- `Dovi-ai-server`의 `make_review_job_id()` 헬퍼도 동일한 포맷을 사용한다.
- 양쪽 다 `reviewJobId`는 파싱하지 않는 불투명(opaque) 문자열로만 취급하지만, Redis 키(`review:state:{reviewJobId}`)
  등에서 사람이 읽을 때 형식이 어긋나면 혼란을 주므로 통일한다.

## 필드 네이밍 규칙

- **JSON 상의 필드명은 항상 camelCase**로 통일한다.
  - `Dovi-github-app`: TypeScript 인터페이스가 곧 camelCase이므로 별도 변환이 필요 없다.
  - `Dovi-ai-server`: pydantic 모델은 내부적으로 snake_case 속성을 쓰지만, 모든 모델이
    `alias_generator=to_camel` + `populate_by_name=True`를 적용한 `CamelModel`을 상속하고,
    직렬화 시 `model_dump_json(by_alias=True)`로 camelCase JSON을 생성한다.
  - 즉 Python 쪽 `review_job_id` ↔ JSON/`TS` 쪽 `reviewJobId`, `file_path` ↔ `filePath` 식으로 항상 매핑된다.

## 이벤트별 페이로드

### `pr.review.requested`

| 필드           | 타입   | 비고                                                                                                                                                                                                                                          |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewJobId`  | string | 메시지 key와 동일                                                                                                                                                                                                                             |
| `repositoryId` | number | GitHub repository id (숫자)                                                                                                                                                                                                                   |
| `prNumber`     | number |                                                                                                                                                                                                                                               |
| `prTitle`      | string | PR 제목                                                                                                                                                                                                                                       |
| `prBody`       | string | PR 본문. GitHub API 사양상 본문 없는 PR은 `null`일 수 있어 github-app이 빈 문자열로 대체해 전송한다. ai-server가 2000자로 자르고 `<pr_description>` 태그로 감싸 처리하므로 github-app 쪽은 별도 길이 제한/이스케이프 없이 원문 그대로 보낸다. |
| `headSha`      | string |                                                                                                                                                                                                                                               |
| `baseSha`      | string |                                                                                                                                                                                                                                               |
| `contextFiles` | array  | 아래 `ContextFile` 참고                                                                                                                                                                                                                       |
| `changedFiles` | array  | 아래 `ChangedFile` 참고                                                                                                                                                                                                                       |

`ChangedFile`:

| 필드       | 타입                                              | 비고                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath` | string                                            | GitHub API의 `filename`을 `filePath`로 매핑해서 전송                                                                                                                                                                                                                                                                                                     |
| `status`   | `'added' \| 'modified' \| 'removed' \| 'renamed'` | ai-server가 허용하는 4종만 전송. `copied`/`changed`/`unchanged`인 파일은 수집 단계에서 제외                                                                                                                                                                                                                                                              |
| `patch`    | string?                                           |                                                                                                                                                                                                                                                                                                                                                          |
| `content`  | string?                                           | 변경 후 파일 전체 원문 (UTF-8). ai-server의 AST context 기능(`app/review/chunking.py`)이 변경된 함수/클래스 전체를 리뷰에 포함시키는 데 사용. `removed` 파일, tree-sitter 미지원 확장자(`.py`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.ts`/`.tsx` 외), secret 경로, 200KB(`CHANGED_FILE_CONTENT_SIZE_LIMIT`) 초과 시 생략 — 이 경우 ai-server는 hunk만으로 리뷰한다. |

- Kafka 브로커 기본 `message.max.bytes`(~1MB)를 넘기지 않도록, PR 하나에서 보내는 `changedFiles[].content` 총합에 512KB(`CHANGED_FILE_CONTENT_TOTAL_BUDGET`) 예산을 둔다. 초과하면 `PrDataCollectorService`가 큰 파일부터 `content`를 비운다(파일 자체는 `patch`와 함께 그대로 남는다) — GitHub Contents API 자체도 파일당 1MB 상한이 있어 개별 파일 크기만으로는 메시지 전체 크기를 보장할 수 없기 때문.

`ContextFile` (ai-server의 `## Project Context` 프롬프트 섹션을 채우는 값, 노션 기획 7.2절 "DOVI.md가 프로젝트 컨텍스트 진입점"):

| 필드      | 타입   | 비고                                                           |
| --------- | ------ | -------------------------------------------------------------- |
| `path`    | string | 저장소 내 파일 경로                                            |
| `content` | string | 파일 원문 (UTF-8)                                              |
| `source`  | string | 항상 `"github"` (ai-server `ContextFile.source` 기본값과 일치) |

- 후보 파일: 루트의 `DOVI.md`(최우선), `README.md`, `openapi.yaml`/`openapi.yml`/`swagger.json`, `docs/**` 하위 전체 — 모두 "있으면" 포함하는 방식이며, 우선순위 정렬은 ai-server의 `app/review/context.py::_priority`가 담당한다.
- secret 경로(`secrets/` 디렉터리, `.env*`, `.pem`/`.p8`/`.key` 확장자, 파일명에 `private-key`/`private_key` 포함)는 `PrDataCollectorService`의 `isSecretPath()`가 1차로 제외한다. ai-server의 `_is_secret()`이 동일 규칙으로 한 번 더 필터링한다.
- 파일당 200KB(`CONTEXT_FILE_SIZE_LIMIT`) 초과 시 수집 단계에서 제외한다 (ai-server의 8000자/파일, 20000자/전체 truncation과는 별개의 1차 방어).

`owner`, `repo`, `diff`는 ai-server가 소비하지 않아 페이로드에서 제외한다 (수집 단계에서 diff 크기 제한 체크 용도로만 로컬 사용).

### `pr.review.completed`

| 필드            | 타입   | 비고                                                                                          |
| --------------- | ------ | --------------------------------------------------------------------------------------------- |
| `reviewJobId`   | string |                                                                                               |
| `repositoryId`  | number |                                                                                               |
| `prNumber`      | number |                                                                                               |
| `headSha`       | string |                                                                                               |
| `summary`       | string |                                                                                               |
| `reviews`       | array  | `severity`, `confidence`, `filePath`, `line`, `title`, `message`, `evidence`, `suggestedFix?` |
| `modelVersion`  | string | ai-server가 사용한 LLM 버전                                                                   |
| `promptVersion` | string |                                                                                               |

`owner`, `repo`는 ai-server가 보내지 않으므로 github-app 쪽 타입에도 포함하지 않는다.

### `pr.review.failed`

| 필드          | 타입                                           | 비고 |
| ------------- | ---------------------------------------------- | ---- |
| `reviewJobId` | string                                         |      |
| `headSha`     | string                                         |      |
| `reason`      | `'parse_error' \| 'timeout' \| 'server_error'` |      |

`repositoryId`, `prNumber`는 ai-server가 보내지 않으므로 포함하지 않는다.

### `repo.index.requested`

github-app → ai-server. Index Branch(DOVI.md `## Index Branch`, 없으면 `repository.default_branch`)로 push될 때만 발행한다. 최초 전체 인덱싱은 대상이 아니며 (`before`가 전부 0인 신규 브랜치 push는 스킵), 증분(diff) 업데이트만 다룬다.

| 필드           | 타입   | 비고                                         |
| -------------- | ------ | -------------------------------------------- |
| `repositoryId` | number |                                              |
| `branch`       | string | Index Branch                                 |
| `headSha`      | string | push의 `after`                               |
| `changedFiles` | array  | 아래 참고. `pr.review.requested`와 별개 구조 |

`changedFiles[]`:

| 필드       | 타입                                              | 비고                                                                                                    |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `filePath` | string                                            |                                                                                                         |
| `status`   | `'added' \| 'modified' \| 'removed' \| 'renamed'` |                                                                                                         |
| `content`  | string?                                           | `after` 기준 원문. `removed`, secret 경로, 200KB 초과 시 생략. 총합 512KB 예산 초과 시 큰 파일부터 생략 |

메시지 key: `{repositoryId}:{branch}:{headSha}`.

### `pr.comment.reflected`

github-app → ai-server. 봇 리뷰 코멘트 스레드에 달린 답글을 텍스트 휴리스틱(`ReviewFeedbackDispatcherService`/`classifyReflection`)으로 분석해, 반영/미반영으로 읽히면 발행한다. 애매하면 발행하지 않는다.

| 필드           | 타입    | 비고                                                       |
| -------------- | ------- | ---------------------------------------------------------- |
| `reviewJobId`  | string  | 원본 `pr.review.completed`의 reviewJobId와 동일            |
| `findingIndex` | number  | 원본 `pr.review.completed`의 `reviews` 배열 내 인덱스      |
| `reflected`    | boolean |                                                            |
| `reason`       | string? | `reflected: false`일 때만 채움 (답글 원문, 200자 truncate) |

메시지 key: `reviewJobId`. `findingIndex`는 리뷰 등록 시 `ReviewCommentFindingStore`(Redis, TTL 30일 — PR이 열려있는 동안 언제든 답글이 달릴 수 있어 `PrimaryReviewStore`와 동일하게 잡는다)에 GitHub 코멘트 id → `{reviewJobId, findingIndex}`로 저장해두었다가, 그 코멘트에 답글이 달렸을 때 역조회한다.

### `pr.sandbox.probe.requested`

github-app → ai-server. 메인 리뷰 발행 경로와 완전히 독립된 경로(`SandboxProbeDispatcherService`)에서 발행한다 — 이 경로의 성공/실패가 메인 리뷰에 영향을 주지 않는다. PR 이벤트(`opened`/`synchronize`/`reopened`, draft 제외)마다 아래 조건을 모두 만족할 때만 발행한다:

1. 발행 측 킬스위치(`SANDBOX_PROBE_PUBLISH_ENABLED=true`) 켜짐
2. 같은 레포 브랜치 PR (fork PR 제외 — `isForkPr()`)
3. 레포별 opt-in (`DOVI.md`의 `## Sandbox Probe` 섹션 값이 `true`/`on`/`enabled`/`yes`, `default_branch` 기준으로 읽음)
4. 지원 스택 감지 (`package.json`의 `dependencies`/`devDependencies`에 `@nestjs/core` 존재, PR head 기준)
5. 문서 전용 PR이 아님 (변경 파일이 전부 `docs/` 하위이거나 `.md`/`.mdx`면 스킵 — lockfile만 바뀐 PR은 문서 전용으로 취급하지 않는다)

| 필드             | 타입   | 비고                                                                                                                                                                                                                                                      |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewJobId`    | string | `pr.review.requested`와 동일한 포맷(`{repositoryId}:{prNumber}:{headSha}`)이지만 별개 트랙 — github-app 쪽 dedup 키는 `sandbox:{reviewJobId}`로 네임스페이스를 분리해 메인 리뷰 idempotency와 충돌하지 않게 한다(과거 실제 충돌 사고 #40 참고)            |
| `repositoryId`   | number |                                                                                                                                                                                                                                                           |
| `repoFullName`   | string | `owner/repo` — clone에 필수. **"한쪽만 쓰는 필드는 이벤트에 안 싣는다"는 아래 요약 원칙 4번의 의도적 예외**(ai-server가 실제로 clone에 소비)                                                                                                              |
| `prNumber`       | number |                                                                                                                                                                                                                                                           |
| `headSha`        | string | clone 시 이 sha로 고정 checkout (브랜치 tip이 아님 — TOCTOU 방지)                                                                                                                                                                                         |
| `baseSha`        | string |                                                                                                                                                                                                                                                           |
| `installationId` | number | 워커가 잡을 실제로 시작하기 직전에 `contents:read` 스코프 토큰을 요청할 때 필요(스펙의 "토큰 처리" 절 — installation token은 Kafka 이벤트에 절대 싣지 않는다). **그 요청을 받을 github-app 쪽 엔드포인트/인증 방식은 별도 이슈로 설계 필요**(아직 미구현) |

메시지 key: `reviewJobId`. github-app은 발행 시 `SandboxProbeJobContextStore`(Redis, TTL 2시간)에 `reviewJobId` → `{owner, repo, prNumber, installationId}`를 저장해, completed 이벤트를 받았을 때 어느 PR에 코멘트를 달지 알아낸다.

### `pr.sandbox.probe.completed`

ai-server → github-app. `SandboxProbeResultConsumerService`(독립 컨슈머 그룹 `github-app-sandbox-probe-result` — 기존 `github-app-review-result`에 얹지 않음)가 받아 `SandboxProbeResponderService`로 처리한다. `failed` 토픽은 없다 — 실패도 `status: "inconclusive"`로 이 토픽에 실어 보낸다.

| 필드           | 타입                                          | 비고                                                                                   |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `reviewJobId`  | string                                        | 요청 이벤트와 동일                                                                     |
| `repositoryId` | number                                        |                                                                                        |
| `prNumber`     | number                                        |                                                                                        |
| `headSha`      | string                                        |                                                                                        |
| `status`       | `'passed' \| 'found_issue' \| 'inconclusive'` |                                                                                        |
| `evidence`     | string                                        | 전체 요약 근거, 최대 8KB(초과 시 뒷부분 우선 보존 — 빌드 에러는 보통 출력 끝에 나온다) |
| `findings`     | array                                         | 최대 10개. 아래 `Finding` 참고                                                         |

`Finding`:

| 필드       | 타입                                     | 비고                                                                                                        |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `probe`    | `'init_order' \| 'lifecycle' \| 'build'` |                                                                                                             |
| `title`    | string                                   |                                                                                                             |
| `message`  | string                                   |                                                                                                             |
| `filePath` | string \| null                           | 메인 리뷰의 `ReviewComment`와 달리 특정 라인을 가리킬 수 없는 finding(예: 생명주기 훅 누락)이 있어 nullable |
| `line`     | number \| null                           | 위와 동일한 이유로 nullable (메인 리뷰의 `line: number, gt=0` 필수와 다름)                                  |
| `evidence` | string                                   | 최대 4KB                                                                                                    |

github-app은 이 이벤트를 받으면 **메인 리뷰 코멘트(`pulls.createReview`)는 건드리지 않고**, PR 대화창에 마커 주석(`<!-- dovi:sandbox-probe -->`) 기반 sticky 코멘트를 upsert한다(`issues.createComment`/`issues.updateComment`) — 재푸시마다 코멘트가 쌓이지 않도록 항상 같은 코멘트를 갱신하며, 상태별 이모지(✅/🐛/⚠️)를 붙인다. 게시 전 evidence는 본문에 등장하는 최장 백틱 런보다 긴 코드펜스로 감싸고 `@` 멘션을 무력화(zero-width space 삽입)한다. LLM은 개입하지 않는다 — 요약 문구는 프로브 스크립트의 고정 템플릿이다.

## 요약 원칙

1. 토픽 이름: `도메인.대상.이벤트` (dot-separated).
2. JSON 필드: 항상 camelCase (Python 쪽은 pydantic alias로 변환).
3. `reviewJobId`: `{repositoryId}:{prNumber}:{headSha}`, 콜론 구분.
4. 페이로드는 **실제로 상대편이 보내거나 읽는 필드만** 포함한다 — 한쪽만 쓰는 필드(예: 과거의 `diff`, `owner`, `repo`)는 이벤트에 싣지 않고 필요한 서비스 내부에서만 사용한다. `pr.sandbox.probe.requested`의 `repoFullName`은 의도적 예외 — clone에 필수라 ai-server가 실제로 소비한다.
