# Commit Conventions

## Commit Message Format

`type :: description`

- **Types**: `add` / `update` / `fix` / `delete` / `docs` / `test` / `merge` / `init` (English)
- **Description**: Korean, no period, use noun-ending style
  - Forbidden endings: `~한다/~된다`, `~하기`, `~합니다/~됩니다`, `~했습니다`
  - Good examples: `엔티티 필드 추가`, `트랜잭션 롤백 방지`, `로직 개선`
- Subject line only (no body)
- Do NOT add AI as co-author

## Examples

```
add :: 팀 목록 조회 API 추가
update :: 좌석 조회 쿼리 최적화
fix :: 로그인 인증 버그 수정
delete :: 미사용 유틸 함수 제거
docs :: API 문서 업데이트
test :: 인증 모듈 단위 테스트 추가
merge :: develop 브랜치 병합
init :: 프로젝트 초기 설정
```
