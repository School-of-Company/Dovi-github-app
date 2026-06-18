import type { ReviewCompletedPayload } from './dto/review-completed.payload';

type Finding = ReviewCompletedPayload['reviews'][number];

export function buildReviewComments(
  reviews: ReviewCompletedPayload['reviews'],
): { path: string; line: number; body: string }[] {
  return reviews.map((review) => ({
    path: review.filePath,
    line: review.line,
    body: formatCommentBody(review),
  }));
}

function formatCommentBody(review: Finding): string {
  const header = `**[${review.severity}] ${review.title}** (신뢰도: ${Math.round(review.confidence * 100)}%)`;
  const evidence = review.evidence.length
    ? `\n\n${review.evidence.map((e) => `- ${e}`).join('\n')}`
    : '';

  if (review.severity === 'critical' && review.suggestedFix) {
    return `${header}\n\n${review.message}${evidence}\n\n\`\`\`suggestion\n${review.suggestedFix}\n\`\`\``;
  }

  const fix = review.suggestedFix ? `\n\n제안: ${review.suggestedFix}` : '';
  return `${header}\n\n${review.message}${evidence}${fix}`;
}
