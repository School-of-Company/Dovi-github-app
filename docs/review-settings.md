# 레포별 리뷰 설정

레포 루트의 `DOVI.md`에 `## Review Settings` 섹션을 두면 레포마다 리뷰 범위와 코멘트 양을 조절할 수 있다. 섹션이 없으면 아무것도 바뀌지 않는다(모든 파일을 리뷰하고 모든 지적을 인라인으로 게시).

```markdown
## Review Settings

minSeverity: major
maxInlineComments: 10
include: src/**, lib/**
exclude: **/\*.generated.ts, docs/**
```

`- minSeverity: major`처럼 목록 형태로 써도 된다. 키는 대소문자를 구분하지 않는다.

## 설정 항목

| 키                  | 값                                       | 기본값    | 설명                                                                                                                    |
| ------------------- | ---------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `minSeverity`       | `critical` / `major` / `minor` / `nit`   | 제한 없음 | 이 심각도 **이상**의 지적만 게시한다. `nit`은 가장 낮은 단계인 `suggestion`의 별칭이다.                                 |
| `maxInlineComments` | 1~100 정수                               | 제한 없음 | PR 하나에 달리는 인라인 코멘트 상한. 넘는 지적은 버리지 않고 리뷰 본문의 "인라인 코멘트 상한을 넘은 지적사항"에 모은다. |
| `include`           | 쉼표로 구분한 glob (최대 50개, 각 200자) | 전체      | 지정하면 이 패턴에 맞는 파일만 리뷰한다.                                                                                |
| `exclude`           | 쉼표로 구분한 glob (최대 50개, 각 200자) | 없음      | 이 패턴에 맞는 파일은 리뷰하지 않는다. `include`와 겹치면 `exclude`가 이긴다.                                           |

glob은 `**`(여러 디렉터리), `*`(한 디렉터리 안), `?`, `{a,b}`를 지원한다. `/`가 없는 패턴(`*.lock`)은 디렉터리와 상관없이 파일명에 매치한다.

## 동작 세부

- **`minSeverity`**: 지문 계산·중복 방지 이전에 걸러진다. 그래서 값을 올린 뒤 재리뷰하면 이전에 달린 낮은 심각도 코멘트는 오래된 코멘트로 정리된다.
- **`maxInlineComments`**: PR 전체 기준이다. 이미 게시돼 남아 있는 코멘트가 칸을 차지하고, 남은 칸에만 새 코멘트가 달린다. 칸이 모자라면 심각도가 높은 것이 먼저 인라인이 되고 나머지는 본문으로 간다.
- **`include`/`exclude`**: 수집 단계에서 적용된다. 제외된 파일은 "리뷰하지 못한 파일" 안내에도 나오지 않는다(의도적으로 뺀 것이므로).
- **잘못된 값**: 해당 항목만 기본값으로 두고 나머지는 적용한다. 무시한 이유는 서버 로그에 경고(`Review Settings 경고`)로 남는다.
- **조회 실패**: `DOVI.md`를 읽지 못하거나(404 포함) 설정 저장소(Redis)에 문제가 있어도 리뷰는 설정 없이 진행한다. 설정 때문에 리뷰가 막히지 않는다.

## 어느 커밋의 `DOVI.md`를 읽는가

PR의 **base 커밋**의 `DOVI.md`를 읽는다(이슈 #85의 초안은 `default_branch`였다). 이유:

- PR 작성자가 같은 PR에서 `DOVI.md`를 고쳐 자기 변경을 `exclude`에 넣거나 `minSeverity`를 올려 지적을 숨길 수 없어야 한다. base 커밋은 PR이 바꿀 수 없는 버전이다.
- `/dovi review` 같은 명령 경로에는 `default_branch` 정보가 없고, PR base는 항상 알 수 있다.

따라서 설정을 바꾸는 PR은 **머지된 뒤** 다음 PR부터 적용된다.

## 구현 위치

- 파싱·검증: `src/common/review-settings.ts`, glob 매처: `src/common/glob.ts`
- 수집 단계(파일 필터 + 게시용 설정 저장): `PrDataCollectorService`
- 게시 단계(`minSeverity`/`maxInlineComments`): `ReviewOrchestratorService` — 게시용 설정은 Redis(`review:settings:{repositoryId}:{prNumber}:{headSha}`, TTL 2시간)로 넘긴다. 이벤트 스키마(`pr.review.requested`/`completed`)는 바뀌지 않는다.
