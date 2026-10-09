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
| `incrementalReview` | `true` / `false`                         | `false`   | 재리뷰 때 **마지막으로 리뷰한 커밋 이후 바뀐 파일만** 리뷰한다. 아래 "증분 리뷰" 참고.                                  |
| `include`           | 쉼표로 구분한 glob (최대 50개, 각 200자) | 전체      | 지정하면 이 패턴에 맞는 파일만 리뷰한다.                                                                                |
| `exclude`           | 쉼표로 구분한 glob (최대 50개, 각 200자) | 없음      | 이 패턴에 맞는 파일은 리뷰하지 않는다. `include`와 겹치면 `exclude`가 이긴다.                                           |

glob은 `**`(여러 디렉터리), `*`(한 디렉터리 안), `?`, `{a,b}`를 지원한다. `/`가 없는 패턴(`*.lock`)은 디렉터리와 상관없이 파일명에 매치한다.

## 동작 세부

- **`minSeverity`**: 지문 계산·중복 방지 이전에 걸러진다. 그래서 값을 올린 뒤 재리뷰하면 이전에 달린 낮은 심각도 코멘트는 오래된 코멘트로 정리된다.
- **`maxInlineComments`**: PR 전체 기준이다. 이미 게시돼 남아 있는 코멘트가 칸을 차지하고, 남은 칸에만 새 코멘트가 달린다. 칸이 모자라면 심각도가 높은 것이 먼저 인라인이 되고 나머지는 본문으로 간다.
- **`include`/`exclude`**: 수집 단계에서 적용된다. 제외된 파일은 "리뷰하지 못한 파일" 안내에도 나오지 않는다(의도적으로 뺀 것이므로).
- **잘못된 값**: 해당 항목만 기본값으로 두고 나머지는 적용한다. 무시한 이유는 서버 로그에 경고(`Review Settings 경고`)로 남는다.
- **조회 실패**: `DOVI.md`를 읽지 못하거나(404 포함) 설정 저장소(Redis)에 문제가 있어도 리뷰는 설정 없이 진행한다. 설정 때문에 리뷰가 막히지 않는다.

## 증분 리뷰

`incrementalReview: true`면, 이 PR에 **게시까지 성공한 마지막 리뷰의 커밋**(`review:last-sha:{repositoryId}:{prNumber}`, TTL 30일)과 현재 head를 비교해 그 사이 바뀐 파일만 AI 서버에 보낸다. 커밋 하나를 추가한 뒤의 재리뷰가 PR 전체를 다시 보지 않으므로 빨라진다.

- patch는 PR 전체 기준 그대로라 줄 번호가 맞고, 인라인 코멘트 위치 검증도 그대로 동작한다.
- **전체 리뷰로 폴백**: 첫 리뷰(기준점 없음) · 같은 커밋을 다시 리뷰(`/dovi review` 재실행) · 강제 푸시/리베이스(비교 상태가 `ahead`가 아니거나 비교 실패) · 변경 파일이 100개 이상 · 기준점 조회 실패.
- **리뷰할 파일이 남지 않으면**(바뀐 파일이 전부 `exclude` 대상 등) AI 서버를 부르지 않는다. 이전 리뷰와 코멘트가 그대로 유효하다.
- **기존 코멘트**: 이번에 다시 본 파일의 코멘트만 정리(해결된 지적은 삭제, 같은 지적은 유지)하고, 보지 않은 파일의 코멘트는 그대로 둔다. `maxInlineComments`는 그 코멘트까지 포함해 센다.
- 리뷰 본문(요약)은 이번에 본 파일만 다루며, 하단에 기준 커밋과 파일 수를 밝힌다. 기준점은 게시에 성공했을 때만 갱신하므로 중간 커밋의 리뷰가 실패하거나 버려져도 그 변경이 다음 증분에서 빠지지 않는다.
- `pr.review.requested`에 선택 필드 `incremental`/`previousHeadSha`가 실리지만 ai-server는 아직 읽지 않는다(없는 필드는 무시). 도비의 발행·게시 단계가 쓴다.

## 어느 커밋의 `DOVI.md`를 읽는가

PR의 **base 커밋**의 `DOVI.md`를 읽는다(이슈 #85의 초안은 `default_branch`였다). 이유:

- PR 작성자가 같은 PR에서 `DOVI.md`를 고쳐 자기 변경을 `exclude`에 넣거나 `minSeverity`를 올려 지적을 숨길 수 없어야 한다. base 커밋은 PR이 바꿀 수 없는 버전이다.
- `/dovi review` 같은 명령 경로에는 `default_branch` 정보가 없고, PR base는 항상 알 수 있다.

따라서 설정을 바꾸는 PR은 **머지된 뒤** 다음 PR부터 적용된다.

## 구현 위치

- 파싱·검증: `src/common/review-settings.ts`, glob 매처: `src/common/glob.ts`
- 수집 단계(파일 필터 + 게시용 설정 저장): `PrDataCollectorService`
- 게시 단계(`minSeverity`/`maxInlineComments`): `ReviewOrchestratorService` — 게시용 설정은 Redis(`review:settings:{repositoryId}:{prNumber}:{headSha}`, TTL 2시간)로 넘긴다. 이벤트 스키마(`pr.review.requested`/`completed`)는 바뀌지 않는다.
