/** 표시용 라벨 맵 — App.tsx에서 추출(여러 컴포넌트 공유). */

/** 등기 권리종류(RightKind enum) → 한글 표시. pipeline/rights/engine.ts kindLabel()과 동기화 유지. */
export const KIND_LABEL: Record<string, string> = {
  geunjeodang: '근저당권', jeodang: '저당권', apryu: '압류', gaapryu: '가압류',
  dambo_gadeungi: '담보가등기', gyeongmae_gaesi: '경매개시결정등기', jeonse: '전세권',
  bowjeon_gadeungi: '소유권이전청구권가등기', imchagwon: '주택임차권', jisangwon: '지상권',
  jiyeokgwon: '지역권', hwanmae: '환매특약', gacheobun: '가처분',
  cheolgeo_gacheobun: '건물철거가처분', sintak: '신탁', soyugwon: '소유권', other: '기타',
};

/** 주변 편의시설 키(pipeline/location/index.ts amenities) → 한글 표시. OSM 경로는 이미 한글 키. */
export const AMENITY_LABEL: Record<string, string> = {
  mart: '마트', convenience: '편의점', hospital: '병원', pharmacy: '약국', cafe: '카페',
};

/** 복기 입력 커버리지의 스냅샷 컬럼명(ListingService.mlReview) → 한글 표시. */
export const FEATURE_LABEL: Record<string, string> = {
  appraisal_value: '감정가', min_bid_price: '최저가', market_price: '시세', expected_bid: '예상 낙찰가',
  max_safe_bid: '안전 입찰 상한', true_margin: '진짜마진', total_score: '점수', inq_cnt: '조회 수', interest_cnt: '관심 등록 수',
};

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
