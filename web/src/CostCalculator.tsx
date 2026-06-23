import { useState } from 'react';
import { acquisitionTaxRate } from './cost.ts';
import { eok, won, pct, type ListingItem, type LocationObj } from './api.ts';
import { Section } from './ui.tsx';

/** 희망 낙찰가 입력 → 실시간 취득비용·진짜 안전마진 계산기(상세 드로어). */
export function CostCalculator({ row, loc }: { row: ListingItem; loc: LocationObj }) {
  const ac = loc.acquisition_cost!;
  const [bid, setBid] = useState<number>(ac.bidPrice || row.min_bid_price || 0);
  const [homes, setHomes] = useState<number>(1);
  const [regulated, setRegulated] = useState<boolean>(false);
  const [etc, setEtc] = useState<number>(ac.etcCost || 0);

  const tax = acquisitionTaxRate(row.property_type, bid, row.area_m2 ?? 0, { homeCountAfter: homes, isRegulatedArea: regulated });
  // 명도비·채권·인수금액은 낙찰가와 무관 → 서버 계산값을 상수로 사용
  const moveOut = ac.moveOutCost, bond = ac.bondCost, assumed = ac.assumedAmount;
  const total = bid + tax.totalKRW + moveOut + bond + assumed + etc;
  const market = loc.market_price ?? null;
  const margin = market && market > 0 ? (market - total) / market : null;
  const ratio = row.appraisal_value ? Math.round((bid / row.appraisal_value) * 100) : null;

  const presetBtn = (label: string, v: number | null) => v ? (
    <button className="mini-btn" onClick={() => setBid(v)}>{label} {eok(v)}</button>
  ) : null;

  return (
    <Section title="취득비용 계산기 · 진짜 안전마진">
      <div className="calc-row">
        <label>희망 낙찰가</label>
        <input type="number" step={1000000} value={bid} onChange={(e) => setBid(Number(e.target.value))} />
        <span className="muted">{eok(bid)}{ratio != null ? ` · 감정가 ${ratio}%` : ''}</span>
      </div>
      <div className="calc-presets">
        {presetBtn('최저가', row.min_bid_price)}
        {presetBtn('예상낙찰', loc.expected_bid_price ?? null)}
        {presetBtn('시세', market)}
      </div>
      <div className="calc-row">
        <label>보유 주택수</label>
        <select value={homes} onChange={(e) => setHomes(Number(e.target.value))}>
          <option value={1}>1주택(기본)</option><option value={2}>2주택</option>
          <option value={3}>3주택</option><option value={4}>4주택+</option>
        </select>
        <label className="chk"><input type="checkbox" checked={regulated} onChange={(e) => setRegulated(e.target.checked)} />조정대상지역</label>
      </div>
      <table className="mini">
        <tbody>
          <tr><td>낙찰가</td><td className="num">{won(bid)}</td></tr>
          <tr><td>취득세 ({tax.totalRatePct}%) <span className="muted">{tax.note}</span></td><td className="num">{won(tax.totalKRW)}</td></tr>
          <tr><td>명도비</td><td className="num">{won(moveOut)}</td></tr>
          <tr><td>국민주택채권(본인부담)</td><td className="num">{won(bond)}</td></tr>
          {assumed > 0 && <tr><td className="danger">권리 인수금액</td><td className="num danger">{won(assumed)}</td></tr>}
          <tr>
            <td>기타비용 <span className="muted">(미납관리비·법무사 등)</span></td>
            <td className="num"><input type="number" step={100000} value={etc} onChange={(e) => setEtc(Number(e.target.value))} className="etc-in" /></td>
          </tr>
          <tr className="total"><td><b>총 취득비용</b></td><td className="num"><b>{won(total)}</b></td></tr>
          <tr><td><b>진짜 안전마진</b> (시세 {eok(market)} 대비)</td><td className="num"><b className={(margin ?? 0) < 0 ? 'danger' : 'good'}>{pct(margin)}</b></td></tr>
        </tbody>
      </table>
      {ac.notes.length > 0 && <ul className="warns">{ac.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <p className="muted">※ 취득세·채권은 참고용 추정(취득세 과세표준=낙찰가, 채권=공시가격 기준). 명도비·채권은 낙찰가와 무관해 고정. 등기 시점 위택스·주택도시기금 재확인.</p>
    </Section>
  );
}
