import type { ScoreConfig } from './scoring.ts';

/** 도움말/범례 — 점수 구성·통과 기준·배지 의미를 한 화면에. 대시보드를 self-explanatory하게. */
export function Legend({ cfg }: { cfg: ScoreConfig }) {
  const wSum = (cfg.wSafety + cfg.wClean + cfg.wCompetition) || 1;
  const w = (x: number) => `${Math.round((x / wSum) * 100)}%`;
  return (
    <section className="legend">
      <div className="legend-grid">
        <div className="legend-card">
          <h4>⭐ 점수는 어떻게 나오나</h4>
          <ul>
            <li><b>안전마진</b> {w(cfg.wSafety)} — 진짜 안전마진(취득비용 반영)이 높을수록 ↑</li>
            <li><b>권리 안전</b> {w(cfg.wClean)} — 인수금액·위험등급이 낮을수록 ↑</li>
            <li><b>경쟁도</b> {w(cfg.wCompetition)} — 관심수가 적을수록(남들이 덜 본) ↑</li>
            <li>★무피 후보 가점 · 🔴위험항목 감점</li>
          </ul>
          <p className="muted">가중치·기준은 <b>⚙ 조건</b>에서 조절. 점수에 마우스를 올리면 분해가 보입니다.</p>
        </div>

        <div className="legend-card">
          <h4>✅ "통과" 기준</h4>
          <ul>
            <li>관심 지역 + 허용 물건종류</li>
            <li>진짜 안전마진 ≥ {Math.round(cfg.minSafetyMargin * 100)}%</li>
            <li>인수금액 0원 (낙찰자 추가부담 없음)</li>
            <li>특수권리(유치권·지분 등 위험) 제외{cfg.excludeSpecialRights ? '' : ' — 현재 꺼짐'}</li>
          </ul>
          <p className="muted">상단 <b>🎯 추천</b> 탭 = 통과 매물만 · 점수순. 매일 밤 텔레그램으로도 발송됩니다.</p>
        </div>

        <div className="legend-card">
          <h4>🏷 배지 읽는 법</h4>
          <ul className="legend-chips">
            <li><span className="lowcomp-chip">🔥저경쟁</span> 관심수 적음 — 경쟁 덜한 딜</li>
            <li><span className="zero-pi-chip">★무피</span> 전세보증금≈낙찰가 → 실투자금 적음</li>
            <li><span className="badge reco-consider reco-badge">권장✦</span> AI 보고서 긍정 · <span className="badge reco-avoid reco-badge">⚠회피</span> 통과지만 AI 회피권고</li>
            <li><span className="case-multi-chip">외 N물건</span> 같은 사건 다물건(🗂 사건묶기 ON) </li>
            <li><span className="new-chip">NEW</span> 오늘 신규 수집 · <span className="badge badge-incomplete">등기?</span> 등기 미수집(분석 보류)</li>
            <li>🔴N 위험항목 · 🟡N 주의항목 (입찰 전 확인)</li>
          </ul>
        </div>

        <div className="legend-card">
          <h4>🧭 빠르게 쓰는 법</h4>
          <ul>
            <li>상단 <b>통계 칩</b>(오늘기일·7일이내·무피후보…)은 <b>클릭하면 필터</b>로 동작</li>
            <li><b>정렬</b>에서 <b>🔥 저경쟁순</b>·진짜마진순으로 좋은 딜 발굴</li>
            <li><b>🗂 사건묶기</b>로 한 사건 여러 물건을 1줄로 접어 검토 횟수↓</li>
            <li>행 클릭 → 상세에 <b>🧠 AI 투자 의견서</b>·권리·체크리스트</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
