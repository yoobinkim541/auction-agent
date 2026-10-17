import { describe, expect, it } from 'vitest';
import { formatJobElapsed, jobStatusMessage } from './useJobRunner.ts';

describe('useJobRunner ViewModel', () => {
  describe('formatJobElapsed', () => {
    it('1분 미만 경과 시간을 초 단위로 포맷팅한다', () => {
      expect(formatJobElapsed(0)).toBe('0초');
      expect(formatJobElapsed(5)).toBe('5초');
      expect(formatJobElapsed(59)).toBe('59초');
    });

    it('1분 이상 경과 시간을 분과 초로 포맷팅한다', () => {
      expect(formatJobElapsed(60)).toBe('1분 0초');
      expect(formatJobElapsed(75)).toBe('1분 15초');
      expect(formatJobElapsed(150)).toBe('2분 30초');
    });
  });

  describe('jobStatusMessage', () => {
    it('시작 상태 메시지를 생성한다', () => {
      const status = jobStatusMessage('크롤링', 'starting');
      expect(status).toEqual({ msg: '크롤링 시작 중…', ok: true });
    });

    it('실행 중 메시지에 경과 시간을 포함한다', () => {
      const status = jobStatusMessage('분석', 'running', '1분 20초');
      expect(status).toEqual({ msg: '분석 실행 중… 1분 20초', ok: true });
    });

    it('성공 메시지에 완료 표시와 경과 시간을 포함한다', () => {
      const status = jobStatusMessage('분석', 'ok', '45초');
      expect(status).toEqual({ msg: '✓ 분석 완료 (45초)', ok: true });
    });

    it('실패 상태 메시지를 생성한다', () => {
      const status = jobStatusMessage('평가', 'error');
      expect(status).toEqual({ msg: '✕ 평가 실패', ok: false });
    });
  });
});
