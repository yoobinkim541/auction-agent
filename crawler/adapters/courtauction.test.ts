import { describe, it, expect } from 'vitest';
import { filterCourts, parseCourtDate, parseMoney, mapUsgCd, rowToScraped, parseCourtDetail, parseCourtExtra } from './courtauction.ts';

describe('parseCourtExtra', () => {
  it('빈/미설정 → 빈 배열', () => {
    expect(parseCourtExtra(undefined)).toEqual([]);
    expect(parseCourtExtra('')).toEqual([]);
  });
  it('code:name 쌍 파싱 + 이름의 콜론 보존', () => {
    expect(parseCourtExtra('B000252:여주지원,B000253:평택지원')).toEqual([
      { code: 'B000252', name: '여주지원' },
      { code: 'B000253', name: '평택지원' },
    ]);
  });
  it('형식 오류(코드 패턴 불일치·이름 없음)는 버린다', () => {
    expect(parseCourtExtra('X:여주,B000252:,B000254:안산지원')).toEqual([{ code: 'B000254', name: '안산지원' }]);
  });
});

describe('filterCourts', () => {
  it('빈 regions → 수도권 전체(9개) 반환', () => {
    expect(filterCourts([])).toHaveLength(9);
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
  it('경기 → 수원+성남+의정부 3개 (광역 키워드 확장)', () => {
    const res = filterCourts(['경기']);
    expect(res.map((c) => c.name)).toEqual(
      expect.arrayContaining(['수원지방법원', '성남지원', '의정부지방법원']),
    );
    expect(res).toHaveLength(3);
  });
  it('DEFAULT_FILTER 서울+경기+인천 → 수도권 9개 전부', () => {
    // 이 조합이 수도권 모든 법원을 커버해야 함 — 회귀 방지
    const res = filterCourts(['서울', '경기', '인천']);
    expect(res).toHaveLength(9);
  });
  it('법원코드 직접 입력', () => {
    const res = filterCourts(['B000210']);
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe('서울중앙지방법원');
  });
  it('매칭 없음 → 빈 배열', () => {
    expect(filterCourts(['부산'])).toHaveLength(0);
  });
  it('COURT_EXTRA 지원은 경기/수도권에 포함(코드 목록 주입)', () => {
    const extended = [
      { code: 'B000210', name: '서울중앙지방법원' },
      { code: 'B000250', name: '수원지방법원' },
      { code: 'B000251', name: '성남지원' },
      { code: 'B000214', name: '의정부지방법원' },
      { code: 'B000252', name: '여주지원' }, // COURT_EXTRA로 추가된 지원
    ];
    // 여주지원은 이름에 '경기'가 없지만 경기/수도권 요청 시 포함돼야 한다(baseCodes 밖 → 경기로 간주)
    expect(filterCourts(['경기'], extended).map((c) => c.name)).toContain('여주지원');
    // 서울만 요청하면 지원은 제외
    expect(filterCourts(['서울'], extended).map((c) => c.name)).not.toContain('여주지원');
  });
  it('반환값 변형이 METRO_COURTS 원본에 영향 없음', () => {
    const r = filterCourts([]);
    r.push({ code: 'ZZZ', name: '테스트법원' });
    expect(filterCourts([])).toHaveLength(9); // 원본 불변
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
