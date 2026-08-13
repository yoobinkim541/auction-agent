import { describe, expect, it } from 'vitest';
import { readCollectResultOptions } from './collect-results-budget.ts';

describe('readCollectResultOptions', () => {
  it('RESULT_EVAL_BACKFILL_LIMIT=0을 기본값 300으로 되돌리지 않는다', () => {
    const options = readCollectResultOptions({ RESULT_EVAL_BACKFILL_LIMIT: '0' });

    expect(options.evalBackfillLimit).toBe(0);
  });

  it('잘못된 제한값은 안전한 기본값을 사용한다', () => {
    const options = readCollectResultOptions({ RESULT_LIMIT: 'abc', RESULT_BACKFILL_LIMIT: '-1' });

    expect(options.resultLimit).toBe(300);
    expect(options.backfillLimit).toBe(60);
  });


  it('저녁 프로파일은 systemd 30분 안에 끝나도록 기본 대상 수를 줄인다', () => {
    const options = readCollectResultOptions({ COLLECT_RESULTS_PROFILE: 'evening' });

    expect(options.resultLimit).toBe(30);
    expect(options.backfillLimit).toBe(15);
    expect(options.evalBackfillLimit).toBe(0);
  });

  it('저녁 프로파일에서도 명시적 제한값은 운영자가 덮어쓸 수 있다', () => {
    const options = readCollectResultOptions({
      COLLECT_RESULTS_PROFILE: 'evening',
      RESULT_LIMIT: '12',
      RESULT_BACKFILL_LIMIT: '7',
      RESULT_EVAL_BACKFILL_LIMIT: '3',
    });

    expect(options.resultLimit).toBe(12);
    expect(options.backfillLimit).toBe(7);
    expect(options.evalBackfillLimit).toBe(3);
  });
});
