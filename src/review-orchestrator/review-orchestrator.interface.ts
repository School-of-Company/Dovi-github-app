import type { ReviewCompletedPayload } from './dto/review-completed.payload';
import type { ReviewFailedPayload } from './dto/review-failed.payload';

export const REVIEW_ORCHESTRATOR = 'REVIEW_ORCHESTRATOR';

export interface ReviewOrchestrator {
  handle(payload: ReviewCompletedPayload | ReviewFailedPayload): Promise<void>;
}
