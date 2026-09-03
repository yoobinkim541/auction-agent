import { describe, expect, it } from 'vitest';
import { diffFavorite, formatWatch, type FavSnapshot } from './watch-format.ts';

const snap = (over: Partial<FavSnapshot> = {}): FavSnapshot => ({
  case_no: '2024타경14666', address: '인천광역시 미추홀구 매소홀로 262',
  sale_date: '2026-07-22', min_bid_price: 4_9000_0000, fail_count: 3, sold: false, ...over,
});

describe('diffFavorite', () => {
  it('변화 없으면 빈 배열', () => {
    expect(diffFavorite(snap(), snap())).toEqual([]);
  });
  it('유찰(회차 증가) + 기일 변경 + 최저가 하락을 모두 잡는다', () => {
    const lines = diffFavorite(snap(), snap({ fail_count: 4, sale_date: '2026-08-26', min_bid_price: 3_4300_0000 }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('유찰 발생 (3→4회)');
    expect(lines[1]).toContain('기일 변경 2026-07-22 → 2026-08-26');
    expect(lines[2]).toContain('▼30%');
  });
  it('매각되면 매각 라인만(이후 변동 무의미)', () => {
    const lines = diffFavorite(snap(), snap({ sold: true, sale_date: '2026-09-01' }));
    expect(lines).toEqual(['🎉 매각됨 — 낙찰 결과 확인']);
  });
  it('이미 매각 상태면 반복 알림 없음', () => {
    expect(diffFavorite(snap({ sold: true }), snap({ sold: true }))).toEqual([]);
  });
});

describe('formatWatch', () => {
  it('변동 블록 없으면 빈 문자열(발송 생략)', () => {
    expect(formatWatch([])).toBe('');
    expect(formatWatch([{ caseNo: 'a', itemNo: '1', address: 'b', lines: [] }])).toBe('');
  });
  it('블록·딥링크 포함 텍스트', () => {
    const s = formatWatch(
      [{ caseNo: '2024타경14666', itemNo: '3', address: '인천광역시 미추홀구 매소홀로 262', lines: ['유찰 발생 (3→4회)'] }],
      'https://dash.example/',
    );
    expect(s).toContain('🔔 관심물건 변동 1건');
    expect(s).toContain('★2024타경14666');
    expect(s).toContain('https://dash.example/#case=2024%ED%83%80%EA%B2%BD14666&item=3');
  });
});
