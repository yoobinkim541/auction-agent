/**
 * EMPTY_REGISTRY(등기 미확보) 물건 전용 1차 소견 배치.
 * 대상: 활성 매물 중 신뢰 실패 사유가 정확히 EMPTY_REGISTRY 하나뿐인 것 전부. 명세서 비고가 바뀐 물건은 다시 쓴다.
 * 규칙 판정이라 LLM·외부 호출이 없다(pipeline/legal/registry-opinion.ts).
 * 이 스크립트는 정밀 평가를 직접 바꾸지 않는다 — 저장된 소견은 다음 analyze 실행에서
 * pipeline/precision/persist.ts가 조회해 hold→conditional 완화에만 쓴다(recommended 승격 불가).
 *
 * 사용: npm run registry-opinion:backfill
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { query, pool, saveRegistryOpinion } from '../shared/db.ts';
import { REGISTRY_OPINION_MODEL, registryOpinionFromNotes } from '../pipeline/legal/registry-opinion.ts';

interface Target {
  listing_id: number;
  notes: unknown[] | null;
  input_hash: string | null;
  model_version: string | null;
}

async function main() {
  const targets = await query<Target>(`
    select t.listing_id, o.input_hash, o.model_version,
           (select jsonb_agg(d.parsed_json->'notes') from gm_listing_docs d
             where d.listing_id = t.listing_id and jsonb_typeof(d.parsed_json->'notes') in ('array', 'string')) notes
      from gm_data_trust t
      join gm_listings l on l.id = t.listing_id
      left join gm_registry_opinions o on o.listing_id = t.listing_id
     where t.reason_codes::text = '["EMPTY_REGISTRY"]'
       and (l.sale_date >= current_date or l.sale_date is null)`);

  let saved = 0; let clues = 0;
  for (const t of targets) {
    const notes = (t.notes ?? []).flat().filter((note): note is string => typeof note === 'string');
    const inputHash = createHash('sha256').update(JSON.stringify(notes)).digest('hex');
    if (t.model_version === REGISTRY_OPINION_MODEL && t.input_hash === inputHash) continue;
    const opinion = registryOpinionFromNotes(notes);
    await saveRegistryOpinion(t.listing_id, opinion, REGISTRY_OPINION_MODEL, inputHash);
    saved++;
    if (opinion.hasClue) clues++;
  }
  console.log(`등기 미확보 1차 소견: 대상 ${targets.length}건 · 저장 ${saved}건(단서 ${clues}건)`);
  await pool().end();
}

main().catch((e) => { console.error('registry-opinion-backfill 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
