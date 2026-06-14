/**
 * 대법원 법원경매정보(courtauction.go.kr) 폴백/검증 어댑터.
 *
 * 용도: 더낙찰옥션 구조 변경 시 회복력 + 원천 사실(사건번호·감정가·최저가·매각기일) 교차검증.
 * 공공·무료·공개 데이터로 크롤링 위험이 가장 낮다(정부 원본).
 *
 * 구현 메모(리서치 근거):
 *  - 2024 개편으로 WebSquare5 SPA. 진입: /pgj/index.on
 *  - 물건 검색 화면 w2xPath: /pgj/ui/pgj100/PGJ159M00.xml (XML-form POST, JS 렌더 필요)
 *  - robots.txt 없음, 조회에 CAPTCHA/인증서 불필요(개인 사건조회만 인증서).
 *  - Playwright(헤드리스 Chromium)로 폼 POST 후 결과 표 파싱. 폴라이트 rate-limit.
 *
 * ⚠️ 미구현(스켈레톤). 더낙찰옥션 어댑터가 1차이며, 폴백 필요 시 본 어댑터를 채운다.
 */
import type { Adapter, CrawlFilter, ScrapedListing } from './types.ts';

export class CourtAuctionAdapter implements Adapter {
  name = 'courtauction' as const;

  async crawl(_filter: CrawlFilter): Promise<ScrapedListing[]> {
    console.warn(
      '[courtauction] 폴백 어댑터는 아직 미구현입니다. ' +
        'courtauction.go.kr WebSquare 폼(/pgj/ui/pgj100/PGJ159M00.xml) POST 파서를 채우세요.',
    );
    return [];
  }
}
