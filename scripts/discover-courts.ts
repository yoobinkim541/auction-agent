/**
 * 법원 코드 발견/검증(경기 지원 커버리지 확장용) — courtauction.go.kr에 후보 cortOfcCd로 검색을 날려
 * 실제로 물건이 나오는 코드와 그 관할 지역(주소 시군구)을 출력한다. 추측 코드를 커밋하지 않기 위한 검증 도구.
 *
 * ⚠️ VM(집-IP 프록시)에서만 유효 — 데이터센터 IP는 차단됨. 사용:
 *   npm run discover:courts                 # 기본 후보(지원 코드 범위) 스캔
 *   npm run discover:courts -- B000252 B000253   # 특정 코드만
 * 출력 끝의 COURT_EXTRA= 줄에서 지역명을 확인·수정해 .env에 붙여넣으면 크롤 대상에 포함된다.
 */
import 'dotenv/config';
import { probeCourt } from '../crawler/adapters/courtauction.ts';

// 이미 검증된 본원 9곳 — 스캔에서 (기존)으로 표시.
const KNOWN = new Set(['B000210', 'B000211', 'B000212', 'B000213', 'B000214', 'B000215', 'B000240', 'B000250', 'B000251']);
// 기본 후보: 본원 코드 인접 범위(지원은 보통 본원 코드 근처). 폴라이트하게 소수만.
const DEFAULT_CANDIDATES = [
  'B000216', 'B000217', 'B000218',           // 의정부(214) 계열 지원 후보(고양·남양주 등)
  'B000241', 'B000242', 'B000243',           // 인천(240) 계열(부천 등)
  'B000252', 'B000253', 'B000254', 'B000255', 'B000256', 'B000257', // 수원(250) 계열(여주·평택·안산·안양 등)
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => /^B\d{6}$/.test(a));
  const candidates = argv.length ? argv : DEFAULT_CANDIDATES;
  console.log(`[discover] ${candidates.length}개 코드 프로브 (KST ${new Date(Date.now() + 9 * 3.6e6).toISOString().slice(0, 16)})\n`);
  const found: { code: string; regions: string[] }[] = [];

  for (const code of candidates) {
    try {
      const p = await probeCourt(code);
      const tag = KNOWN.has(code) ? '(기존)' : '★신규';
      if (p.count > 0) {
        console.log(`${code} ${tag}  ${p.count}건  · ${p.regions.join(', ') || p.sampleAddress || ''}`);
        if (!KNOWN.has(code)) found.push({ code, regions: p.regions });
      } else {
        console.log(`${code} —  결과 없음(미사용 코드일 가능성)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${code} ⚠ ${msg}`);
      if (/COURT_BLOCKED/.test(msg)) { console.error('IP 차단 — VM(집-IP 프록시)에서 실행 필요. 중단.'); break; }
    }
    await new Promise((r) => setTimeout(r, 2500)); // 폴라이트
  }

  if (found.length) {
    console.log('\n# 아래를 .env에 추가하고 "법원명"을 위 주소(시군구)로 확인·수정하세요:');
    console.log('COURT_EXTRA=' + found.map((f) => `${f.code}:법원명`).join(','));
    console.log('# 예: 주소가 "경기도 여주시…"면 B000252:여주지원');
  } else {
    console.log('\n신규 코드 없음 — 후보 코드를 인자로 지정해 재시도: npm run discover:courts -- B0002xx …');
  }
}

main().catch((e) => { console.error('discover-courts 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
