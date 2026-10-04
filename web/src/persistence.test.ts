import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, saveConfig, loadUIState, saveUIState } from './persistence.ts';
import { DEFAULT_CONFIG } from './scoring.ts';

// vitest는 node 환경(jsdom 미설정)이라 localStorage가 없다 → 메모리 스텁 주입.
beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
});

describe('loadConfig / saveConfig', () => {
  it('저장값 없으면 DEFAULT_CONFIG', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('부분 저장 → DEFAULT_CONFIG와 병합(저장 키만 덮어씀)', () => {
    localStorage.setItem('gm_score_config', JSON.stringify({ minSafetyMargin: 0.25 }));
    const cfg = loadConfig();
    expect(cfg.minSafetyMargin).toBe(0.25);
    expect(cfg.wSafety).toBe(DEFAULT_CONFIG.wSafety); // 나머지는 기본값 유지
  });

  it('손상된 JSON → DEFAULT_CONFIG (throw 안 함)', () => {
    localStorage.setItem('gm_score_config', '{not json');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('saveConfig → loadConfig 라운드트립', () => {
    saveConfig({ ...DEFAULT_CONFIG, maxDangerCount: 0 });
    expect(loadConfig().maxDangerCount).toBe(0);
  });
});

describe('loadUIState / saveUIState', () => {
  it('저장값 없으면 빈 객체', () => {
    expect(loadUIState()).toEqual({});
  });

  it('손상된 JSON → 빈 객체', () => {
    localStorage.setItem('gm_ui_state', 'oops');
    expect(loadUIState()).toEqual({});
  });

  it('saveUIState → loadUIState 라운드트립', () => {
    saveUIState({ sort: 'safety', sortDir: 'asc', onlyPassed: false });
    expect(loadUIState()).toEqual({ version: 2, sort: 'safety', sortDir: 'asc', onlyPassed: false });
  });

  it('구버전 UI 상태는 무시', () => {
    localStorage.setItem('gm_ui_state', JSON.stringify({ onlyPassed: true }));
    expect(loadUIState()).toEqual({});
  });
});
