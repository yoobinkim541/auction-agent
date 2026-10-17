import { useCallback, useEffect, useRef, useState } from 'react';
import { triggerJob, fetchJobStatus } from './api.ts';

export type JobType = 'crawl' | 'analyze' | 'eval' | 'ingest-legal';

export interface JobStatusState {
  msg: string;
  ok: boolean;
}

export function formatJobElapsed(elapsedSeconds: number): string {
  const mins = Math.floor(elapsedSeconds / 60);
  const secs = elapsedSeconds % 60;
  return mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
}

export function jobStatusMessage(
  label: string,
  state: 'starting' | 'running' | 'ok' | 'error',
  elapsedStr?: string,
): JobStatusState {
  switch (state) {
    case 'starting':
      return { msg: `${label} 시작 중…`, ok: true };
    case 'running':
      return { msg: elapsedStr ? `${label} 실행 중… ${elapsedStr}` : `${label} 실행 중…`, ok: true };
    case 'ok':
      return { msg: elapsedStr ? `✓ ${label} 완료 (${elapsedStr})` : `✓ ${label} 완료`, ok: true };
    case 'error':
      return { msg: `✕ ${label} 실패`, ok: false };
  }
}

export interface UseJobRunnerOptions {
  onComplete?: (job: JobType) => void;
  pollIntervalMs?: number;
}

export function useJobRunner(options: UseJobRunnerOptions = {}) {
  const { onComplete, pollIntervalMs = 8000 } = options;
  const [jobStatus, setJobStatus] = useState<JobStatusState | null>(null);
  const [runningJob, setRunningJob] = useState<JobType | null>(null);
  const jobTimerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const clearJobTimer = useCallback(() => {
    if (jobTimerRef.current) {
      clearTimeout(jobTimerRef.current);
      jobTimerRef.current = null;
    }
  }, []);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const showJob = useCallback(
    (msg: string, ok: boolean, ttl?: number) => {
      clearJobTimer();
      setJobStatus({ msg, ok });
      const effectiveTtl = ttl !== undefined ? ttl : ok ? 4000 : 7000;
      if (effectiveTtl > 0) {
        jobTimerRef.current = window.setTimeout(() => {
          setJobStatus(null);
        }, effectiveTtl);
      }
    },
    [clearJobTimer],
  );

  const runJob = useCallback(
    (job: JobType, label: string) => {
      stopPoll();
      setRunningJob(job);
      showJob(jobStatusMessage(label, 'starting').msg, true, 0);

      triggerJob(job)
        .then(() => {
          showJob(jobStatusMessage(label, 'running').msg, true, 0);
          const start = Date.now();

          pollRef.current = window.setInterval(async () => {
            const elapsed = Math.round((Date.now() - start) / 1000);
            const elapsedStr = formatJobElapsed(elapsed);
            try {
              const st = await fetchJobStatus();
              const s = st[job];
              if (s?.state === 'ok') {
                stopPoll();
                setRunningJob(null);
                showJob(jobStatusMessage(label, 'ok', elapsedStr).msg, true);
                onCompleteRef.current?.(job);
              } else if (s?.state === 'error') {
                stopPoll();
                setRunningJob(null);
                showJob(jobStatusMessage(label, 'error').msg, false);
              } else {
                showJob(jobStatusMessage(label, 'running', elapsedStr).msg, true, 0);
              }
            } catch {
              // ignore poll errors
            }
          }, pollIntervalMs);
        })
        .catch((e: unknown) => {
          setRunningJob(null);
          showJob(`오류: ${e instanceof Error ? e.message : String(e)}`, false);
        });
    },
    [pollIntervalMs, showJob, stopPoll],
  );

  useEffect(() => {
    return () => {
      clearJobTimer();
      stopPoll();
    };
  }, [clearJobTimer, stopPoll]);

  const dismissJob = useCallback(() => {
    clearJobTimer();
    setJobStatus(null);
  }, [clearJobTimer]);

  return {
    jobStatus,
    runningJob,
    runJob,
    showJob,
    stopPoll,
    dismissJob,
  };
}
