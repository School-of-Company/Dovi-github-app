import {
  computeFindingFingerprint,
  fingerprintMarker,
} from './finding-fingerprint';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';

type Finding = ReviewCompletedPayload['reviews'][number];

export type FormattedReviewComment = {
  path: string;
  line: number;
  body: string;
  findingIndex: number;
  // 재리뷰 때 이미 게시한 지적을 알아보는 지문. body 끝에 같은 값이 마커로 들어 있다.
  fingerprint: string;
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

// 지적 위치를 짧게 표시하기 위한 링크 기준. 주어지면 파일명:줄을 해당 커밋의 그 줄로 가는
// 링크로 만든다.
export interface FileLinkBase {
  owner: string;
  repo: string;
  sha: string;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// 긴 전체 경로(src/main/java/.../Foo.java) 대신 파일명만 보여 주고, 클릭하면 그 줄로
// 이동하게 한다. 같은 파일명이 여럿이면(예: index.ts) 구분되도록 상위 디렉터리 한 단계를 붙인다.
function describeLocation(
  { path, line }: { path: string; line: number },
  duplicateNames: Set<string>,
  link?: FileLinkBase,
): string {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  const label =
    duplicateNames.has(name) && segments.length > 1
      ? segments.slice(-2).join('/')
      : name;
  const text = `\`${label}:${line}\``;
  if (!link) return text;
  const url = `https://github.com/${link.owner}/${link.repo}/blob/${link.sha}/${encodePath(path)}#L${line}`;
  return `[${text}](${url})`;
}

// AI가 diff 범위 밖의 줄을 가리켜 인라인 코멘트로 달 수 없었던 finding(GitHub 422)을
// 리뷰 본문 끝에 모아 붙인다. finding 하나가 거부당해도 리뷰 전체를 잃지 않고
// 지적 내용이 사용자에게 전달되도록 하기 위함이다.
export function appendUnanchoredFindings(
  body: string,
  findings: Pick<FormattedReviewComment, 'path' | 'line' | 'body'>[],
  link?: FileLinkBase,
): string {
  if (findings.length === 0) return body;

  const shown = findings.slice(0, MAX_UNANCHORED_FINDINGS);
  const omitted = findings.length - shown.length;

  // 서로 다른 경로인데 파일명이 같은 것만 구분이 필요하다.
  const pathsByName = new Map<string, Set<string>>();
  for (const { path } of shown) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    pathsByName.set(name, (pathsByName.get(name) ?? new Set()).add(path));
  }
  const duplicateNames = new Set(
    [...pathsByName].filter(([, paths]) => paths.size > 1).map(([n]) => n),
  );

  const items = shown
    .map((finding) => {
      return `#### ${describeLocation(finding, duplicateNames, link)}\n\n${finding.body}`;
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
    .map(({ review, findingIndex }) => {
      const fingerprint = computeFindingFingerprint(review);
      return {
        path: review.filePath,
        line: review.line,
        body: `${formatCommentBody(review)}\n\n${fingerprintMarker(fingerprint)}`,
        findingIndex,
        fingerprint,
      };
    });
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
