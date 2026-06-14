/**
 * 법률 RAG 검색: 질의 임베딩 → match_legal_chunks(의미+키워드 하이브리드).
 */
import { matchLegalChunks } from '../../shared/db.ts';
import type { LegalChunk } from '../rights/claude-verify.ts';

const EMBED_MODEL = 'text-embedding-3-large';
const EMBED_DIM = 1536;

async function embed(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIM }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0]?.embedding ?? null;
}

export async function searchLegal(query: string, matchCount = 6): Promise<LegalChunk[]> {
  const emb = await embed(query);
  if (!emb) return [];
  const rows = await matchLegalChunks(emb, query, matchCount);
  return rows.map((r) => ({ lawName: r.law_name, article: r.article, content: r.content }));
}
