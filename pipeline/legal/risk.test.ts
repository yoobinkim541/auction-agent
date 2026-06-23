import { describe, it, expect } from 'vitest';
import { lookup } from './risk.ts';
import { LEGAL_MAP } from './legal-map.ts';
import type { PreBidItem } from '../../shared/types.ts';

const item = (id: string, label = ''): PreBidItem =>
  ({ id, label, category: '등기인수', severity: 'danger', detail: '', source: '', verify: '' });

describe('legal lookup — KIND_TO_LEGAL (#7 회귀 방지)', () => {
  it('assumed 보전가등기/철거가처분 → 전용 rf- 법령(이전엔 KIND_KO 누락으로 미연결)', () => {
    expect(lookup(item('assumed-bowjeon_gadeungi-2023.01.01'))).toBe(LEGAL_MAP['rf-senior_gadeungi']);
    expect(lookup(item('assumed-cheolgeo_gacheobun-2022.05.01'))).toBe(LEGAL_MAP['rf-cheolgeo_gacheobun']);
  });
  it('assumed 전세권/임차권 → assumed-한글 엔트리', () => {
    expect(lookup(item('assumed-jeonse-2020.01.01'))).toBe(LEGAL_MAP['assumed-전세권']);
    expect(lookup(item('assumed-imchagwon-2020.01.01'))).toBe(LEGAL_MAP['assumed-임차권']);
  });
  it('직접 id(rf-) 우선 매칭', () => {
    expect(lookup(item('rf-senior_gadeungi'))).toBe(LEGAL_MAP['rf-senior_gadeungi']);
  });
  it('매핑 없는 종류/id → undefined', () => {
    expect(lookup(item('assumed-soyugwon-2020.01.01'))).toBeUndefined();
    expect(lookup(item('totally-unknown'))).toBeUndefined();
  });
  it('luf- 라벨 퍼지 매칭', () => {
    expect(lookup(item('luf-과밀억제권역(법인 중과)', '과밀억제권역(법인 중과)'))).toBe(LEGAL_MAP['luf-과밀억제권역']);
  });
});
