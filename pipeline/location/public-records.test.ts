import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildingInfo } from '../../shared/types.ts';
import {
  buildingFromTitle,
  candidateMatchesJibun,
  chooseApartmentCandidate,
  enrichMissingRecords,
  mergeBuilding,
  parseAuctionAddress,
  pickTitleItem,
  pickVworldPrice,
  pnuFromKakaoAddress,
  selectUniqueUnit,
  unitLabelMatches,
  type PublicRecordSources,
} from './public-records.ts';

const quiet: PublicRecordSources = {
  geocode: async () => null,
  building: async () => null,
  apartment: async () => null,
  house: async () => null,
  land: async () => null,
};

describe('parseAuctionAddress', () => {
  it('지번 꼬리에서 단지·동·호를 분리한다', () => {
    const parts = parseAuctionAddress('서울특별시 은평구 응암동 227-54 백련산파크타운 나동 2층203호');
    expect(parts).toMatchObject({
      jibun: '서울특별시 은평구 응암동 227-54',
      isJibun: true,
      bun: '227',
      ji: '54',
      dong: '응암동',
      complexName: '백련산파크타운',
      dongName: '나',
      hoName: '203',
    });
  });

  it('단지명 없는 층호는 공동주택 조회 키를 만들지 않는다', () => {
    const parts = parseAuctionAddress('서울특별시 성북구 정릉동 508-123 1층102호');
    expect(parts.complexName).toBeUndefined();
    expect(parts.hoName).toBe('102');
    expect(parts.bun).toBe('508');
    expect(parts.ji).toBe('123');
  });

  it('괄호 단지명을 우선한다', () => {
    expect(parseAuctionAddress('서울 강동구 천호동 123 (천호동,롯데캐슬)').complexName).toBe('롯데캐슬');
  });

});

describe('동호·후보 선택', () => {
  it('동/호 접미사를 무시하고 하나만 맞을 때만 고른다', () => {
    expect(unitLabelMatches('나동', '나')).toBe(true);
    expect(unitLabelMatches('101', '101동')).toBe(true);
    expect(unitLabelMatches('1203', '203')).toBe(false);
    const units = [{ code: '1', name: '101동' }, { code: '2', name: '102동' }];
    expect(selectUniqueUnit(units, '101')?.code).toBe('1');
    expect(selectUniqueUnit(units, undefined)).toBeNull();
    expect(selectUniqueUnit([{ code: '1', name: '가동' }], undefined)?.code).toBe('1');
  });

  it('후보가 여러 개면 지번이 하나로 맞는 경우만 고르고 첫 후보는 고르지 않는다', () => {
    const parts = parseAuctionAddress('서울특별시 강남구 역삼동 736 성홍 101동 201호');
    const candidates = [
      { noticeDate: '20260101', aptCode: '1', landAddress: '서울특별시 강남구 역삼동 737번지', complexName: '성홍' },
      { noticeDate: '20260101', aptCode: '2', landAddress: '서울특별시 강남구 역삼동 736번지', complexName: '성홍' },
    ];
    expect(candidateMatchesJibun(candidates[1]!, parts)).toBe(true);
    expect(candidateMatchesJibun(candidates[0]!, parts)).toBe(false);
    expect(chooseApartmentCandidate(candidates, parts)?.aptCode).toBe('2');
    const withJi = parseAuctionAddress('서울특별시 강남구 역삼동 736-1 성홍');
    expect(chooseApartmentCandidate([
      ...candidates,
      { noticeDate: '20260101', aptCode: '3', landAddress: '서울특별시 강남구 역삼동 736-1', complexName: '성홍' },
    ], withJi)?.aptCode).toBe('3');
    expect(chooseApartmentCandidate([
      { noticeDate: '20260101', aptCode: '2', landAddress: '서울특별시 강남구 역삼동 736-1', complexName: '성홍' },
      { noticeDate: '20260101', aptCode: '3', landAddress: '서울특별시 강남구 역삼동 736-1번지', complexName: '성홍' },
    ], withJi)).toBeNull();
  });

  it('부번이 있으면 본번만 같은 필지로 보지 않는다', () => {
    const parts = parseAuctionAddress('서울특별시 은평구 응암동 227-54 백련산파크타운 나동 203호');
    expect(candidateMatchesJibun({ landAddress: '서울특별시 은평구 응암동 227번지' }, parts)).toBe(false);
    expect(candidateMatchesJibun({ landAddress: '서울특별시 은평구 응암동 227-54' }, parts)).toBe(true);
  });
});

describe('PNU·표제부', () => {
  it('카카오 법정동 코드와 본번으로 19자리 PNU를 만든다', () => {
    expect(pnuFromKakaoAddress({
      b_code: '1168010100', main_address_no: '736', sub_address_no: '', mountain_yn: 'N',
    })).toBe('1168010100107360000');
    expect(pnuFromKakaoAddress({
      b_code: '1168010100', main_address_no: '1', sub_address_no: '2', mountain_yn: 'Y',
    })).toBe('1168010100200010002');
    expect(pnuFromKakaoAddress({ b_code: '11680', main_address_no: '1' })).toBeNull();
  });

  it('주건축물 표제부를 BuildingInfo로 옮긴다', () => {
    const picked = pickTitleItem([
      { mainAtchGbCdNm: '부속건축물', mainPurpsCdNm: '창고' },
      { mainAtchGbCdNm: '주건축물', mainPurpsCdNm: '업무시설', hhldCnt: '0', hoCnt: '117', grndFlrCnt: '10', ugrndFlrCnt: '4', useAprDay: '19920616', vlRat: '592.92', bcRat: '59.76' },
    ]);
    expect(buildingFromTitle(picked!)).toEqual({
      mainUse: '업무시설',
      households: undefined,
      units: 117,
      approvalDate: '1992-06-16',
      floorsAbove: 10,
      floorsBelow: 4,
      far: 592.92,
      bcr: 59.76,
    });
  });
});

describe('enrichMissingRecords', () => {
  const apt = { address: '서울특별시 은평구 응암동 227-54 백련산파크타운 나동 2층203호', propertyType: 'apartment' as const };

  it('없는 공시가격·표제부만 채우고 기존 값은 유지하지 위해 호출하지 않는다', async () => {
    let aptCalls = 0;
    const extra = await enrichMissingRecords(apt, {}, {
      ...quiet,
      geocode: async () => ({ pnu: '1111111111102270054', jibun: apt.address }),
      building: async () => ({ mainUse: '공동주택', approvalDate: '2001-01-01', floorsAbove: 5 }),
      apartment: async () => {
        aptCalls += 1;
        return { priceWon: 320_000_000, year: 2026, label: '백련산파크타운 나동 203' };
      },
    });
    expect(aptCalls).toBe(1);
    expect(extra.gongPrice).toBe(320_000_000);
    expect(extra.building?.mainUse).toBe('공동주택');
    expect(extra.notes[0]).toContain('시세·감정가 아님');
    expect(extra.landPricePerSqm).toBeUndefined();
  });

  it('이미 공시가격·주용도가 있으면 공동주택 조회를 하지 않는다', async () => {
    const extra = await enrichMissingRecords(apt, {
      gongPrice: 100,
      building: { mainUse: '아파트' },
    }, {
      ...quiet,
      apartment: async () => { throw new Error('should not call'); },
      building: async () => { throw new Error('should not call'); },
    });
    expect(extra).toEqual({ notes: [] });
  });

  it('공시지가를 주택 공시가격(채권 기준)으로 바꾸지 않는다', async () => {
    const extra = await enrichMissingRecords(
      { address: '서울특별시 강남구 역삼동 736', propertyType: 'land' },
      {},
      { ...quiet, land: async () => ({ pricePerSqm: 72_340_000, year: 2026 }) },
    );
    expect(extra.gongPrice).toBeUndefined();
    expect(extra.landPricePerSqm).toBe(72_340_000);
    expect(extra.notes[0]).toContain('개별공시지가');
  });

  it('표제부는 비어 있는 칸만 채운다', () => {
    const base: BuildingInfo = { mainUse: '아파트', floorsAbove: 15 };
    expect(mergeBuilding(base, { mainUse: '업무시설', approvalDate: '1992-06-16', floorsAbove: 10 })).toEqual({
      mainUse: '아파트',
      floorsAbove: 15,
      approvalDate: '1992-06-16',
    });
  });
});

describe('건축물대장 표제부 조회 경로', () => {
  const PNU = '1168010300100120000';
  const title = { mainAtchGbCdNm: '주건축물', mainPurpsCdNm: '공동주택', hhldCnt: 239, useAprDay: '19921014', grndFlrCnt: 15 };
  const own = (item: unknown) => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: item ? { item } : '' } } }), { status: 200 });
  const proxy = () => new Response(JSON.stringify({ items: [{ ...title, mainPurpsCdNm: '업무시설' }] }), { status: 200 });
  /** 호출 순서대로 자체 API 응답을 돌려주고, 프록시 호출에는 '업무시설' 표제부를 준다. */
  async function load(ownResponses: Response[]) {
    vi.resetModules();
    vi.stubEnv('MOLIT_SERVICE_KEY', 'test-key');
    const calls = { own: 0, proxy: 0 };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).includes('apis.data.go.kr')) return ownResponses[calls.own++]!;
      calls.proxy++;
      return proxy();
    }));
    const { fetchBuilding } = await import('./public-records.ts');
    return { fetchBuilding, calls };
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('자체 키 응답이 오면 프록시를 부르지 않는다', async () => {
    const { fetchBuilding, calls } = await load([own([title]), own(null)]);
    expect(await fetchBuilding(PNU)).toMatchObject({ mainUse: '공동주택', households: 239, approvalDate: '1992-10-14' });
    expect(await fetchBuilding(PNU)).toBeNull(); // 대장이 없는 필지 — 실패가 아니므로 프록시로 넘기지 않는다
    expect(calls).toEqual({ own: 2, proxy: 0 });
  });
  it('자체 호출이 503이면 그 건만 프록시로 받는다', async () => {
    const { fetchBuilding, calls } = await load([new Response('{}', { status: 503 }), own([title])]);
    expect((await fetchBuilding(PNU))?.mainUse).toBe('업무시설');
    expect((await fetchBuilding(PNU))?.mainUse).toBe('공동주택');
    expect(calls).toEqual({ own: 2, proxy: 1 });
  });
  it('미승인(403)이면 이후 조회는 자체 호출 없이 프록시만 쓴다', async () => {
    const { fetchBuilding, calls } = await load([new Response('', { status: 403 })]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fetchBuilding(PNU);
    expect((await fetchBuilding(PNU))?.mainUse).toBe('업무시설');
    expect(calls).toEqual({ own: 1, proxy: 2 });
  });
});

describe('VWorld 공동주택가격 행 고르기', () => {
  const parts = (dongName: string | undefined, hoName: string) => ({ jibun: '', isJibun: true, dongName, hoName });
  it('동·호가 맞는 행을 고른다', () => {
    const rows = [{ dongNm: '105', hoNm: '1407', pblntfPc: '528000000' }, { dongNm: '219', hoNm: '1407', pblntfPc: '1345000000' }];
    expect(pickVworldPrice(rows, parts('219', '1407'))?.pblntfPc).toBe('1345000000');
  });
  it('동 표기가 맞는 행이 없으면 동이 빈 행만 보고, 다른 동의 값은 쓰지 않는다', () => {
    const rows = [{ dongNm: '', hoNm: '502', pblntfPc: '96000000' }, { dongNm: '102', hoNm: '502', pblntfPc: '67400000' }];
    expect(pickVworldPrice(rows, parts('101', '502'))?.pblntfPc).toBe('96000000');
    expect(pickVworldPrice([rows[1]!], parts('101', '502'))).toBeNull();
  });
  it('동을 모르는데 같은 호의 가격이 갈리면 고르지 않는다', () => {
    const rows = [{ dongNm: '101', hoNm: '301', pblntfPc: '100000000' }, { dongNm: '102', hoNm: '301', pblntfPc: '120000000' }];
    expect(pickVworldPrice(rows, parts(undefined, '301'))).toBeNull();
    expect(pickVworldPrice([{ dongNm: '', hoNm: '301', pblntfPc: '86500000' }], parts(undefined, '301'))?.pblntfPc).toBe('86500000');
  });
});
