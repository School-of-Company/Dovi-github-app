import { matchesGlob } from './glob';

export type Severity = 'critical' | 'major' | 'minor' | 'suggestion';

export interface ReviewSettings {
  /** 게시할 최소 심각도. 없으면 전부 게시. */
  minSeverity?: Severity;
  /** 한 PR의 인라인 코멘트 상한. 없으면 제한 없음. */
  maxInlineComments?: number;
  /** 리뷰 대상 glob. 없으면 전체. */
  include: string[];
  /** 리뷰 제외 glob. */
  exclude: string[];
  /** 재리뷰 때 마지막으로 리뷰한 커밋 이후 바뀐 파일만 리뷰한다. 없으면 매번 전체 리뷰. */
  incrementalReview?: boolean;
}

export interface ParsedReviewSettings {
  settings: ReviewSettings;
  /** 무시한 값에 대한 경고(호출부가 로그로 남긴다). 설정 문서를 쓴 사람이 오타를 알 수 있게 한다. */
  warnings: string[];
}

// 게시 단계(ReviewOrchestrator)가 쓰는 설정만. include/exclude는 수집 단계에서 이미 적용된다.
export interface PublishSettings {
  minSeverity?: Severity;
  maxInlineComments?: number;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  include: [],
  exclude: [],
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  suggestion: 0,
};
const MAX_INLINE_LIMIT = 100;
const MAX_GLOBS = 50;
const MAX_GLOB_LENGTH = 200;

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as Severity] ?? 0;
}

export function meetsMinSeverity(severity: string, min: Severity): boolean {
  return severityRank(severity) >= SEVERITY_RANK[min];
}

function parseSeverity(value: string): Severity | undefined {
  const normalized = value.trim().toLowerCase();
  // 이슈/문서에서 가장 낮은 단계를 nit이라고 부르므로 별칭으로 받는다.
  if (normalized === 'nit') return 'suggestion';
  return normalized in SEVERITY_RANK ? (normalized as Severity) : undefined;
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (['true', 'on', 'enabled', 'yes'].includes(normalized)) return true;
  if (['false', 'off', 'disabled', 'no'].includes(normalized)) return false;
  return undefined;
}

function parseGlobs(key: string, value: string, warnings: string[]): string[] {
  const globs: string[] = [];
  for (const raw of value.split(',')) {
    const glob = raw.trim();
    if (glob === '') continue;
    if (glob.length > MAX_GLOB_LENGTH) {
      warnings.push(`${key}: ${MAX_GLOB_LENGTH}자를 넘는 패턴은 무시했습니다`);
      continue;
    }
    if (globs.length >= MAX_GLOBS) {
      warnings.push(`${key}: 패턴은 최대 ${MAX_GLOBS}개까지만 사용합니다`);
      break;
    }
    globs.push(glob);
  }
  return globs;
}

// DOVI.md의 `## Review Settings` 섹션에서 `키: 값` 줄을 읽는다.
//
//   ## Review Settings
//   minSeverity: major
//   maxInlineComments: 10
//   include: src/**, lib/**
//   exclude: **/*.generated.ts, docs/**
//
// 설정이 없거나 값이 잘못됐으면 그 항목만 기본값(= 제한 없음)으로 두고 경고를 남긴다.
// 설정이 없는 레포는 동작이 바뀌지 않는다.
export function parseReviewSettings(markdown: string): ParsedReviewSettings {
  const settings: ReviewSettings = { include: [], exclude: [] };
  const warnings: string[] = [];

  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex((line) =>
    /^#+\s*review settings\s*$/i.test(line.trim()),
  );
  if (headerIndex === -1) return { settings, warnings };

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) break;
    // `- key: value` 형태의 목록도 허용한다.
    const entry = trimmed.replace(/^[-*]\s+/, '');
    if (entry === '') continue;

    const separator = entry.indexOf(':');
    if (separator === -1) {
      warnings.push(
        `'${entry.slice(0, 40)}' 줄은 '키: 값' 형식이 아니라 무시했습니다`,
      );
      continue;
    }
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();

    switch (key) {
      case 'minseverity': {
        const severity = parseSeverity(value);
        if (severity === undefined) {
          warnings.push(
            `minSeverity '${value}'은(는) critical/major/minor/nit 중 하나여야 해서 무시했습니다`,
          );
        } else {
          settings.minSeverity = severity;
        }
        break;
      }
      case 'maxinlinecomments': {
        const limit = Number(value);
        if (!/^\d+$/.test(value) || limit < 1 || limit > MAX_INLINE_LIMIT) {
          warnings.push(
            `maxInlineComments '${value}'은(는) 1~${MAX_INLINE_LIMIT} 사이 정수여야 해서 무시했습니다`,
          );
        } else {
          settings.maxInlineComments = limit;
        }
        break;
      }
      case 'incrementalreview': {
        const flag = parseBoolean(value);
        if (flag === undefined) {
          warnings.push(
            `incrementalReview '${value}'은(는) true/false 중 하나여야 해서 무시했습니다`,
          );
        } else {
          settings.incrementalReview = flag;
        }
        break;
      }
      case 'include':
        settings.include = parseGlobs('include', value, warnings);
        break;
      case 'exclude':
        settings.exclude = parseGlobs('exclude', value, warnings);
        break;
      default:
        warnings.push(`알 수 없는 설정 '${key}'은(는) 무시했습니다`);
    }
  }
  return { settings, warnings };
}

// 리뷰 대상 파일인지: include가 있으면 그중 하나에 매치해야 하고, exclude에 매치하면 제외한다.
export function isReviewTarget(
  filePath: string,
  settings: Pick<ReviewSettings, 'include' | 'exclude'>,
): boolean {
  if (
    settings.include.length > 0 &&
    !settings.include.some((glob) => matchesGlob(glob, filePath))
  ) {
    return false;
  }
  return !settings.exclude.some((glob) => matchesGlob(glob, filePath));
}

// 인라인 코멘트를 상한까지만 남기고 나머지는 돌려준다(호출부가 본문에 모은다).
// 상한을 넘으면 심각도가 높은 지적을 우선 남기고, 같은 심각도 안에서는 원래 순서를 유지한다.
// 남긴 코멘트의 순서도 원래 순서를 그대로 둔다.
export function capInlineComments<T extends { severity: string }>(
  comments: T[],
  limit: number | undefined,
): { inline: T[]; overflow: T[] } {
  if (limit === undefined || comments.length <= limit) {
    return { inline: comments, overflow: [] };
  }
  const slots = Math.max(0, limit);
  const keep = new Set(
    comments
      .map((comment, index) => ({ comment, index }))
      .sort(
        (a, b) =>
          severityRank(b.comment.severity) - severityRank(a.comment.severity) ||
          a.index - b.index,
      )
      .slice(0, slots)
      .map(({ index }) => index),
  );
  return {
    inline: comments.filter((_, index) => keep.has(index)),
    overflow: comments.filter((_, index) => !keep.has(index)),
  };
}
