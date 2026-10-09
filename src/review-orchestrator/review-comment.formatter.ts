import {
  computeFindingFingerprint,
  fingerprintMarker,
} from './finding-fingerprint';
import type { UnreviewedFile } from '../pr-data-collector/dto/unreviewed-file';
import type { ReviewCompletedPayload } from './dto/review-completed.payload';

type Finding = ReviewCompletedPayload['reviews'][number];

export type FormattedReviewComment = {
  path: string;
  line: number;
  body: string;
  findingIndex: number;
  // 재리뷰 때 이미 게시한 지적을 알아보는 지문. body 끝에 같은 값이 마커로 들어 있다.
  fingerprint: string;
  // 레포 설정(minSeverity, maxInlineComments)을 적용할 때 쓴다.
  severity: Finding['severity'];
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

interface FindingsSection {
  heading: string;
  intro: string;
}

const UNANCHORED_SECTION: FindingsSection = {
  heading: '위치를 특정할 수 없는 지적사항',
  intro:
    'diff에서 정확한 줄을 찾지 못해 인라인으로 달지 못했습니다. 줄 번호가 다를 수 있습니다.',
};

// 레포 설정 maxInlineComments로 인라인에 달지 못하고 본문에 모은 지적의 섹션.
export function inlineLimitSection(limit: number): FindingsSection {
  return {
    heading: '인라인 코멘트 상한을 넘은 지적사항',
    intro: `이 레포의 설정(maxInlineComments: ${limit})에 따라 인라인 코멘트는 ${limit}개까지만 달고, 나머지는 심각도가 낮은 순으로 여기에 모았습니다.`,
  };
}

// AI가 diff 범위 밖의 줄을 가리켜 인라인 코멘트로 달 수 없었던 finding(GitHub 422)을
// 리뷰 본문 끝에 모아 붙인다. finding 하나가 거부당해도 리뷰 전체를 잃지 않고
// 지적 내용이 사용자에게 전달되도록 하기 위함이다.
export function appendUnanchoredFindings(
  body: string,
  findings: Pick<FormattedReviewComment, 'path' | 'line' | 'body'>[],
  link?: FileLinkBase,
  section: FindingsSection = UNANCHORED_SECTION,
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
    `${body}\n\n---\n\n### ${section.heading}\n\n` +
    `${section.intro}\n\n${items}${omittedNote}`;

  return appended.length > REVIEW_BODY_MAX_CHARS
    ? `${appended.slice(0, REVIEW_BODY_MAX_CHARS)}\n\n…(길이 제한으로 일부 생략)`
    : appended;
}

const MAX_UNREVIEWED_FILES = 10;
const UNREVIEWED_REASON_LABEL: Record<UnreviewedFile['reason'], string> = {
  'patch-budget': '변경 내용이 너무 많아 전송 크기 상한을 넘음',
  'no-patch': 'GitHub가 변경 내용(diff)을 제공하지 않음(매우 큰 파일)',
};

// 도비가 AI 서버로 보내지 못한 파일을 리뷰 본문 끝에 알린다. 안내가 없으면 큰 PR에서 일부
// 파일이 빠져도 "리뷰를 통과했다"고 오해하기 쉽다. 제외가 없으면 본문을 그대로 돌려준다.
//
// 이 목록은 도비가 아는 범위(전송 크기 상한, diff 없음)만이다. AI 서버가 프롬프트 크기 때문에
// 자체적으로 생략하는 파일은 AI 서버만 알아서 여기에 없다.
export function appendUnreviewedFiles(
  body: string,
  files: UnreviewedFile[],
): string {
  if (files.length === 0) return body;

  const shown = files.slice(0, MAX_UNREVIEWED_FILES);
  const omitted = files.length - shown.length;
  const items = shown
    .map(
      ({ filePath, reason }) =>
        `- \`${filePath}\` — ${UNREVIEWED_REASON_LABEL[reason] ?? '알 수 없는 사유'}`,
    )
    .join('\n');
  const omittedNote = omitted > 0 ? `\n- 외 ${omitted}건` : '';

  return (
    `${body}\n\n---\n\n### 리뷰하지 못한 파일\n\n` +
    `아래 파일은 크기 제한 때문에 리뷰 대상에서 빠졌습니다. 이 파일들의 변경은 검토되지 않았으니 직접 확인해 주세요.\n\n${items}${omittedNote}`
  );
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
        severity: review.severity,
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
