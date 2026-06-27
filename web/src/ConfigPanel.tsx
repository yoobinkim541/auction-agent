import { type ScoreConfig, DEFAULT_CONFIG } from './scoring.ts';
import { TYPE_LABEL } from './labels.ts';

const REGIONS = ['서울', '경기', '인천'];
// 가격대 프리셋(최저매각가, 억 단위). max=0 = 상한 없음.
const PRICE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '5천만 미만', min: 0, max: 0.5 },
  { label: '5천~1억', min: 0.5, max: 1 },
  { label: '1억~1.5억', min: 1, max: 1.5 },
  { label: '1.5억~2억', min: 1.5, max: 2 },
  { label: '2억~3억', min: 2, max: 3 },
  { label: '3억~5억', min: 3, max: 5 },
  { label: '5억 이상', min: 5, max: 0 },
];
const ALLOWED_TYPES = ['apartment', 'villa', 'officetel', 'house', 'land', 'commercial', 'other'] as const;

/** 점수/필터 기준 설정 패널(슬라이더·체크박스). cfg는 상위(App)에서 관리. */
export function ConfigPanel({ cfg, setCfg }: { cfg: ScoreConfig; setCfg: (c: ScoreConfig) => void }) {
  const safetyPct = Math.round(cfg.wSafety * 100);
  const toggleRegion = (r: string) => {
    const has = cfg.regionKeywords.includes(r);
    setCfg({ ...cfg, regionKeywords: has ? cfg.regionKeywords.filter((x) => x !== r) : [...cfg.regionKeywords, r] });
  };
  const toggleType = (t: string) => {
    const has = cfg.allowedTypes.includes(t);
    setCfg({ ...cfg, allowedTypes: has ? cfg.allowedTypes.filter((x) => x !== t) : [...cfg.allowedTypes, t] });
  };
  return (
    <div className="cfg">
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">지역</span>
        {REGIONS.map((r) => (
          <label key={r}><input type="checkbox" checked={cfg.regionKeywords.includes(r)} onChange={() => toggleRegion(r)} /> {r}</label>
        ))}
        <span className="muted">(전체 해제 = 제한 없음)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">물건종류</span>
        {ALLOWED_TYPES.map((t) => (
          <label key={t}><input type="checkbox" checked={cfg.allowedTypes.includes(t)} onChange={() => toggleType(t)} /> {TYPE_LABEL[t] ?? t}</label>
        ))}
        <span className="muted">(전체 해제 = 제한 없음)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">가격대</span>
        {PRICE_BANDS.map((b) => {
          const active = cfg.priceMinEok === b.min && cfg.priceMaxEok === b.max;
          return (
            <button key={b.label} className={`band-chip${active ? ' on' : ''}`}
              onClick={() => setCfg({ ...cfg, priceMinEok: active ? 0 : b.min, priceMaxEok: active ? 0 : b.max })}>
              {b.label}
            </button>
          );
        })}
        <span className="muted">(최저매각가 기준)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">최저매각가</span>
        <input type="number" min={0} placeholder="최소" value={cfg.priceMinEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, priceMinEok: Number(e.target.value) || 0 })} /> 억
        <span>~</span>
        <input type="number" min={0} placeholder="최대" value={cfg.priceMaxEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, priceMaxEok: Number(e.target.value) || 0 })} /> 억
        <span className="muted">(0 = 무제한)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">감정가</span>
        <input type="number" min={0} placeholder="최소" value={cfg.apprMinEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, apprMinEok: Number(e.target.value) || 0 })} /> 억
        <span>~</span>
        <input type="number" min={0} placeholder="최대" value={cfg.apprMaxEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, apprMaxEok: Number(e.target.value) || 0 })} /> 억
        <span className="muted">(0 = 무제한)</span>
      </div>
      <div className="cfg-row">
        <label>가중치 — 안전마진 {safetyPct}% : 권리 {100 - safetyPct}%</label>
        <input type="range" min={0} max={100} value={safetyPct}
          onChange={(e) => { const v = +e.target.value / 100; setCfg({ ...cfg, wSafety: v, wClean: 1 - v }); }} />
      </div>
      <div className="cfg-row">
        <label>경쟁도 가중치: {Math.round(cfg.wCompetition * 100)}% <span className="cfg-hint">(조회·관심 낮을수록 가점 — 저경쟁 발굴)</span></label>
        <input type="range" min={0} max={50} value={Math.round(cfg.wCompetition * 100)}
          onChange={(e) => setCfg({ ...cfg, wCompetition: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row">
        <label>통과 최소 안전마진: {(cfg.minSafetyMargin * 100).toFixed(0)}%</label>
        <input type="range" min={0} max={40} value={Math.round(cfg.minSafetyMargin * 100)}
          onChange={(e) => setCfg({ ...cfg, minSafetyMargin: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row">
        <label>통과 최소 진짜마진: {cfg.minTrueSafetyMarginPct <= -99 ? '제한 없음' : `${cfg.minTrueSafetyMarginPct}%`}
          <span className="cfg-hint"> (취득비용 반영 — -99 = 비활성)</span>
        </label>
        <input type="range" min={-99} max={30} value={cfg.minTrueSafetyMarginPct}
          onChange={(e) => setCfg({ ...cfg, minTrueSafetyMarginPct: +e.target.value })} />
      </div>
      <div className="cfg-row">
        <label>허용 위험항목 최대: {cfg.maxDangerCount < 0 ? '제한 없음' : `${cfg.maxDangerCount}건`}
          <span className="cfg-hint"> (공법규제·권리 위험 — -1 = 비활성)</span>
        </label>
        <input type="range" min={-1} max={3} value={cfg.maxDangerCount}
          onChange={(e) => setCfg({ ...cfg, maxDangerCount: +e.target.value })} />
      </div>
      <div className="cfg-row">
        <label>안전마진 만점 기준: {(cfg.safetyMaxAt * 100).toFixed(0)}%</label>
        <input type="range" min={10} max={60} value={Math.round(cfg.safetyMaxAt * 100)}
          onChange={(e) => setCfg({ ...cfg, safetyMaxAt: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row cfg-checks">
        <label><input type="checkbox" checked={cfg.requireCleanRights} onChange={(e) => setCfg({ ...cfg, requireCleanRights: e.target.checked })} /> 인수금액 0만 통과</label>
        <label><input type="checkbox" checked={cfg.includeReviewRequired} onChange={(e) => setCfg({ ...cfg, includeReviewRequired: e.target.checked })} /> 검토필요(특수권리)도 통과에 포함</label>
        <label><input type="checkbox" checked={cfg.requireMarketPrice} onChange={(e) => setCfg({ ...cfg, requireMarketPrice: e.target.checked })} /> 시세 미확보 제외</label>
        <label><input type="checkbox" checked={cfg.excludeSpecialRights} onChange={(e) => setCfg({ ...cfg, excludeSpecialRights: e.target.checked })} /> 특수권리(위험) 제외</label>
        <button onClick={() => setCfg(DEFAULT_CONFIG)}>기본값</button>
      </div>
    </div>
  );
}
