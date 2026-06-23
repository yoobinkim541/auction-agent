import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type ListingItem, eok } from './api.ts';
import { marginColor } from './listing-utils.ts';
import { TYPE_LABEL } from './labels.ts';

/** 지도 뷰 — 좌표 있는 매물을 안전마진 색 마커로 표시(App.tsx에서 분리). */
export function MapView({ items, onSelect }: { items: ListingItem[]; onSelect: (r: ListingItem) => void }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const pts = useMemo(() => items.filter((r) => r.lat != null && r.lng != null), [items]);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: true, attributionControl: true }).setView([37.55, 126.98], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const bounds: [number, number][] = [];
    for (const r of pts) {
      const lat = r.lat!, lng = r.lng!;
      bounds.push([lat, lng]);
      const tm = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin ?? null;
      const m = L.circleMarker([lat, lng], { radius: 8, color: '#0b0e14', weight: 1, fillColor: marginColor(r), fillOpacity: 0.92 });
      m.bindPopup(
        `<div class="map-pop"><b>${r.address}</b><br/><span class="map-pop-sub">${TYPE_LABEL[r.property_type] ?? r.property_type} · ${r.case_no}</span><br/>` +
        `최저가 ${eok(r.min_bid_price)} · 마진 ${tm != null ? (tm * 100).toFixed(1) + '%' : '-'}<br/>` +
        `<button class="map-open" type="button">상세 보기 ›</button></div>`,
      );
      m.on('popupopen', (e) => {
        const root = (e as unknown as { popup: L.Popup }).popup.getElement();
        root?.querySelector<HTMLButtonElement>('.map-open')?.addEventListener('click', () => onSelectRef.current(r));
      });
      m.addTo(layer);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    // 철거된 맵에서 invalidateSize 호출 방지 — 타이머 핸들 정리 + 살아있는지 확인
    const sizeTimer = setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 60);
    return () => { clearTimeout(sizeTimer); layer.remove(); };
  }, [pts]);

  return (
    <div className="map-wrap">
      <div ref={elRef} className="map-canvas" />
      <div className="map-legend">
        <span><i style={{ background: '#1ec758' }} />마진 30%↑</span>
        <span><i style={{ background: '#a3d977' }} />10–30%</span>
        <span><i style={{ background: '#f5a623' }} />0–10%</span>
        <span><i style={{ background: '#f04545' }} />음수</span>
        <span><i style={{ background: '#7a8699' }} />시세없음</span>
      </div>
      <p className="map-count muted">{pts.length}건 표시 · 좌표 없는 {items.length - pts.length}건 제외</p>
    </div>
  );
}
