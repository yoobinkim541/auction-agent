/**
 * 발품-절감 리포트 — 원격 분석으로 끝낸 것 vs 현장에 남은 것을 가른다.
 * 모든 분석을 종합해 '이 매물은 가서 이것만 확인하세요' 맞춤 임장 체크리스트를 생성.
 */
import type {
  FieldworkReport, RightsAnalysisResult, LocationAnalysis, Listing,
} from '../../shared/types.ts';

export function buildFieldwork(rights: RightsAnalysisResult, loc: LocationAnalysis, listing: Listing): FieldworkReport {
  // 원격으로 끝낸 분석 현황
  const remoteDone: { label: string; ok: boolean }[] = [
    { label: '권리분석(말소기준·인수·임차인)', ok: true },
    { label: '시세·안전마진', ok: loc.marketPrice != null },
    { label: '총취득비용·진짜 안전마진', ok: !!loc.acquisitionCost },
    { label: '임대수익·출구(세후)', ok: !!loc.income },
    { label: '명도 난이도·인도명령', ok: !!loc.eviction },
    { label: '법령 리스크 평가', ok: !!loc.report?.legalRisk },
    { label: '토지규제·입지(역세권)', ok: (loc.landUseFlags?.length ?? 0) > 0 || !!loc.transit?.nearestStation },
  ];

  // 현장 필수 체크리스트 (이 매물 특이사항 기반)
  const field: { label: string; why: string }[] = [];
  field.push({ label: '내부 상태(누수·곰팡이·결로·균열·새시)', why: '원격(로드뷰·사진)으로 확인 불가 — 명도 후 또는 외부에서라도 확인' });
  field.push({ label: '실제 채광·향·전망', why: '계산상 향만 추정 — 오후 시간대 실제 일조·앞 동 가림 확인' });
  field.push({ label: '도보 접근(언덕·골목·주차)', why: '직선거리·로드뷰만으로는 체감 난이도 불명' });
  if (listing.isCollectiveBuilding) field.push({ label: '관리사무소 미납 관리비', why: '공용부분 미납 관리비는 낙찰자 승계 — 금액 직접 조회' });
  const ev = loc.eviction;
  if (ev && (ev.difficulty !== 'easy' || ev.occupantLabel.includes('미상'))) {
    field.push({ label: '점유자 실거주·협상 태도', why: `${ev.occupantLabel} — 명도 난이도 ${ev.difficulty}. 우편함·계량기·이웃 탐문으로 거주 확인` });
  }
  for (const f of loc.landUseFlags ?? []) {
    if (f.kind === 'risk') field.push({ label: `${f.label} 현장 영향`, why: f.impact ?? '규제의 실제 영향 현장 확인' });
  }
  const noteText = (loc.report?.checklist ?? []).map((c) => c.label).join(' ');
  if (/위반건축물/.test(noteText)) field.push({ label: '위반건축물(옥탑·확장) 현황', why: '건축물대장 위반 표기 — 원상복구·이행강제금 대상 현장 확인' });
  if (listing.areaM2 && listing.areaM2 < 40 && /빌라|다세대/.test(listing.address + (listing.propertyType ?? ''))) {
    field.push({ label: '반지하·저층 침수·습기', why: '소형 빌라 저층 침수 이력은 데이터로 불명 — 현장·이웃 확인' });
  }
  field.push({ label: '주변 야간 소음·치안·분위기', why: 'POI 거리만으로는 야간 체감 불가 — 시간대별 방문 권장' });

  // 발품 절감 추정: 원격 완료 항목 / (원격완료 + 현장항목)
  const okCount = remoteDone.filter((r) => r.ok).length;
  const legworkSavedPct = Math.round((okCount / (okCount + field.length)) * 100);

  return { remoteDone, fieldChecklist: field, legworkSavedPct };
}
