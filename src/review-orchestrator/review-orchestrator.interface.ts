import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

export const REVIEW_ORCHESTRATOR = 'REVIEW_ORCHESTRATOR';

export interface ReviewOrchestrator {
  // 결과가 오래되어(PR이 닫힘/새 커밋으로 대체됨) 게시하지 않았으면 'stale'을 돌려준다.
  // 호출부는 이때 "처리 완료"로 표시하면 안 된다 — 같은 커밋으로 PR이 다시 열렸을 때
  // 리뷰가 영영 안 돌게 된다.
  handle(
    payload: ReviewCompletedPayload | ReviewFailedPayload,
  ): Promise<'stale' | undefined>;
}
