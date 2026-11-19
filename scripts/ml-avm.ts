/**
 * 시세 모델(AVM) — 국토부 매매 실거래로 학습하고 경매 매물의 시세를 추정해 gm_avm_estimates 에 남긴다.
 * report-only: 운영 시세(gm_location_analysis.market_price)·점수·추천·입찰가를 바꾸지 않는다.
 *
 * 시점 고정: 매물의 평가 기준일(as_of)이 속한 달의 1일까지 알려진 거래만으로 그 달 모델을 학습한다.
 * 물건별 신고·조회 시각이 없으면 계약일+30일을 알게 된 날로 본다. gm_molit_cache.fetched_at 은
 * 그 달 자료를 마지막으로 받은 시각이라 물건별 신고일이 아니다. as_of 가 매각 7일 전에 닿은 행은 다시 쓰지 않는다.
 * 매각 후 시세(gm_post_sale_values)는 판단 라벨 전용이다. 매각일 뒤 180일 창이 닫히고 신고 지연 30일이 지난 기일만
 * 한 번 쓰고 덮지 않는다(on conflict do nothing).
 *
 * 사용: npm run ml:avm [-- --dry-run] [-- --rebuild]   (--rebuild: 굳은 추정 행도 현재 모델로 다시 계산. 매각 후 시세는 다시 쓰지 않는다)
 */
import 'dotenv/config';
import { mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, pool } from '../shared/db.ts';
import { fetchMolitRaw } from '../shared/molit-cache.ts';
import { parseExclusiveArea } from '../crawler/normalize.ts';
import { addressToLawdCd } from '../pipeline/location/lawd-codes.ts';
import { extractDong, extractLotNumber } from '../pipeline/location/comps.ts';
import { pythonPath, readPredictionCsv, writeCsv } from './ml-shadow-ensemble.ts';

/** v3: 월별 as-of 모델. 달 시작 이전에 알려진 거래만 학습하고, 하한은 종류×근거별 한쪽 보정이다. */
export const AVM_MODEL_VERSION = 'avm-v3';
/** 매각 후 시세 산출 규칙. avm.py POST_SALE_METHOD 와 같다. */
export const POST_SALE_METHOD = 'post-sale-v1';
const METRICS_PATH = 'artifacts/ml/avm_metrics.json';
const dryRun = process.argv.includes('--dry-run');
const rebuild = process.argv.includes('--rebuild');

const KIND: Record<string, 'apt' | 'rh' | 'offi'> = { apartment: 'apt', villa: 'rh', officetel: 'offi' };

const OFFICETEL_EP = 'RTMSDataSvcOffiTrade';
const OFFICETEL_REFRESH_MONTHS = 3;
const DEAD_CODE_MIN_MONTHS = 6;

/** 매매 실거래(해제 건 제외). 숫자가 아닌 금액·면적·날짜는 버린다. */
export const TRADES_SQL = `
  select case c.ep when 'RTMSDataSvcAptTrade' then 'apt' when 'RTMSDataSvcRHTrade' then 'rh' else 'offi' end as kind,
         c.lawd_cd as sgg,
         trim(it->>'umdNm') as dong,
         nullif(trim(it->>'jibun'), '') as jibun,
         nullif(trim(coalesce(it->>'aptNm', it->>'mhouseNm', it->>'offiNm')), '') as name,
         (it->>'excluUseAr')::float8 as area_m2,
         case when trim(it->>'floor') ~ '^-?[0-9]+$' then trim(it->>'floor')::int end as floor,
         case when trim(it->>'buildYear') ~ '^[0-9]{4}$' then trim(it->>'buildYear')::int end as build_year,
         make_date((it->>'dealYear')::int, (it->>'dealMonth')::int, (it->>'dealDay')::int)::text as deal_date,
         replace(replace(it->>'dealAmount', ',', ''), ' ', '')::float8 * 10000 as price,
         (trim(coalesce(it->>'dealingGbn', '')) = '직거래') as direct
    from gm_molit_cache c
   cross join lateral jsonb_array_elements(c.items) it
   where c.ep in ('RTMSDataSvcAptTrade', 'RTMSDataSvcRHTrade', '${OFFICETEL_EP}')
     and coalesce(trim(it->>'cdealType'), '') = ''
     and it->>'dealAmount' ~ '^[0-9, ]+$'
     and it->>'excluUseAr' ~ '^[0-9.]+$'
     and it->>'dealYear' ~ '^[0-9]{4}$' and it->>'dealMonth' ~ '^[0-9]{1,2}$' and it->>'dealDay' ~ '^[0-9]{1,2}$'`;

/**
 * 평가 대상 — 신뢰 결과가 있는 과거 기일과 예정 매물. 건물 식별값은 법원 원자료(raw_json)에만 있어
 * 같은 사건·물건이면 법원 행을 먼저 고른다.
 */
const TARGETS_SQL = `
  with keys as (
    select e.court, e.case_no, coalesce(nullif(e.item_no, ''), '1') as item_no, e.sale_date
      from gm_trusted_outcome_eval e
     where e.sale_date < $1::date
    union
    select l.court, l.case_no, coalesce(nullif(l.item_no, ''), '1'), l.sale_date
      from gm_listings l
     where l.sale_date >= $1::date
  )
  select k.court, k.case_no, k.item_no, k.sale_date::text as sale_date,
         least(k.sale_date - 7, $1::date)::text as as_of,
         l.property_type, l.address, l.area_m2::float8 as area_m2,
         l.raw_json->>'hjguDong' as hjgu_dong, l.raw_json->>'hjguRd' as hjgu_rd,
         l.raw_json->>'daepyoLotno' as lot_no, l.raw_json->>'buldNm' as building_name,
         l.raw_json->>'pjbBuldList' as building_text, l.raw_json->>'buldList' as unit_text
    from keys k
    join lateral (
      select *
        from gm_listings
       where court = k.court
         and case_no = k.case_no
         and coalesce(nullif(item_no, ''), '1') = k.item_no
       order by (source = 'courtauction') desc, crawled_at desc nulls last, id desc
       limit 1
    ) l on true
   where l.property_type in ('apartment', 'villa', 'officetel')`;

interface TargetRow {
  court: string; case_no: string; item_no: string; sale_date: string; as_of: string;
  property_type: string; address: string; area_m2: number | null;
  hjgu_dong: string | null; hjgu_rd: string | null; lot_no: string | null; building_name: string | null;
  building_text: string | null; unit_text: string | null;
}

/** '103동 1층102호' → 1, '지하1층 비01호' → -1. 여러 층에 걸치면 가장 낮은 지상층. */
export function parseFloor(text: string | null | undefined): number | null {
  if (!text) return null;
  const floors: number[] = [];
  for (const match of text.matchAll(/(지하|지)?\s*([0-9]{1,2})층/g)) floors.push(match[1] ? -Number(match[2]) : Number(match[2]));
  if (!floors.length) return null;
  const above = floors.filter((floor) => floor > 0);
  return above.length ? Math.min(...above) : Math.max(...floors);
}

/** 법원 매물 행 → 실거래와 맞출 키. 실거래의 umdNm은 '개군면 하자포리'처럼 읍면+리를 붙여 쓴다. */
export function avmTarget(row: TargetRow): Record<string, string | number | null> {
  const dong = [row.hjgu_dong, row.hjgu_rd].map((part) => part?.trim()).filter(Boolean).join(' ') || extractDong(row.address) || null;
  const jibun = row.lot_no?.trim() || extractLotNumber(row.address) || null;
  return {
    court: row.court,
    case_no: row.case_no,
    item_no: row.item_no,
    sale_date: row.sale_date,
    as_of: row.as_of,
    kind: KIND[row.property_type] ?? null,
    sgg: addressToLawdCd(row.address) ?? null,
    dong,
    jibun,
    name: row.building_name?.trim() || null,
    area_m2: parseExclusiveArea(row.building_text) ?? row.area_m2,
    floor: parseFloor(row.unit_text) ?? parseFloor(row.address),
  };
}

/**
 * 운영 분석은 활성 오피스텔이 있는 시군구의 최근 12개월만 받는다. 학습에는 아파트 캐시에 있는 (시군구·월)이
 * 모두 필요해, 비어 있는 칸과 최근 달을 운영과 같은 조회(fetchMolitRaw — 자체 키 우선, 최근 달은 7일마다 갱신)로 채운다.
 * 응답이 없으면 쌓인 것만으로 학습한다.
 */
async function refreshOfficetelTrades(today: string): Promise<void> {
  const since = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - (OFFICETEL_REFRESH_MONTHS - 1));
  const cells = await query<{ lawd_cd: string; ym: string }>(
    `select a.lawd_cd, a.ym
       from gm_molit_cache a
       left join gm_molit_cache o on o.ep = $1 and o.lawd_cd = a.lawd_cd and o.ym = a.ym
      where a.ep = 'RTMSDataSvcAptTrade' and (o.ep is null or a.ym >= $2)
      order by a.ym desc, a.lawd_cd`,
    [OFFICETEL_EP, since.toISOString().slice(0, 7).replace('-', '')],
  );
  let read = 0;
  let failures = 0;
  for (const cell of cells) {
    if (await fetchMolitRaw(OFFICETEL_EP, cell.lawd_cd, cell.ym)) {
      failures = 0;
      read += 1;
    } else if (++failures >= 3) break;
  }
  if (read < cells.length) console.warn(`[ml:avm] 오피스텔 매매 ${cells.length - read}/${cells.length}개 시군구·월을 받지 못했습니다 — 다음 실행에서 다시 받습니다`);
}

/**
 * 최근에 조회했는데 여러 달 내리 아파트 매매가 0건인 시군구 — 행정구역 개편으로 죽은 코드일 가능성이 크다.
 * (부천 41190·화성 41590이 이렇게 1년 넘게 감정가 대체값만 내고 있었다.)
 */
async function warnDeadLawdCodes(): Promise<void> {
  const dead = await query<{ lawd_cd: string; months: number }>(
    `select lawd_cd, months
       from (select lawd_cd, (count(*) filter (where ym > last_trade_ym))::int as months, max(fetched_at) as fetched_at
               from (select lawd_cd, ym, fetched_at,
                            coalesce(max(ym) filter (where n > 0) over (partition by lawd_cd), '') as last_trade_ym
                       from gm_molit_cache
                      where ep = 'RTMSDataSvcAptTrade') cells
              group by lawd_cd) codes
      where months >= $1 and fetched_at > now() - interval '14 days'
      order by lawd_cd`,
    [DEAD_CODE_MIN_MONTHS],
  );
  if (dead.length) console.warn(`[ml:avm] 경고: 아파트 매매 0건이 이어지는 시군구 코드 ${dead.map((row) => `${row.lawd_cd}(${row.months}개월)`).join(', ')} — 법정동 코드 개편 확인 필요`);
}

async function main(): Promise<void> {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  if (!dryRun) await refreshOfficetelTrades(today);
  await warnDeadLawdCodes();
  const trades = await query(TRADES_SQL);
  const targets = (await query<TargetRow>(TARGETS_SQL, [today])).map(avmTarget);
  if (!trades.length) throw new Error('매매 실거래가 없어 시세 모델을 학습할 수 없습니다');

  const prefix = resolve(tmpdir(), `gyeongmae-ml-avm-${process.pid}`);
  const tradesPath = `${prefix}-trades.csv`;
  const targetsPath = `${prefix}-targets.csv`;
  const outputPath = `${prefix}-output.csv`;
  const postSalePath = `${prefix}-post-sale.csv`;
  writeCsv(tradesPath, trades);
  writeCsv(targetsPath, targets);
  mkdirSync('artifacts/ml', { recursive: true });

  try {
    const scriptPath = fileURLToPath(new URL('./ml/avm.py', import.meta.url));
    const result = spawnSync(pythonPath(), [
      scriptPath, '--trades', tradesPath, '--targets', targetsPath, '--output', outputPath, '--metrics', METRICS_PATH,
      '--post-sale-output', postSalePath, '--as-of', today, '--model-version', AVM_MODEL_VERSION,
    ], { env: process.env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`시세 모델 실행 실패: exit=${result.status}`);
    const estimates = readPredictionCsv(outputPath);
    const postSale = readPredictionCsv(postSalePath);
    console.log(`[ml:avm] 실거래 ${trades.length}건 학습, 매물 ${targets.length}건 중 ${estimates.filter((row) => row.value).length}건 추정`);
    console.log(`[ml:avm] 매각 후 시세: 창이 닫힌 기일 ${postSale.length}건 중 ${postSale.filter((row) => row.value).length}건 확인 거래 있음`);
    if (dryRun) {
      console.log('[ml:avm] dry-run: DB에 저장하지 않았습니다');
      return;
    }
    const payload = estimates.map((row) => ({
      court: row.court,
      case_no: row.case_no,
      item_no: row.item_no,
      sale_date: row.sale_date,
      as_of: row.as_of,
      kind: row.kind,
      value: row.value ? Math.round(Number(row.value)) : null,
      value_low: row.value_low ? Math.round(Number(row.value_low)) : null,
      value_high: row.value_high ? Math.round(Number(row.value_high)) : null,
      basis: row.basis,
      building_comps: row.building_comps ? Number(row.building_comps) : 0,
      dong_comps: row.dong_comps ? Number(row.dong_comps) : 0,
    }));
    const stored = await query<{ n: number }>(
      `insert into gm_avm_estimates
         (court, case_no, item_no, sale_date, as_of, kind, value, value_low, value_high, basis, building_comps, dong_comps, model_version)
       select p.court, p.case_no, p.item_no, p.sale_date::date, p.as_of::date, p.kind, p.value, p.value_low, p.value_high,
              p.basis, p.building_comps, p.dong_comps, $2
         from jsonb_to_recordset($1::jsonb) as p(
           court text, case_no text, item_no text, sale_date text, as_of text, kind text,
           value bigint, value_low bigint, value_high bigint, basis text, building_comps int, dong_comps int
         )
       on conflict (court, case_no, item_no, sale_date) do update set
         as_of=excluded.as_of, kind=excluded.kind, value=excluded.value, value_low=excluded.value_low,
         value_high=excluded.value_high, basis=excluded.basis, building_comps=excluded.building_comps,
         dong_comps=excluded.dong_comps, model_version=excluded.model_version, created_at=now()
        where $3::boolean or gm_avm_estimates.as_of < excluded.as_of
       returning 1 as n`,
      [JSON.stringify(payload), AVM_MODEL_VERSION, rebuild],
    );
    console.log(`[ml:avm] ${stored.length}건 저장(신규·기준일 갱신${rebuild ? '·재계산' : ''}), 나머지 ${payload.length - stored.length}건은 굳은 값 유지`);
    // 종류가 바뀌어 대상에서 빠진 매물(예: 오피스텔 → 상가)의 예전 값은 다른 종류의 시세라 지운다. ml:eval·ml:shadow 가 종류를 보지 않고 읽는다.
    const dropped = await query<{ n: number }>(
      `delete from gm_avm_estimates a
        where (select l.property_type
                 from gm_listings l
                where l.court = a.court and l.case_no = a.case_no and coalesce(nullif(l.item_no, ''), '1') = a.item_no
                order by (l.source = 'courtauction') desc, l.crawled_at desc nulls last, l.id desc
                limit 1) not in ('apartment', 'villa', 'officetel')
       returning 1 as n`,
    );
    if (dropped.length) console.log(`[ml:avm] 종류가 바뀐 매물의 추정 ${dropped.length}건 삭제`);
    const postSalePayload = postSale.map((row) => ({
      court: row.court,
      case_no: row.case_no,
      item_no: row.item_no,
      sale_date: row.sale_date,
      value: row.value ? Math.round(Number(row.value)) : null,
      confirms: Number(row.confirms),
      window_days: Number(row.window_days),
    }));
    const postSaleStored = await query<{ n: number }>(
      `insert into gm_post_sale_values (court, case_no, item_no, sale_date, value, confirms, window_days, method_version)
       select p.court, p.case_no, p.item_no, p.sale_date::date, p.value, p.confirms, p.window_days, $2
         from jsonb_to_recordset($1::jsonb) as p(
           court text, case_no text, item_no text, sale_date text, value bigint, confirms int, window_days int
         )
       on conflict (court, case_no, item_no, sale_date) do nothing
       returning 1 as n`,
      [JSON.stringify(postSalePayload), POST_SALE_METHOD],
    );
    console.log(`[ml:avm] 매각 후 시세 ${postSaleStored.length}건 신규 저장, 나머지 ${postSalePayload.length - postSaleStored.length}건은 이미 기록됨`);
  } finally {
    for (const path of [tradesPath, targetsPath, outputPath, postSalePath]) {
      try { unlinkSync(path); } catch {}
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error('ml avm 실패:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => pool().end().catch(() => undefined));
}
