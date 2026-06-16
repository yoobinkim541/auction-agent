/**
 * 클라이언트 측 점수/통과 재계산 — 슬라이더로 기준을 바꾸면 서버 재실행 없이 즉시 재정렬.
 * 서버 pipeline/select/score.ts 로직과 동일하게 유지.
 */
import type { ListingItem } from './api.ts';

export interface ScoreConfig {
  wSafety: number;       // 안전마진 가중치 (0~1)
  wClean: number;        // 권리 깨끗 가중치 (0~1)
  safetyMaxAt: number;   // 안전마진 만점 기준 (예 0.4 = 40%)
  minSafetyMargin: number; // 통과 최소 안전마진 (예 0.1)
  requireCleanRights: boolean; // 인수금액 0만 통과
  includeReviewRequired: boolean; // 검토필요도 통과에 포함
  allowedTypes: string[];
  regionKeywords: string[];
  priceMinEok: number; // 최저매각가 하한(억), 0=무제한
  priceMaxEok: number; // 최저매각가 상한(억), 0=무제한
  apprMinEok: number; // 감정가 하한(억), 0=무제한
  apprMaxEok: number; // 감정가 상한(억), 0=무제한
}

export const DEFAULT_CONFIG: ScoreConfig = {
  wSafety: 0.5,
  wClean: 0.5,
  safetyMaxAt: 0.4,
  minSafetyMargin: 0.1,
  requireCleanRights: true,
  includeReviewRequired: false,
  allowedTypes: ['apartment', 'villa', 'officetel'],
  regionKeywords: ['서울', '경기', '인천'],
  priceMinEok: 0,
  priceMaxEok: 0,
  apprMinEok: 0,
  apprMaxEok: 0,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const RISK_SCORE: Record<string, number> = { clean: 100, caution: 65, risky: 25, review_required: 0 };

export interface ClientScore {
  totalScore: number;
  safetyScore: number;
  cleanScore: number;
  passed: boolean;
  reasons: string[];
}

export function scoreClient(item: ListingItem, cfg: ScoreConfig): ClientScore {
  const margin = item.location?.safety_margin ?? null;
  const safetyScore = margin == null ? 0 : Math.round(clamp(margin / cfg.safetyMaxAt, 0, 1) * 100);

  const grade = item.rights?.risk_grade ?? '';
  let cleanScore = RISK_SCORE[grade] ?? 0;
  const assumed = item.rights?.assumed_amount ?? 0;
  if (assumed > 0) cleanScore = Math.min(cleanScore, 20);

  const wSum = cfg.wSafety + cfg.wClean || 1;
  const zeroPiBonus = (item.location?.income?.zeroPiCandidate && !item.location?.income?.estimated) ? 5 : 0;
  const totalScore = Math.min(100, Math.round((cfg.wSafety * safetyScore + cfg.wClean * cleanScore) / wSum) + zeroPiBonus);

  const reasons: string[] = [];
  let passed = true;
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(item.property_type)) { passed = false; reasons.push('물건종류 제외'); }
  if (cfg.regionKeywords.length && !cfg.regionKeywords.some((k) => item.address.includes(k))) { passed = false; reasons.push('관심지역 외'); }
  const minBid = item.min_bid_price ?? 0;
  if (cfg.priceMinEok > 0 && minBid < cfg.priceMinEok * 1e8) { passed = false; reasons.push(`최저가 ${(minBid / 1e8).toFixed(1)}억<${cfg.priceMinEok}억`); }
  if (cfg.priceMaxEok > 0 && minBid > cfg.priceMaxEok * 1e8) { passed = false; reasons.push(`최저가 ${(minBid / 1e8).toFixed(1)}억>${cfg.priceMaxEok}억`); }
  const appr = item.appraisal_value ?? 0;
  if (cfg.apprMinEok > 0 && appr < cfg.apprMinEok * 1e8) { passed = false; reasons.push(`감정가<${cfg.apprMinEok}억`); }
  if (cfg.apprMaxEok > 0 && appr > cfg.apprMaxEok * 1e8) { passed = false; reasons.push(`감정가>${cfg.apprMaxEok}억`); }
  if (cfg.requireCleanRights && assumed > 0) { passed = false; reasons.push(`인수금액 ${(assumed / 1e8).toFixed(1)}억`); }
  if (grade === 'review_required' && !cfg.includeReviewRequired) { passed = false; reasons.push('검토필요(특수권리)'); }
  if (margin != null && margin < cfg.minSafetyMargin) { passed = false; reasons.push(`안전마진 ${(margin * 100).toFixed(0)}%<${(cfg.minSafetyMargin * 100).toFixed(0)}%`); }
  if (margin == null) reasons.push('시세 미확보');

  return { totalScore, safetyScore, cleanScore, passed, reasons };
}
