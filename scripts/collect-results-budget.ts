export interface CollectResultOptions {
  daysBack: number;
  daysFwd: number;
  resultLimit: number;
  backfillLimit: number;
  evalBackfillLimit: number;
}

type EnvLike = Partial<Record<string, string | undefined>>;

function readNonNegativeInt(env: EnvLike, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function readCollectResultOptions(env: EnvLike = process.env): CollectResultOptions {
  const eveningProfile = env.COLLECT_RESULTS_PROFILE === 'evening';
  return {
    daysBack: readNonNegativeInt(env, 'RESULT_DAYS_BACK', 5),
    daysFwd: readNonNegativeInt(env, 'RESULT_DAYS_FWD', 21),
    resultLimit: readNonNegativeInt(env, 'RESULT_LIMIT', eveningProfile ? 30 : 300),
    backfillLimit: readNonNegativeInt(env, 'RESULT_BACKFILL_LIMIT', eveningProfile ? 15 : 60),
    evalBackfillLimit: readNonNegativeInt(env, 'RESULT_EVAL_BACKFILL_LIMIT', eveningProfile ? 0 : 300),
  };
}
