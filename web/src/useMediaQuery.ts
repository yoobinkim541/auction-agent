import { useEffect, useState } from 'react';

/** matchMedia 반응형 훅 — query 매치 여부. 활성 레이아웃만 렌더(표/카드 동시 렌더 방지)용. CSR 전용. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}
