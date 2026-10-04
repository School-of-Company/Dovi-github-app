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
- **시크릿 마스킹**: ai-server → LLM → Langfuse로 가기 전에 `changedFiles[].content`/`patch`와 `contextFiles[].content`(그리고 repo-index의 `changedFiles[].content`)의 하드코딩된 시크릿을 `common/secret-mask.ts`가 가린다. 경로 기반 제외(`isSecretPath`)가 못 거르는 소스 안의 키가 대상이다. GitHub/AWS/Slack/Discord/JWT 토큰은 앞 4글자만 남기고(`ghp_***`), `password`·`secret`·`token`·`api_key` 등 이름에 **따옴표 친 문자열 값**과 접속 URL의 비밀번호(`scheme://user:***@host`), `PRIVATE KEY` 블록은 `***`로 바꾼다. **줄 수와 줄 위치는 보존**한다(치환은 한 줄 안에서만, patch의 `+`/`-` 접두사 유지). 가려진 줄은 ai-server의 evidence 원문 대조와 어긋날 수 있다.
- 추가로 `content + patch` 총합에 768KB(`CHANGED_FILE_TOTAL_BUDGET`) 상한을 둔다. `patch`는 GitHub API가 파일 하나 단위로만 제한해서, 파일 수가 많은 PR은 content를 다 비워도 patch만으로 메시지 크기를 넘길 수 있다. 상한을 넘으면 content를 먼저 더 비우고, 그래도 넘으면 큰 파일부터 `patch`까지 비운다(파일 항목 `filePath`/`status`는 남는다 — 그 파일은 사실상 리뷰 대상에서 빠진다). 이런 대형 PR을 정보 손실 없이 리뷰하는 샤딩 방식은 #58에서 설계 중이다.

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

**재리뷰 중복 방지(지문)**: github-app은 게시하는 인라인 코멘트 본문 끝에 눈에 보이지 않는 마커 `<!-- dovi:fp={16자리 hex} -->`를 심는다. 재리뷰 결과가 오면 PR에 남은 봇 코멘트의 마커와 새 `reviews[]`의 지문을 비교해, **다시 나온 지적은 지우지도 다시 올리지도 않고**(사용자가 resolve한 스레드가 되살아나지 않는다), 이번에 안 나온 지적(코드가 고쳐짐)의 코멘트만 지우고, 새 지적만 올린다. 답글이 달린 스레드는 항상 보존한다. Redis가 아니라 GitHub 코멘트 자체에 저장되므로 Redis를 잃거나 TTL이 지나도 중복되지 않는다.

- 지문 = `sha256(filePath | 정규화한 title | 정규화한 evidence)`의 앞 16자(정규화는 소문자·공백 축약). **evidence가 있으면 줄 번호를 넣지 않아** 새 커밋으로 줄이 밀려도 같은 지적으로 인식하고, evidence가 없으면 message와 줄 번호까지 넣어 서로 다른 위치의 같은 문구를 구분한다.
- `reviews[].fingerprint?`(선택): ai-server가 지문을 계산해 보내면(Dovi-ai-server#132) 그 값을 지문으로 쓴다. 없는 기존 이벤트는 위 방식으로 직접 계산하므로 호환된다.
- 이 기능 이전에 게시된(마커 없는) 코멘트는 기존처럼 정리·재게시된다.

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
4. 지원 스택 감지 + 허용 스택 (PR head 기준, 앞에서부터 처음 맞는 스택 하나). `nestjs`(`package.json`에 `@nestjs/core`), `nextjs`(`next`), `react`(`react`), `vue`(`vue`), `spring`(`build.gradle`/`build.gradle.kts`/`pom.xml`에 Spring Boot). 감지된 스택이 `SANDBOX_PROBE_STACKS`(쉼표 구분, 기본값 `nestjs`)에 없으면 스킵 — 워커에 그 스택의 레시피가 준비된 뒤 켠다
5. 문서 전용 PR이 아님 (변경 파일이 전부 `docs/` 하위이거나 `.md`/`.mdx`면 스킵 — lockfile만 바뀐 PR은 문서 전용으로 취급하지 않는다)

| 필드             | 타입   | 비고                                                                                                                                                                                                                                           |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewJobId`    | string | `pr.review.requested`와 동일한 포맷(`{repositoryId}:{prNumber}:{headSha}`)이지만 별개 트랙 — github-app 쪽 dedup 키는 `sandbox:{reviewJobId}`로 네임스페이스를 분리해 메인 리뷰 idempotency와 충돌하지 않게 한다(과거 실제 충돌 사고 #40 참고) |
| `repositoryId`   | number |                                                                                                                                                                                                                                                |
| `repoFullName`   | string | `owner/repo` — clone에 필수. **"한쪽만 쓰는 필드는 이벤트에 안 싣는다"는 아래 요약 원칙 4번의 의도적 예외**(ai-server가 실제로 clone에 소비)                                                                                                   |
| `prNumber`       | number |                                                                                                                                                                                                                                                |
| `headSha`        | string | clone 시 이 sha로 고정 checkout (브랜치 tip이 아님 — TOCTOU 방지)                                                                                                                                                                              |
| `baseSha`        | string |                                                                                                                                                                                                                                                |
| `installationId` | number | 워커가 잡을 실제로 시작하기 직전에 아래 "토큰 발급 내부 API"를 호출할 때 쓴다(installation token은 Kafka 이벤트에 절대 싣지 않는다)                                                                                                            |
| `stack`          | string | `nestjs` \| `nextjs` \| `react` \| `vue` \| `spring`. 워커가 스택별 레시피(설치/빌드/기동 명령, 전용 프로브)를 고르는 기준. 도비가 repo의 빌드 파일로 감지해 싣는다                                                                            |

메시지 key: `reviewJobId`. github-app은 발행 시 `SandboxProbeJobContextStore`(Redis, TTL 2시간)에 `reviewJobId` → `{owner, repo, prNumber, installationId}`를 저장해, completed 이벤트를 받았을 때 어느 PR에 코멘트를 달지 알아낸다.

#### 토큰 발급 내부 API

워커 VM에는 GitHub App private key를 두지 않으므로, 워커가 clone 직전에 github-app에서 토큰을 받는다.

- `POST /internal/sandbox-probe/token`
- 인증: 헤더 `X-Dovi-Internal-Secret` = 양쪽 공유 시크릿(github-app `GITHUB_APP_INTERNAL_SECRET`, 워커 VM `GITHUB_APP_INTERNAL_SECRET`). 불일치 401, github-app에 시크릿 미설정 시 503
- 요청: `{ "installationId": number, "repositoryId": number }` (양의 정수, 아니면 400)
- 응답: `{ "token": string, "expiresAt": string }` — `contents: read`, `repositories: [repositoryId]`로 좁힌 토큰. 스코프별 캐시 키를 써서 메인 리뷰용 전체 권한 토큰 캐시와 섞이지 않는다
- GitHub가 발급 대상을 거부하면(404/422/403 — installation 없음, 저장소가 installation에 속하지 않음 등) 422. GitHub 5xx·네트워크 오류·레이트 리밋(429, 레이트 리밋 403)·401(github-app 쪽 App 인증 설정 문제)은 500(워커가 재시도)
- **github-app이 샌드박스 잡을 발행한 (installation, 저장소) 조합에만 발급한다.** 발행 시 Redis(`sandbox-probe:active:{installationId}:{repositoryId}`, TTL 2시간, 새 잡이 발행될 때마다 갱신)에 표시를 남기고, 표시가 없으면 403. 워커 VM은 신뢰할 수 없는 PR 코드를 실행하므로 공유 시크릿이 새더라도 opt-in하지 않은 다른 저장소의 코드는 읽지 못하게 하기 위함
- 스코프 토큰은 남은 수명이 30분 이상인 것만 내준다(clone이 오래 걸려도 도중에 만료되지 않게). 부족하면 새로 발급한다
- 토큰 값은 로그에 남기지 않는다

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

github-app은 이 이벤트를 받으면 **메인 리뷰 코멘트(`pulls.createReview`)는 건드리지 않고**, PR 대화창에 마커 주석(`<!-- dovi:sandbox-probe -->`) 기반 sticky 코멘트를 upsert한다(`issues.createComment`/`issues.updateComment`) — 재푸시마다 코멘트가 쌓이지 않도록 항상 같은 코멘트를 갱신하며, 상태별 이모지(✅/🐛/⚠️)를 붙인다. 게시 전 evidence는 본문에 등장하는 최장 백틱 런보다 긴 코드펜스로 감싸고 `@` 멘션을 무력화(zero-width space 삽입)한다. LLM은 개입하지 않는다 — 요약 문구는 프로브 스크립트의 고정 템플릿이다. 결과의 `headSha`가 PR의 현재 head와 다르거나(워커가 도는 동안 새 커밋이 푸시됨) PR이 닫혔으면 오래된 결과이므로 게시하지 않는다 — 새 커밋의 결과가 먼저 도착해 코멘트를 갱신했을 수도 있어 덮어쓰지 않기 위함.

## 요약 원칙

1. 토픽 이름: `도메인.대상.이벤트` (dot-separated).
2. JSON 필드: 항상 camelCase (Python 쪽은 pydantic alias로 변환).
3. `reviewJobId`: `{repositoryId}:{prNumber}:{headSha}`, 콜론 구분.
4. 페이로드는 **실제로 상대편이 보내거나 읽는 필드만** 포함한다 — 한쪽만 쓰는 필드(예: 과거의 `diff`, `owner`, `repo`)는 이벤트에 싣지 않고 필요한 서비스 내부에서만 사용한다. `pr.sandbox.probe.requested`의 `repoFullName`은 의도적 예외 — clone에 필수라 ai-server가 실제로 소비한다.
