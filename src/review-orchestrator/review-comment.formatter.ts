import type { ReviewCompletedPayload } from './dto/review-completed.payload';

type Finding = ReviewCompletedPayload['reviews'][number];

// findingIndex는 원본 payload.reviews 배열 내 인덱스를 그대로 보존한다 —
// review-orchestrator가 생성된 GitHub 코멘트 id를 이 인덱스로 역매핑해 저장한다
// (리뷰 반영 여부 이벤트의 findingIndex로 쓰기 위함). GitHub API로는 전송하지 않는다.
export function buildReviewComments(
  reviews: ReviewCompletedPayload['reviews'],
): { path: string; line: number; body: string; findingIndex: number }[] {
  if (!Array.isArray(reviews)) {
    return [];
  }
  return reviews
    .map((review, findingIndex) => ({ review, findingIndex }))
    .filter(
      ({ review }) =>
        review &&
        typeof review.filePath === 'string' &&
        review.filePath.trim() !== '' &&
        typeof review.line === 'number' &&
        review.line > 0,
    )
    .map(({ review, findingIndex }) => ({
      path: review.filePath,
      line: review.line,
      body: formatCommentBody(review),
      findingIndex,
    }));
}

function formatCommentBody(review: Finding): string {
  const confidence =
    typeof review.confidence === 'number'
      ? Math.round(review.confidence * 100)
      : 0;
  const header = `**[${review.severity}] ${review.title}** (신뢰도: ${confidence}%)`;
  const evidenceList = Array.isArray(review.evidence) ? review.evidence : [];
  const evidence = evidenceList.length
    ? `\n\n\`\`\`diff\n${evidenceList.join('\n')}\n\`\`\``
    : '';

  const fix = review.suggestedFix ? `\n\n제안: ${review.suggestedFix}` : '';
  return `${header}\n\n${review.message}${evidence}${fix}`;
}
