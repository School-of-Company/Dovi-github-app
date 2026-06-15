# Branch Naming Guide

## Format

`<type>/<kebab-case-description>`

- Use the same `type` as the planned commit message
- Reflect the domain or feature scope in the description
- Use kebab-case (lowercase, hyphen-separated)

## Examples

| Branch name                  | Commit it targets                 |
| ---------------------------- | --------------------------------- |
| `add/team-list-api`          | `add :: 팀 목록 조회 API 추가`    |
| `fix/auth-login-bug`         | `fix :: 로그인 인증 버그 수정`    |
| `update/seat-query-optimize` | `update :: 좌석 조회 쿼리 최적화` |
| `delete/unused-util`         | `delete :: 미사용 유틸 함수 제거` |
| `docs/api-readme`            | `docs :: API 문서 업데이트`       |

## Rules

- Always branch off from `develop`
- Merge back into `develop` via PR
- One feature/fix per branch
