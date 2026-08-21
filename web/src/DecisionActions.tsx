import { useEffect, useState } from 'react';
import { fetchDecisions, saveDecision, type DecisionEvent, type DecisionKind, type DecisionReason } from './api.ts';
import { decisionLabel, decisionReasonLabel, decisionReasons, decisions } from './precision.ts';

export function DecisionActions({ listingId, onSaved }: { listingId: number; onSaved: (event: DecisionEvent) => void }) {
  const [history, setHistory] = useState<DecisionEvent[]>([]);
  const [decision, setDecision] = useState<DecisionKind>('reviewing');
  const [reasonCode, setReasonCode] = useState<DecisionReason | ''>('');
  const [note, setNote] = useState('');
  const [targetBid, setTargetBid] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchDecisions(listingId)
      .then((events) => { if (active) setHistory(events); })
      .catch(() => { if (active) setError('결정 이력을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [listingId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const needsReason = decision === 'hold' || decision === 'rejected';
    const parsedBid = targetBid.trim() === '' ? undefined : Number(targetBid);
    if (needsReason && !reasonCode) {
      setError('보류와 제외에는 구조화된 사유를 선택해야 합니다.');
      return;
    }
    if (targetBid.trim() !== '' && (parsedBid === undefined || !Number.isSafeInteger(parsedBid) || parsedBid <= 0)) {
      setError('목표 입찰가는 0보다 큰 정수여야 합니다.');
      return;
    }
    if (decision === 'bid_review' && parsedBid === undefined) {
      setError('입찰 검토에는 목표 입찰가를 입력해야 합니다.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDecision(listingId, {
        decision,
        ...(reasonCode ? { reasonCode } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(parsedBid !== undefined ? { targetBid: parsedBid } : {}),
      });
      onSaved(saved);
      try {
        setHistory(await fetchDecisions(listingId));
      } catch {
        setHistory((events) => [saved, ...events.filter((existing) => existing.id !== saved.id)]);
        setError('결정은 저장됐지만 이력을 새로고침하지 못했습니다.');
      }
      setNote('');
      setTargetBid('');
    } catch {
      setError('결정을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="decision-actions" aria-labelledby="decision-actions-title">
      <div className="decision-actions-head">
        <h3 id="decision-actions-title">판단 기록</h3>
        <span>결정 로그</span>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={saving}>
          <legend>다음 결정 선택</legend>
          <div className="decision-choices">
            {decisions.map(([value, label]) => (
              <button key={value} type="button" className={decision === value ? 'on' : ''} aria-pressed={decision === value} onClick={() => setDecision(value)}>{label}</button>
            ))}
          </div>
          <label>
            <span>사유{decision === 'hold' || decision === 'rejected' ? ' (필수)' : ' (선택)'}</span>
            <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as DecisionReason | '')} required={decision === 'hold' || decision === 'rejected'}>
              <option value="">선택 안 함</option>
              {decisionReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>메모 (선택)</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
          </label>
          <label>
            <span>목표 입찰가{decision === 'bid_review' ? ' (필수, 양의 정수)' : ' (선택)'} </span>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={targetBid} onChange={(event) => setTargetBid(event.target.value)} />
          </label>
          <button type="submit" className="decision-save">{saving ? '저장 중…' : '결정 저장'}</button>
        </fieldset>
      </form>
      {error && <p className="decision-error" role="alert">{error}</p>}
      <div className="decision-history" aria-live="polite">
        <h4>결정 이력</h4>
        {loading ? <p>이력 불러오는 중…</p> : history.length === 0 ? <p>아직 기록된 결정이 없습니다.</p> : (
          <ol>{history.map((event) => <li key={event.id}><strong>{decisionLabel(event.decision)}</strong><span>{decisionReasonLabel(event.reason_code)}</span><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString('ko-KR')}</time>{event.note && <p>{event.note}</p>}</li>)}</ol>
        )}
      </div>
    </section>
  );
}
