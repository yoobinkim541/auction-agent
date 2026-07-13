import { describe, it, expect } from 'vitest';
import { filterCourts, parseCourtDate, parseMoney, mapUsgCd, rowToScraped, parseCourtDetail, isKnownForIncremental, shouldFetchDetailNow, detailDecision } from './courtauction.ts';

describe('filterCourts', () => {
  it('빈 regions → 수도권 전체(16개) 반환', () => {
    expect(filterCourts([])).toHaveLength(16);
  });
  it('서울 → 서울 법원 5개', () => {
    const res = filterCourts(['서울']);
    expect(res.every((c) => c.name.includes('서울'))).toBe(true);
    expect(res).toHaveLength(5);
  });
  it('인천 → 인천지방법원 1개', () => {
    const res = filterCourts(['인천']);
    expect(res).toHaveLength(1);
    expect(res[0]!.code).toBe('B000240');
  });
  it('경기 → 의정부·남양주·고양·수원·성남·부천·여주·평택·안산·안양 10개 (광역 키워드 확장)', () => {
    const res = filterCourts(['경기']);
    expect(res.map((c) => c.name)).toEqual(
      expect.arrayContaining(['의정부지방법원', '남양주지원', '고양지원', '수원지방법원', '성남지원', '부천지원', '여주지원', '평택지원', '안산지원', '안양지원']),
    );
    expect(res).toHaveLength(10);
  });
  it('남양주 → 남양주지원(B214804) 1개', () => {
    const res = filterCourts(['남양주']);
    expect(res).toHaveLength(1);
    expect(res[0]!.code).toBe('B214804');
  });
  it('DEFAULT_FILTER 서울+경기+인천 → 수도권 16개 전부', () => {
    // 이 조합이 수도권 모든 법원을 커버해야 함 — 회귀 방지
    const res = filterCourts(['서울', '경기', '인천']);
    expect(res).toHaveLength(16);
  });
  it('법원코드 직접 입력', () => {
    const res = filterCourts(['B000210']);
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe('서울중앙지방법원');
  });
  it('매칭 없음 → 빈 배열', () => {
    expect(filterCourts(['부산'])).toHaveLength(0);
  });
  it('반환값 변형이 METRO_COURTS 원본에 영향 없음', () => {
    const r = filterCourts([]);
    r.push({ code: 'ZZZ', name: '테스트법원' });
    expect(filterCourts([])).toHaveLength(16); // 원본 불변
  });
});

describe('parseCourtDate', () => {
  it('YYYYMMDD 8자리 변환', () => {
    expect(parseCourtDate('20260708')).toBe('2026-07-08');
  });
  it('YYYY.MM.DD 변환', () => {
    expect(parseCourtDate('2026.07.08')).toBe('2026-07-08');
  });
  it('한자리 월/일도 처리', () => {
    expect(parseCourtDate('2026.7.8')).toBe('2026-07-08');
  });
  it('undefined/빈값 → undefined', () => {
    expect(parseCourtDate(undefined)).toBeUndefined();
    expect(parseCourtDate('')).toBeUndefined();
  });
  it('불가능한 날짜 → undefined', () => {
    expect(parseCourtDate('20261340')).toBeUndefined(); // 13월 40일
  });
});

describe('parseMoney', () => {
  it('콤마 금액 파싱', () => {
    expect(parseMoney('1,234,567,000')).toBe(1_234_567_000);
  });
  it('콤마 없는 정수', () => {
    expect(parseMoney('530000000')).toBe(530_000_000);
  });
  it('undefined → 0', () => {
    expect(parseMoney(undefined)).toBe(0);
  });
  it('빈 문자열 → 0', () => {
    expect(parseMoney('')).toBe(0);
  });
  it('숫자가 아닌 문자열 → 0', () => {
    expect(parseMoney('없음')).toBe(0);
  });
});

describe('mapUsgCd', () => {
  it('아파트 텍스트', () => {
    // 법원경매 API는 bigo(비고) 필드에 한글 용도명을 포함 — 숫자 코드만으로는 매핑 불가
    expect(mapUsgCd(undefined, '아파트')).toBe('apartment');
    expect(mapUsgCd('22100', '아파트')).toBe('apartment');
  });
  it('오피스텔', () => {
    expect(mapUsgCd(undefined, '오피스텔')).toBe('officetel');
  });
  it('다세대/연립 → villa', () => {
    expect(mapUsgCd(undefined, '다세대주택')).toBe('villa');
    expect(mapUsgCd(undefined, '연립주택')).toBe('villa');
  });
  it('단독주택 → house', () => {
    expect(mapUsgCd(undefined, '단독주택')).toBe('house');
  });
  it('상가/근린 → commercial', () => {
    expect(mapUsgCd(undefined, '근린생활시설')).toBe('commercial');
    expect(mapUsgCd(undefined, '상가')).toBe('commercial');
  });
  it('토지/임야 → land', () => {
    expect(mapUsgCd(undefined, '토지')).toBe('land');
    expect(mapUsgCd(undefined, '임야')).toBe('land');
  });
  it('미분류 → other', () => {
    expect(mapUsgCd(undefined, undefined)).toBe('other');
    expect(mapUsgCd('99999', '기타')).toBe('other');
  });
});

// 실제 searchControllerMain.on 응답 행(라이브 캡처) — WebSquare dlt_srchResult 매핑 회귀 고정.
const sampleRow = {
  boCd: 'B000210', saNo: '20080130025092', srnSaNo: '2008타경25092',
  maemulSer: '1', mokmulSer: '3', mulJinYn: 'Y',
  maemulUtilCd: '01',          // 숫자 코드(이걸로 분류하면 'other' = 과거 버그)
  dspslUsgNm: '아파트',        // 용도명 텍스트(이걸로 분류해야 'apartment')
  gamevalAmt: '194000000', minmaePrice: '194000000', yuchalCnt: '1',
  maeGiil: '20260625', printSt: '서울특별시 성북구 정릉동 508-123 1층102호',
  inqCnt: '19', gwansMulRegCnt: '2', // 경쟁 신호
};

describe('rowToScraped', () => {
  it('용도(dspslUsgNm)·사건번호(srnSaNo 타경포맷)·주소·금액 정확 매핑', () => {
    const s = rowToScraped(sampleRow, 'B000210')!;
    expect(s).not.toBeNull();
    expect(s.listing.propertyType).toBe('apartment'); // dspslUsgNm 기반(숫자코드였으면 other)
    expect(s.listing.caseNo).toBe('2008타경25092');    // srnSaNo(공백제거), 숫자 saNo 아님
    expect(s.listing.itemNo).toBe('1');
    expect(s.listing.address).toContain('정릉동');
    expect(s.listing.appraisalValue).toBe(194_000_000);
    expect(s.listing.minBidPrice).toBe(194_000_000);
    expect(s.listing.failCount).toBe(1);
    expect(s.listing.saleDate).toBe('2026-06-25');
    expect(s.listing.court).toBe('서울중앙지방법원');
    expect(s.listing.source).toBe('courtauction');
    expect(s.listing.inquiryCount).toBe(19);   // 경쟁 신호(조회수)
    expect(s.listing.interestCount).toBe(2);   // 경쟁 신호(관심수)
  });

  it('종결(mulJinYn=N)·금액0·주소없음 → 제외(null)', () => {
    expect(rowToScraped({ ...sampleRow, mulJinYn: 'N' }, 'B000210')).toBeNull();
    expect(rowToScraped({ ...sampleRow, gamevalAmt: '0', minmaePrice: '0', notifyMinmaePrice1: '0' }, 'B000210')).toBeNull();
    expect(rowToScraped({ ...sampleRow, printSt: '' }, 'B000210')).toBeNull();
  });
});

// 실제 selectAuctnCsSrchRslt.on → dma_result(라이브 캡처) — 매각물건명세서 기반 권리 파싱 회귀.
const sampleDma = {
  dspslGdsDxdyInfo: {
    tprtyRnkHypthcStngDts: '508-123번지, 508-124번지 토지 : 2003.05.23. 근저당권\n집합건물 : 2008.07.09 근저당권',
    gdsSpcfcRmk: '-개시결정 당시에는 대지권 미등기이나, 이후 대지권등기가 완료됨\n-2008.11.28. 이재선 유치권신고(879,596,895원)하였으나, 성립여부 불분명함\n-토지 별도등기 있음(가등기, 근저당권)',
    ndstrcRghCtt: null,
    sprfcExstcDts: null,
  },
  dstrtDemnInfo: [{ orddcsDvsCd: '021', dstrtDemnLstprdYmd: '20081128' }],
  gdsDspslObjctLst: [{ rletDvsDts: '전유', pjbBuldList: '철근콘크리트조\r\n67.87㎡', aeeEvlAmt: 194000000 }],
};

describe('parseCourtDetail', () => {
  it('최선순위설정 → registry(말소기준) + statementSeniorDate, 비고 → notes, 배당종기', () => {
    const d = parseCourtDetail(sampleDma);
    // 최선순위설정의 날짜 2건이 근저당 registry로
    expect(d.registry.length).toBe(2);
    expect(d.registry.every((r) => r.kind === 'geunjeodang')).toBe(true);
    expect(d.registry.map((r) => r.receiptDate).sort()).toEqual(['2003-05-23', '2008-07-09']);
    expect(d.statementSeniorDate).toBe('2003-05-23'); // 최선(가장 이른) 설정일
    // 비고 redflag가 notes에
    expect(d.notes.some((n) => n.includes('유치권'))).toBe(true);
    expect(d.notes.some((n) => n.includes('토지 별도등기'))).toBe(true);
    expect(d.notes.some((n) => n.startsWith('최선순위설정:'))).toBe(true);
    // 배당요구종기·면적·집합건물
    expect(d.demandDeadline).toBe('2008-11-28');
    expect(d.areaM2).toBe(67.87);
    expect(d.isCollective).toBe(true);
    expect(d.tenants).toEqual([]); // baseline: 점유자 표는 e-doc, notes로만
    expect(d.siteAssumedAmount).toBeNull(); // 유치권 등 자동 인수 처리 안 함(보수적)
  });

  it('빈/누락 dma_result → 빈 결과(throw 없음)', () => {
    const d = parseCourtDetail({});
    expect(d.registry).toEqual([]);
    expect(d.statementSeniorDate).toBeUndefined();
    expect(d.notes).toEqual([]);
  });
});

describe('isKnownForIncremental (증분 상세 skip 판정)', () => {
  const keys = new Set(['2024타경1|1', '2024타경2|1']);
  it('비증분 모드 → 항상 false(전량 상세)', () => {
    expect(isKnownForIncremental({ incremental: false, knownKeys: keys }, '2024타경1|1')).toBe(false);
    expect(isKnownForIncremental({ knownKeys: keys }, '2024타경1|1')).toBe(false);
  });
  it('증분 + knownKeys에 있음 → true(상세 skip)', () => {
    expect(isKnownForIncremental({ incremental: true, knownKeys: keys }, '2024타경1|1')).toBe(true);
  });
  it('증분 + knownKeys에 없음(신규) → false(상세 수집)', () => {
    expect(isKnownForIncremental({ incremental: true, knownKeys: keys }, '2025타경999|1')).toBe(false);
  });
  it('증분이지만 knownKeys 미제공 → false', () => {
    expect(isKnownForIncremental({ incremental: true }, '2024타경1|1')).toBe(false);
  });
});

describe('shouldFetchDetailNow (신규 상세 예산)', () => {
  it('known → 예산 무관 false(메타만)', () => {
    expect(shouldFetchDetailNow(true, 0, 200)).toBe(false);
    expect(shouldFetchDetailNow(true, 0, undefined)).toBe(false);
  });
  it('신규 + 예산 미설정 → 무제한 true', () => {
    expect(shouldFetchDetailNow(false, 9999, undefined)).toBe(true);
  });
  it('신규 + 예산 내 → true', () => {
    expect(shouldFetchDetailNow(false, 199, 200)).toBe(true);
  });
  it('신규 + 예산 소진 → false(메타만, 다음 실행 이월)', () => {
    expect(shouldFetchDetailNow(false, 200, 200)).toBe(false);
  });
});

describe('detailDecision (증분 상세 수집 판정)', () => {
  const caps = { maxNew: 200, maxRefresh: 250, refreshDays: 14 };
  const cnt = { nNew: 0, nRefresh: 0 };
  const today = '2026-07-12', thr = '2026-07-26';
  it('신규(예산 내) → new', () => {
    expect(detailDecision(false, '2026-08-01', today, thr, cnt, caps)).toBe('new');
  });
  it('신규 + 예산 소진 → skip', () => {
    expect(detailDecision(false, null, today, thr, { nNew: 200, nRefresh: 0 }, caps)).toBe('skip');
  });
  it('기존 + 매각 임박(창 내) → refresh(명세서 변경감지)', () => {
    expect(detailDecision(true, '2026-07-20', today, thr, cnt, caps)).toBe('refresh');
    expect(detailDecision(true, today, today, thr, cnt, caps)).toBe('refresh'); // 당일도 임박
  });
  it('기존 + 임박 아님(창 밖/과거) → skip', () => {
    expect(detailDecision(true, '2026-08-15', today, thr, cnt, caps)).toBe('skip'); // 창 밖
    expect(detailDecision(true, '2026-07-01', today, thr, cnt, caps)).toBe('skip'); // 과거(D+)
    expect(detailDecision(true, null, today, thr, cnt, caps)).toBe('skip');         // 기일미정
  });
  it('기존 + 임박이지만 재수집 예산 소진 → skip', () => {
    expect(detailDecision(true, '2026-07-20', today, thr, { nNew: 0, nRefresh: 250 }, caps)).toBe('skip');
  });
  it('refreshDays=0 → 기존은 임박이어도 재수집 안 함(순수 skip)', () => {
    expect(detailDecision(true, '2026-07-13', today, thr, cnt, { ...caps, refreshDays: 0 })).toBe('skip');
  });
});
