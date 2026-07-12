import { useEffect, useRef, useState } from 'react';

/**
 * 점진 렌더 훅 — 큰 목록을 처음 chunk건만 DOM에 그리고, 목록 끝 센티널이 뷰포트에
 * 접근하면 chunk씩 추가한다(무한 스크롤). 목록(참조)이 바뀌면(필터/정렬/탭) 처음으로 리셋.
 * 수천 행 일괄 마운트가 최초 렌더·탭 전환을 수 초 잡아먹던 병목을 제거한다.
 */
export function useIncrementalList<T>(list: T[], chunk = 60): {
  visible: T[]; sentinelRef: React.RefObject<HTMLDivElement | null>; done: boolean; total: number;
} {
  const [count, setCount] = useState(chunk);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setCount(chunk); }, [list, chunk]);

  const done = count >= list.length;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return;
    // rootMargin 여유 — 사용자가 끝에 닿기 전에 미리 로드해 스크롤 끊김 없음.
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) setCount((c) => c + chunk); },
      { rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [list, done, chunk]);

  return { visible: done ? list : list.slice(0, count), sentinelRef, done, total: list.length };
}
