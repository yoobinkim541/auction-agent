/**
 * EMPTY_REGISTRY(등기 미확보) 물건 전용 AI 1차 소견 배치.
 * 대상: 활성 매물 중 신뢰 실패 사유가 정확히 EMPTY_REGISTRY 하나뿐이고 아직 소견이 없는 것.
 * claude CLI(구독)로 원문+법령 RAG 기반 1차 소견을 받아 gm_registry_opinions에 저장한다.
 * 이 스크립트는 정밀 평가를 직접 바꾸지 않는다 — 저장된 소견은 다음 analyze 실행에서
 * pipeline/precision/persist.ts가 조회해 hold→conditional 완화에만 쓴다(recommended 승격 불가).
 *
 * 사용: npm run registry-opinion:backfill [--top N]
 * 환경변수: REGISTRY_OPINION_LIMIT(기본 20), REGISTRY_OPINION_DELAY_MS(기본 3000)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { getRegistryOpinion } from '../pipeline/legal/registry-opinion.ts';
import { searchLegal } from '../pipeline/legal/search.ts';
import { saveRegistryOpinion } from '../shared/db.ts';
import { hashEvaluationInput } from '../pipeline/precision/input.ts';
import { REGISTRY_OPINION_MODEL } from '../pipeline/legal/registry-opinion.ts';

interface Target {
  listing_id: number;
  case_no: string;
  property_type: string;
}

async function fetchTargets(limit: number): Promise<Target[]> {
  return query<Target>(`
    select t.listing_id, l.case_no, l.property_type
      from gm_data_trust t
      join gm_listings l on l.id = t.listing_id
     where t.reason_codes::text = '["EMPTY_REGISTRY"]'
       and (l.sale_date >= current_date or l.sale_date is null)
       and not exists (select 1 from gm_registry_opinions o where o.listing_id = t.listing_id)
     order by l.sale_date asc nulls last
     limit $1`, [limit]);
}

async function fetchNotesAndAppraisal(listingId: number): Promise<{ notes: string[]; appraisalText: string }> {
  const docs = await query<{ doc_type: string; parsed_json: any }>(
    `select doc_type, parsed_json from gm_listing_docs where listing_id=$1`, [listingId],
  );
  const notes: string[] = [];
  let appraisalText = '';
  for (const d of docs) {
    const p = d.parsed_json ?? {};
    if (typeof p.notes === 'string') notes.push(p.notes);
    if (Array.isArray(p.notes)) notes.push(...p.notes);
    if (d.doc_type === 'appraisal_report' && typeof p.text === 'string') appraisalText = p.text;
  }
  return { notes, appraisalText };
}

async function main(): Promise<void> {
  const limit = Number(process.env.REGISTRY_OPINION_LIMIT) || 20;
  const delayMs = Number(process.env.REGISTRY_OPINION_DELAY_MS) || 3000;
  const topArg = Number(process.argv.find((a) => a.startsWith('--top='))?.split('=')[1] ?? 0) || limit;

  const targets = await fetchTargets(topArg);
  if (!targets.length) {
    console.log('처리할 신규 EMPTY_REGISTRY 대상이 없습니다.');
    await pool().end();
    return;
  }
  console.log(`등기 미확보 AI 1차 소견 배치 시작: ${targets.length}건 (delay ${delayMs}ms)`);

  const legalContext = await searchLegal('말소기준권리 최선순위 설정 저당권 압류 가압류 담보 인수 소멸');
  let done = 0; let failed = 0; let hasClueCount = 0;

  for (const t of targets) {
    try {
      const { notes, appraisalText } = await fetchNotesAndAppraisal(t.listing_id);
      const opinion = await getRegistryOpinion({
        caseNo: t.case_no, propertyType: t.property_type, notes, appraisalText, legalContext,
      });
      const inputHash = hashEvaluationInput({ notes, appraisalText } as any);
      await saveRegistryOpinion(t.listing_id, opinion, REGISTRY_OPINION_MODEL, inputHash);
      if (opinion.hasClue) hasClueCount++;
      console.log(`✅ ${t.case_no} hasClue=${opinion.hasClue} confidence=${opinion.confidence} — ${opinion.explanation.slice(0, 60)}...`);
      done++;
    } catch (e) {
      console.error(`❌ ${t.case_no}: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
    if (done + failed < targets.length) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`\n완료: ${done}건 저장(단서 발견 ${hasClueCount}건), ${failed}건 실패`);
  console.log('다음: npm run analyze -- --ids=<해당 listing_id들> 로 재분석해야 conditional 반영됨.');
  await pool().end();
}

main().catch((e) => { console.error('registry-opinion-backfill 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
