/** 표시용 라벨 맵 — App.tsx에서 추출(여러 컴포넌트 공유). */
export const FLAG_LABEL: Record<string, string> = {
  yuchigwon: '유치권', beopjeong_jisangwon: '법정지상권', bunmyo_gijigwon: '분묘기지권',
  daejigwon_mideungi: '대지권미등기', toji_byeoldo_deungi: '토지별도등기',
  jesioe_building: '제시외건물', nongchi: '농취증', senior_tenant: '대항력임차인',
  senior_gadeungi: '선순위가등기', cheolgeo_gacheobun: '건물철거가처분',
};
export const TYPE_LABEL: Record<string, string> = {
  apartment: '아파트', villa: '다세대·연립', officetel: '오피스텔',
  house: '단독·다가구', land: '토지', commercial: '상가', other: '기타',
};
export const RISK: Record<string, { label: string; cls: string }> = {
  clean: { label: '깨끗', cls: 'risk-clean' },
  caution: { label: '주의', cls: 'risk-caution' },
  risky: { label: '위험', cls: 'risk-risky' },
  review_required: { label: '검토필요', cls: 'risk-review' },
};
/** 종합 권고(consider/caution/avoid) 표시 라벨. */
export const RECO: Record<string, { label: string; cls: string }> = {
  consider: { label: '검토 권장', cls: 'reco-consider' },
  caution: { label: '주의 검토', cls: 'reco-caution' },
  avoid: { label: '신중·회피', cls: 'reco-avoid' },
};
