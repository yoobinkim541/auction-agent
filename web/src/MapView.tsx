import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type ListingItem, eok } from './api.ts';
import { marginColor, localDateISO } from './listing-utils.ts';
import { TYPE_LABEL } from './labels.ts';

export interface MapPoint { item: ListingItem; passed: boolean }

/**
 * 지도 뷰 — 수집한 매물을 안전마진 색 마커로. 통과=큰 마커(불투명)/미통과=작은 마커(반투명),
 * 기일 경과=옅게. 대량 좌표(1000+)는 canvas 렌더러로 성능 확보. 전체/현재목록 토글.
 */
export function MapView({ items, onSelect, showAll, onToggleShowAll }: {
  items: MapPoint[];
  onSelect: (r: ListingItem) => void;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const today = localDateISO();
  const pts = useMemo(() => items.filter((p) => p.item.lat != null && p.item.lng != null), [items]);
  const passedCnt = useMemo(() => pts.filter((p) => p.passed).length, [pts]);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    // preferCanvas: circleMarker를 canvas에 그려 수천 개도 부드럽게.
    const map = L.map(elRef.current, { scrollWheelZoom: true, attributionControl: true, preferCanvas: true }).setView([37.55, 126.98], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const bounds: [number, number][] = [];
    // 통과 매물을 위에 그리도록 정렬(미통과 → 통과 순서로 추가)
    const ordered = [...pts].sort((a, b) => Number(a.passed) - Number(b.passed));
    for (const { item: r, passed } of ordered) {
      const lat = r.lat!, lng = r.lng!;
      bounds.push([lat, lng]);
      const tm = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin ?? null;
      const expired = r.sale_date != null && r.sale_date < today;
      const m = L.circleMarker([lat, lng], {
        radius: passed ? 8 : 5,
        color: passed ? '#fff' : '#0b0e14',
        weight: passed ? 1.5 : 1,
        fillColor: marginColor(r),
        fillOpacity: expired ? 0.32 : passed ? 0.95 : 0.6,
      });
      m.bindPopup(
        `<div class="map-pop"><b>${r.address}</b><br/><span class="map-pop-sub">${TYPE_LABEL[r.property_type] ?? r.property_type} · ${r.case_no}${passed ? ' · ✅통과' : ''}${expired ? ' · 기일경과' : ''}</span><br/>` +
        `최저가 ${eok(r.min_bid_price)} · 마진 ${tm != null ? (tm * 100).toFixed(1) + '%' : '-'}${r.sale_date ? ` · 매각 ${r.sale_date}` : ''}<br/>` +
        `<button class="map-open" type="button">상세 보기 ›</button></div>`,
      );
      m.on('popupopen', (e) => {
        const root = (e as unknown as { popup: L.Popup }).popup.getElement();
        root?.querySelector<HTMLButtonElement>('.map-open')?.addEventListener('click', () => onSelectRef.current(r));
      });
      m.addTo(layer);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    const sizeTimer = setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 60);
    return () => { clearTimeout(sizeTimer); layer.remove(); };
  }, [pts, today]);

  return (
    <div className="map-wrap">
      <div ref={elRef} className="map-canvas" />
      <button className={`map-toggle${showAll ? ' on' : ''}`} onClick={onToggleShowAll}
        title={showAll ? '현재 목록(필터)만 보기로 전환' : '수집한 전체 매물 보기로 전환'}>
        {showAll ? '🗺 전체 매물' : '🔎 현재 목록'}
      </button>
      <div className="map-legend">
        <span><i style={{ background: '#1ec758' }} />마진 30%↑</span>
        <span><i style={{ background: '#a3d977' }} />10–30%</span>
        <span><i style={{ background: '#f5a623' }} />0–10%</span>
        <span><i style={{ background: '#f04545' }} />음수</span>
        <span><i style={{ background: '#7a8699' }} />시세없음</span>
        <span className="map-legend-note">큰 마커=통과 · 옅음=기일경과</span>
      </div>
      <p className="map-count muted">{pts.length}건 표시 (통과 {passedCnt}) · 좌표 없는 {items.length - pts.length}건 제외</p>
    </div>
  );
}
