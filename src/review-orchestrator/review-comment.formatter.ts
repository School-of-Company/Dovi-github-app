import type { ReviewCompletedPayload } from './dto/review-completed.payload';

type Finding = ReviewCompletedPayload['reviews'][number];

export type FormattedReviewComment = {
  path: string;
  line: number;
  body: string;
  findingIndex: number;
};

// ai-server가 생성한 summary는 헤딩/볼드 없는 평문일 수 있어, gemini-code-assist류
// 리뷰 봇처럼 한눈에 파악 가능하도록 고정 헤더를 씌워 PR 리뷰 본문(top-level)에 사용한다.
export function formatReviewSummary(summary: string): string {
  return `# Code Review\n\n${summary}`;
}

// GitHub 리뷰 body 상한(65,536자)에 여유를 둔 값.
const REVIEW_BODY_MAX_CHARS = 60000;
// 본문에 싣는 위치 불명 지적사항 개수 상한. 넘는 건 "외 N건"으로만 표기한다.
const MAX_UNANCHORED_FINDINGS = 10;

// AI가 diff 범위 밖의 줄을 가리켜 인라인 코멘트로 달 수 없었던 finding(GitHub 422)을
// 리뷰 본문 끝에 모아 붙인다. finding 하나가 거부당해도 리뷰 전체를 잃지 않고
// 지적 내용이 사용자에게 전달되도록 하기 위함이다.
export function appendUnanchoredFindings(
  body: string,
  findings: Pick<FormattedReviewComment, 'path' | 'line' | 'body'>[],
): string {
  if (findings.length === 0) return body;

  const shown = findings.slice(0, MAX_UNANCHORED_FINDINGS);
  const omitted = findings.length - shown.length;

  const items = shown
    .map(({ path, line, body: findingBody }) => {
      return `#### \`${path}:${line}\`\n\n${findingBody}`;
    })
    .join('\n\n---\n\n');
  const omittedNote = omitted > 0 ? `\n\n외 ${omitted}건` : '';
  const appended =
    `${body}\n\n---\n\n### 위치를 특정할 수 없는 지적사항\n\n` +
    `diff에서 정확한 줄을 찾지 못해 인라인으로 달지 못했습니다. 줄 번호가 다를 수 있습니다.\n\n${items}${omittedNote}`;

  return appended.length > REVIEW_BODY_MAX_CHARS
    ? `${appended.slice(0, REVIEW_BODY_MAX_CHARS)}\n\n…(길이 제한으로 일부 생략)`
    : appended;
}

// findingIndex는 원본 payload.reviews 배열 내 인덱스를 그대로 보존한다 —
// review-orchestrator가 생성된 GitHub 코멘트 id를 이 인덱스로 역매핑해 저장한다
// (리뷰 반영 여부 이벤트의 findingIndex로 쓰기 위함). GitHub API로는 전송하지 않는다.
export function buildReviewComments(
  reviews: ReviewCompletedPayload['reviews'],
): FormattedReviewComment[] {
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
        Number.isInteger(review.line) &&
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
