import type { SaleResultRound } from '../crawler/adapters/courtauction.ts';
import { normalizeCaseNo } from '../crawler/normalize.ts';

export interface RetryCounters {
  processed: number;
  success: number;
  empty: number;
  blocked: number;
  error: number;
  skipped: number;
}

export type RetryStatus = 'success' | 'empty';

export function toCourtCaseNo(caseNo: string): string {
  const normalized = normalizeCaseNo(caseNo);
  const match = normalized.match(/^(20\d\d)-(\d+)$/);
  return match ? `${match[1]}타경${match[2]}` : normalized;
}

export function toCourtItemNo(itemNo: string | null | undefined): string {
  const n = parseInt(String(itemNo ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '1';
}

export function statusFromRounds(rounds: SaleResultRound[]): RetryStatus {
  return rounds.length > 0 ? 'success' : 'empty';
}

export function emptyRetryCounters(): RetryCounters {
  return { processed: 0, success: 0, empty: 0, blocked: 0, error: 0, skipped: 0 };
}
