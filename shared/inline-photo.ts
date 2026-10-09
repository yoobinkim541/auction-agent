// 법원 상세는 사진을 접두사 없는 base64로 주기도 한다. 매직 바이트의 base64 표기로 형식을 판별한다.
const INLINE_PHOTO_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['iVBORw0KGgo', 'image/png'],
  ['UklGR', 'image/webp'],
];
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

/** URL로 보이지 않는 긴 base64 덩어리인지 — 사이트 경로로 붙여 요청하면 매번 타임아웃까지 기다린다. */
export function isBase64Blob(raw: string, minLength = 80): boolean {
  const compact = raw.replace(/\s+/g, '');
  return compact.length >= minLength && BASE64_RE.test(compact);
}

/** 알려진 이미지 형식의 base64면 data URL로, 아니면 null. */
export function inlinePhotoDataUrl(raw: string, minLength = 80): string | null {
  const compact = raw.replace(/\s+/g, '');
  if (!isBase64Blob(compact, minLength)) return null;
  const match = INLINE_PHOTO_PREFIXES.find(([prefix]) => compact.startsWith(prefix));
  return match ? `data:${match[1]};base64,${compact}` : null;
}

const HOST_PREFIXED_BLOB_RE = /^https?:\/\/[^/]+\/([A-Za-z0-9+/=]{16,})$/;

/**
 * 과거 크롤이 base64 사진을 사이트 경로로 붙여 저장한 주소(https://host/R0lGOD...)를 복구한다.
 * 알려진 형식이면 data URL, 형식을 모르는 base64 덩어리면 null(요청하지 않음), 그 외 주소는 그대로.
 */
export function repairStoredPhotoSource(sourceUrl: string): string | null {
  const blob = sourceUrl.match(HOST_PREFIXED_BLOB_RE)?.[1];
  if (!blob) return sourceUrl;
  const dataUrl = inlinePhotoDataUrl(blob, 16);
  if (dataUrl) return dataUrl;
  return isBase64Blob(blob) ? null : sourceUrl;
}
