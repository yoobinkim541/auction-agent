import type { Listing, ListingDoc, RightsInput, PropertyType } from '../../shared/types.ts';

export interface CrawlFilter {
  /** 관심 지역 키워드(예: ['서울','경기','인천']) */
  regions: string[];
  /** 물건 종류 */
  propertyTypes: PropertyType[];
  /** 최대 수집 건수(폴라이트) */
  maxItems?: number;
  /** 법원당 최대 수집 건수 — 설정 시 서울중앙이 전역 예산을 독식하지 않고 수도권 법원에 고르게 분배(경기·인천 포함). 미설정 시 maxItems와 동일. */
  perCourt?: number;
  /** 증분 모드(정기 배치용) — knownKeys에 있는 물건은 상세(fetchDetail)를 건너뛰고 검색 메타만 갱신. 신규 물건만 풀 파싱. */
  incremental?: boolean;
  /** 이미 권리분석이 끝난 물건 키 집합(`case_no|item_no`). incremental=true일 때만 사용. */
  knownKeys?: Set<string>;
  /** 이번 실행에서 상세(fetchDetail)까지 받을 신규 물건 상한 — 배치 실행시간 유계화(systemd 타임아웃 예방).
   *  초과분은 메타만 저장되고 권리분석이 없어 다음 실행에서 자동으로 다시 "신규"로 잡혀 이어서 파싱된다. */
  maxNewDetails?: number;
}

/** 한 매물 수집 결과: 마스터 + (가능하면) 권리분석 입력 + 문서 */
export interface ScrapedListing {
  listing: Listing;
  rightsInput?: Omit<RightsInput, 'listing'> & { listing?: never };
  docs?: ListingDoc[];
}

export interface Adapter {
  name: Listing['source'];
  crawl(filter: CrawlFilter): Promise<ScrapedListing[]>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
