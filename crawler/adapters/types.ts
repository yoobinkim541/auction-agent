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
