import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/** OS의 '동작 줄이기' 설정. 켜져 있으면 JS 모션(숫자 카운트·전환)도 건너뛴다. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_QUERY).matches === true;
}

// 기본 포매터는 모듈 상수로 둔다. 매 렌더 새 함수면 CountUp의 effect 의존성이 계속 바뀐다.
const formatKo = (n: number) => n.toLocaleString('ko-KR');

/**
 * 숫자를 이전 값에서 새 값까지 굴려 보여 준다. 글자는 ref로 직접 써서 프레임마다 React를 다시 그리지 않는다.
 * 첫 표시는 0부터 올라간다.
 */
export function CountUp({ value, format = formatKo, duration = 800 }: {
  value: number; format?: (n: number) => string; duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shownRef.current;
    if (prefersReducedMotion() || from === value) {
      shownRef.current = value;
      el.textContent = format(value);
      return;
    }
    el.textContent = format(Math.round(from));
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const v = from + (value - from) * (1 - (1 - p) ** 4); // easeOutQuart
      shownRef.current = v;
      el.textContent = format(Math.round(v));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf); // 중간에 바뀌면 지금 보이는 값에서 이어 굴린다
  }, [value, format, duration]);
  return <span ref={ref} className="count" />;
}

/**
 * 활성 항목(`.on`) 뒤로 미끄러지는 표시자. 컨테이너에 `--ind-x/y/w/h`를 쓰고,
 * 자식 `<span className="ind" />`가 CSS로 따라간다. 첫 배치는 전환 없이 놓는다.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const place = () => {
      const active = root.querySelector<HTMLElement>(':scope > .on');
      if (!active) {
        root.style.setProperty('--ind-o', '0');
        return;
      }
      root.style.setProperty('--ind-x', `${active.offsetLeft}px`);
      root.style.setProperty('--ind-y', `${active.offsetTop}px`);
      root.style.setProperty('--ind-w', `${active.offsetWidth}px`);
      root.style.setProperty('--ind-h', `${active.offsetHeight}px`);
      root.style.setProperty('--ind-o', '1');
    };
    place();
    const raf = requestAnimationFrame(() => { root.dataset.ind = 'ready'; });
    const ro = new ResizeObserver(place);
    ro.observe(root);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [activeKey]);
  return ref;
}

/**
 * 닫힐 때 바로 사라지지 않고 퇴장 모션을 마칠 시간을 준다.
 * `value`가 null이 되면 `exitMs` 동안 마지막 값을 `closing: true`로 유지한다.
 */
export function usePresence<T>(value: T | null, exitMs: number): { value: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  const closing = value === null && last !== null;
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setLast(null), prefersReducedMotion() ? 0 : exitMs);
    return () => window.clearTimeout(t);
  }, [closing, exitMs]);
  return { value: value ?? last, closing };
}

/** 커서 스포트라이트를 받는 타일. styles.css의 스포트라이트 규칙과 같은 대상이어야 한다. */
const SPOT_SELECTOR = '.summary > button, .week > button, .review-kpis > div';

/** 타일 위에서 포인터 위치를 `--mx/--my`로 넘겨 CSS 스포트라이트가 커서를 따라가게 한다. */
export function useSpotlight() {
  useEffect(() => {
    if (window.matchMedia?.('(hover: none)').matches) return;
    const onMove = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(SPOT_SELECTOR);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => document.removeEventListener('pointermove', onMove);
  }, []);
}
