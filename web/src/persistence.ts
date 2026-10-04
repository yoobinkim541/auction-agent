import { DEFAULT_CONFIG, type ScoreConfig } from './scoring.ts';
import type { SortKey } from './filters.ts';

const CFG_KEY = 'gm_score_config';
const UI_KEY = 'gm_ui_state';
const UI_STATE_VERSION = 2;

export type UIState = {
  version?: number;
  sort?: SortKey; sortDir?: 'asc' | 'desc'; type?: string;
  hideExpired?: boolean; onlyPassed?: boolean; onlyMultiRound?: boolean; hideIncomplete?: boolean;
  groupByCase?: boolean;
};

/** localStorage에서 점수 설정 로드 — 없거나 손상 시 기본값과 병합(부분 저장 호환). */
export function loadConfig(): ScoreConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}
export function saveConfig(cfg: ScoreConfig): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

/** localStorage에서 UI 상태(정렬·필터) 로드 — 손상 시 빈 객체. */
export function loadUIState(): UIState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const state = JSON.parse(raw) as UIState;
      return state.version === UI_STATE_VERSION ? state : {};
    }
  } catch { /* ignore */ }
  return {};
}
export function saveUIState(state: UIState): void {
  localStorage.setItem(UI_KEY, JSON.stringify({ ...state, version: UI_STATE_VERSION }));
}
