import { describe, expect, it } from 'vitest';
import { FLAG_LABEL, KIND_LABEL, RECO, RISK, TYPE_LABEL } from './labels.ts';
import { kindLabel } from '../../pipeline/rights/engine.ts';
import type { RightKind } from '../../shared/types.ts';

const ALL_RIGHT_KINDS: RightKind[] = [
  'geunjeodang',
  'jeodang',
  'apryu',
  'gaapryu',
  'dambo_gadeungi',
  'gyeongmae_gaesi',
  'jeonse',
  'bowjeon_gadeungi',
  'imchagwon',
  'jisangwon',
  'jiyeokgwon',
  'hwanmae',
  'gacheobun',
  'cheolgeo_gacheobun',
  'sintak',
  'soyugwon',
  'other',
];

describe('web/src/labels', () => {
  it('KIND_LABEL이 모든 RightKind에 대해 정의되어 있고 pipeline의 kindLabel과 일치한다', () => {
    for (const kind of ALL_RIGHT_KINDS) {
      expect(KIND_LABEL[kind]).toBeDefined();
      expect(KIND_LABEL[kind]).toBe(kindLabel(kind));
    }
  });

  it('FLAG_LABEL이 모든 주요 레드플래그 종류를 한글로 매핑한다', () => {
    expect(FLAG_LABEL.yuchigwon).toBe('유치권');
    expect(FLAG_LABEL.beopjeong_jisangwon).toBe('법정지상권');
    expect(FLAG_LABEL.senior_tenant).toBe('대항력임차인');
    expect(FLAG_LABEL.daejigwon_mideungi).toBe('대지권미등기');
    expect(FLAG_LABEL.toji_byeoldo_deungi).toBe('토지별도등기');
  });

  it('TYPE_LABEL이 부동산 유형을 한글로 매핑한다', () => {
    expect(TYPE_LABEL.apartment).toBe('아파트');
    expect(TYPE_LABEL.villa).toBe('다세대·연립');
    expect(TYPE_LABEL.officetel).toBe('오피스텔');
    expect(TYPE_LABEL.house).toBe('단독·다가구');
  });

  it('RISK 및 RECO 상태 라벨과 CSS 클래스가 유효하다', () => {
    expect(RISK.clean.label).toBe('깨끗');
    expect(RISK.risky.label).toBe('위험');
    expect(RECO.consider.label).toBe('검토 권장');
    expect(RECO.caution.label).toBe('주의 검토');
    expect(RECO.avoid.label).toBe('신중·회피');
  });
});
