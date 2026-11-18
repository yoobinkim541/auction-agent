import type { ScoreConfig } from './scoring.ts';

/** 도움말 — 점수 구성·통과 기준·표 읽는 법을 한 화면에. */
export function Legend({ cfg }: { cfg: ScoreConfig }) {
  const wSum = (cfg.wSafety + cfg.wClean + cfg.wCompetition) || 1;
  const w = (x: number) => `${Math.round((x / wSum) * 100)}%`;
  return (
    <section className="legend" aria-label="도움말">
      <div className="legend-grid">
        <div className="legend-card">
          <h4>점수</h4>
          <ul>
            <li><b>안전마진</b> {w(cfg.wSafety)} — 취득비용을 반영한 진짜 안전마진이 클수록 높음</li>
            <li><b>권리 안전</b> {w(cfg.wClean)} — 인수금액·위험등급이 낮을수록 높음</li>
            <li><b>경쟁도</b> {w(cfg.wCompetition)} — 조회·관심 등록이 적을수록 높음</li>
            <li>무피 후보는 가점, 위험항목은 감점</li>
          </ul>
          <p className="muted">가중치와 기준은 조건 설정에서 바꿉니다. 점수에 마우스를 올리면 구성이 보입니다.</p>
        </div>

        <div className="legend-card">
          <h4>통과 기준</h4>
          <ul>
            <li>관심 지역, 허용 물건종류</li>
            <li>진짜 안전마진 {Math.round(cfg.minSafetyMargin * 100)}% 이상</li>
            <li>인수금액 0원(낙찰자 추가 부담 없음)</li>
            <li>유치권·지분 등 특수권리 제외{cfg.excludeSpecialRights ? '' : ' — 현재 꺼짐'}</li>
          </ul>
          <p className="muted">추천은 통과 매물만 점수순으로 보여줍니다.</p>
        </div>

        <div className="legend-card">
          <h4>표 읽는 법</h4>
          <ul>
            <li><b>마진</b> 윗줄은 시세 대비 최저가, 아랫줄 진짜는 취득비용 반영. 저신뢰는 시세 표본 부족</li>
            <li><b>권리</b> 점 색: 초록 깨끗, 주황 주의, 빨강 위험, 빈 점 검토필요·권리자료 없음(명세서 미수집·공개 전)</li>
            <li><b>회피 권고</b> 통과 기준은 넘었지만 보고서가 회피를 권한 매물</li>
            <li><b>저경쟁</b> 조회·관심 등록이 적은 매물, <b>무피 후보</b> 전세가 취득비용을 넘을 수 있는 매물</li>
            <li><b>외 N물건</b> 같은 사건의 다른 물건, <b>신규</b> 오늘 수집</li>
          </ul>
        </div>

        <div className="legend-card">
          <h4>쓰는 법</h4>
          <ul>
            <li>검색 아래 칩(오늘 기일·7일 이내·무피 후보 등)을 누르면 바로 걸러집니다</li>
            <li>정렬에서 저경쟁순·진짜마진순으로 바꿔 보세요</li>
            <li>필터의 같은 사건 묶어 보기로 한 사건의 여러 물건을 한 줄로 접습니다</li>
            <li>행을 누르면 상세에서 의견서·권리·체크리스트를 봅니다</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
