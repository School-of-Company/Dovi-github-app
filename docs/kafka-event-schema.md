# Kafka 이벤트 네이밍/스키마 정리

`Dovi-github-app`(NestJS/TypeScript, producer/consumer)과 `Dovi-ai-server`(FastAPI/pydantic, consumer/producer)가 주고받는
Kafka 이벤트의 토픽 이름과 페이로드 필드 명명 규칙을 정리한다. `Dovi-ai-server`의 스키마(`app/review/schema.py`)를 기준으로
`Dovi-github-app` 쪽 타입을 정합하였다 (PR: `fix/kafka-review-event-schema-align`).

## 토픽 이름

`<도메인>.<대상>.<이벤트>` 형태의 dot-separated, 소문자 스네이크 없는 케밥성 네이밍을 사용한다.

| 토픽                  | 방향                   | 환경변수 (github-app)          |
| --------------------- | ---------------------- | ------------------------------ |
| `pr.review.requested` | github-app → ai-server | `KAFKA_REVIEW_REQUEST_TOPIC`   |
| `pr.review.completed` | ai-server → github-app | `KAFKA_REVIEW_COMPLETED_TOPIC` |
| `pr.review.failed`    | ai-server → github-app | `KAFKA_REVIEW_FAILED_TOPIC`    |

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

| 필드           | 타입   | 비고                        |
| -------------- | ------ | --------------------------- |
| `reviewJobId`  | string | 메시지 key와 동일           |
| `repositoryId` | number | GitHub repository id (숫자) |
| `prNumber`     | number |                             |
| `headSha`      | string |                             |
| `baseSha`      | string |                             |
| `changedFiles` | array  | 아래 `ChangedFile` 참고     |

`ChangedFile`:

| 필드       | 타입                                              | 비고                                                                                        |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `filePath` | string                                            | GitHub API의 `filename`을 `filePath`로 매핑해서 전송                                        |
| `status`   | `'added' \| 'modified' \| 'removed' \| 'renamed'` | ai-server가 허용하는 4종만 전송. `copied`/`changed`/`unchanged`인 파일은 수집 단계에서 제외 |
| `patch`    | string?                                           |                                                                                             |

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

## 요약 원칙

1. 토픽 이름: `도메인.대상.이벤트` (dot-separated).
2. JSON 필드: 항상 camelCase (Python 쪽은 pydantic alias로 변환).
3. `reviewJobId`: `{repositoryId}:{prNumber}:{headSha}`, 콜론 구분.
4. 페이로드는 **실제로 상대편이 보내거나 읽는 필드만** 포함한다 — 한쪽만 쓰는 필드(예: 과거의 `diff`, `owner`, `repo`)는 이벤트에 싣지 않고 필요한 서비스 내부에서만 사용한다.
