/**
 * 법률 RAG 인제스트: 법제처 국가법령정보 OpenAPI → 조문 청킹 → 임베딩 → gm_legal_chunks.
 *   npm run ingest:legal
 *
 * 인용 grounding 전용 코퍼스(법령/판례, PII 없음). 임베딩은 OpenAI text-embedding-3-large(1536차원).
 * 법제처 OC 키가 없으면 SEED_CHUNKS(핵심 조문)만 임베딩하여 최소 동작을 보장한다.
 */
import 'dotenv/config';
import { insertLegalChunks } from '../../shared/db.ts';

const EMBED_MODEL = 'text-embedding-3-large';
const EMBED_DIM = 1536;
const LAW_API = 'https://www.law.go.kr/DRF/lawService.do';

/** 우선 수집 법령 */
const TARGET_LAWS = ['주택임대차보호법', '주택임대차보호법 시행령', '민사집행법', '상가건물 임대차보호법'];

interface Chunk { source: 'law' | 'precedent'; lawName: string; article: string; content: string }

/** 법제처 접근 불가 시 최소 보장용 핵심 조문(요약). 실제 운용 전 법제처 원문으로 대체 권장. */
const SEED_CHUNKS: Chunk[] = [
  {
    source: 'law', lawName: '주택임대차보호법', article: '제3조(대항력 등)',
    content: '임대차는 그 등기가 없는 경우에도 임차인이 주택의 인도와 주민등록(전입신고)을 마친 때에는 그 다음 날부터 제3자에 대하여 효력이 생긴다.',
  },
  {
    source: 'law', lawName: '주택임대차보호법', article: '제3조의2(보증금의 우선변제권)',
    content: '대항요건과 임대차계약증서상의 확정일자를 갖춘 임차인은 민사집행법에 따른 경매 또는 공매 시 후순위권리자나 그 밖의 채권자보다 우선하여 보증금을 변제받을 권리가 있다.',
  },
  {
    source: 'law', lawName: '주택임대차보호법', article: '제8조(보증금 중 일정액의 최우선변제)',
    content: '소액임차인은 보증금 중 일정액을 다른 담보물권자보다 우선하여 변제받을 권리가 있다. 보증금 범위와 최우선변제액은 시행령으로 정하며, 그 기준은 담보물권 설정일에 따른다. 다만 최우선변제액의 총액은 주택가액(대지 포함)의 2분의 1을 넘지 못한다.',
  },
  {
    source: 'law', lawName: '민사집행법', article: '제91조(인수주의와 잉여주의)',
    content: '매각부동산 위의 모든 저당권은 매각으로 소멸된다. 지상권·지역권·전세권 및 등기된 임차권은 저당권·압류채권·가압류채권에 대항할 수 없는 경우 매각으로 소멸된다(대항할 수 있는 경우 매수인이 인수). 유치권자는 매수인에게 그 유치권으로 담보하는 채권의 변제를 청구할 수 있다.',
  },
  {
    source: 'law', lawName: '말소기준권리 정리', article: '소멸기준 권리와 근거 법조문',
    content: '말소(소멸)기준권리: ①최선순위 저당권·근저당권 등기(민사집행법 제91조 제2항, 대원칙), ②최선순위 (가)압류등기(제91조 제3항), ③최선순위 담보가등기(가등기담보 등에 관한 법률 제12조 제1항), ④최선순위 전세권 중 담보물권성을 가지고 배당요구한 경우(제91조 제4항 후단). 경매개시결정 기입등기는 압류등기이므로 ②와 같이 소멸기준이 될 수 있다. 이 중 등기부상 가장 앞선 것이 말소기준권리가 되며, 그보다 후순위 권리는 매각으로 소멸, 선순위 비담보권리(지상권·지역권·전세권·임차권·가등기 등)는 매수인이 인수한다.',
  },
  {
    source: 'law', lawName: '가등기담보 등에 관한 법률', article: '제12조(경매의 청구)',
    content: '담보가등기권리자는 그 선택에 따라 담보권 실행을 위한 경매를 청구할 수 있으며, 담보가등기는 저당권으로 본다(경매절차에서 담보물권으로 취급). 따라서 최선순위 담보가등기는 말소기준권리가 될 수 있다.',
  },
];

async function embedBatch(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY가 필요합니다(임베딩)');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIM }),
  });
  if (!res.ok) throw new Error(`임베딩 실패: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

/** 법제처 법령 본문 XML → 조문 청크. OC 없으면 빈 배열. */
async function fetchLawChunks(lawName: string): Promise<Chunk[]> {
  const oc = process.env.LAW_GO_KR_OC;
  if (!oc) return [];
  const url = `${LAW_API}?OC=${encodeURIComponent(oc)}&target=law&type=XML&LM=${encodeURIComponent(lawName)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gyeongmae-agent)' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const arts = xml.match(/<조문단위>[\s\S]*?<\/조문단위>/g) ?? [];
    const out: Chunk[] = [];
    for (const a of arts) {
      const num = (a.match(/<조문번호>([\s\S]*?)<\/조문번호>/)?.[1] ?? '').trim();
      const title = (a.match(/<조문제목>([\s\S]*?)<\/조문제목>/)?.[1] ?? '').trim();
      const content = a
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (content.length > 20) {
        out.push({ source: 'law', lawName, article: `제${num}조${title ? `(${title})` : ''}`, content: content.slice(0, 4000) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function main() {
  let chunks: Chunk[] = [];
  for (const law of TARGET_LAWS) {
    const cs = await fetchLawChunks(law);
    console.log(`${law}: ${cs.length} 조문`);
    chunks.push(...cs);
  }
  if (chunks.length === 0) {
    console.warn('법제처 수집 0건 — SEED_CHUNKS로 대체(LAW_GO_KR_OC 설정 권장)');
    chunks = SEED_CHUNKS;
  }

  // 임베딩은 선택적: OPENAI_API_KEY 있으면 의미검색용 벡터까지, 없으면 키워드(full-text)만.
  const hasEmbed = !!process.env.OPENAI_API_KEY;
  if (!hasEmbed) console.warn('OPENAI_API_KEY 없음 → 임베딩 생략, 키워드 검색용으로만 적재(content_tsv).');
  const BATCH = 64;
  let inserted = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const embs = hasEmbed ? await embedBatch(batch.map((c) => c.content)) : null;
    await insertLegalChunks(
      batch.map((c, k) => ({
        source: c.source, lawName: c.lawName, article: c.article, content: c.content,
        embedding: embs ? (embs[k] as number[]) : null,
      })),
    );
    inserted += batch.length;
    console.log(`저장 ${inserted}/${chunks.length}`);
  }
  console.log(`완료: ${inserted} chunks 저장 (${hasEmbed ? '임베딩+키워드' : '키워드 전용'}).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
