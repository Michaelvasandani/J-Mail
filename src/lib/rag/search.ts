import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getEmbeddingProvider } from "./embeddings";
import { getReranker } from "./rerank";

/**
 * Hybrid retrieval over message_chunks:
 *   1. pgvector cosine search (semantic)      -> top VECTOR_K chunks
 *   2. Postgres full-text search (keyword)    -> top FTS_K chunks
 *   3. reciprocal rank fusion, grouped by message
 *   4. rerank the top candidates with a cross-encoder (see ./rerank.ts)
 */

const VECTOR_K = 30;
const FTS_K = 30;
const RRF_K = 60;
const RERANK_CANDIDATES = 20;

export type SearchFilters = { accountId?: number | null; after?: Date | null; before?: Date | null };

export type Candidate = {
  messageId: number;
  accountEmail: string;
  accountColor: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  date: Date;
  /** Best-matching chunks for this message, in chunk order. */
  chunks: { chunkIndex: number; content: string }[];
  /** Fused retrieval score (higher is better). */
  score: number;
  /** Cross-encoder relevance in [0, 1]; undefined when reranking is off or failed. */
  relevance?: number;
};

type ChunkHit = { chunkId: number; messageId: number; chunkIndex: number; content: string; rank: number };

function filterSql(f: SearchFilters) {
  const parts = [sql`true`];
  if (f.accountId) parts.push(sql`m.account_id = ${f.accountId}`);
  if (f.after) parts.push(sql`m.date >= ${f.after}`);
  if (f.before) parts.push(sql`m.date < ${f.before}`);
  return sql.join(parts, sql` and `);
}

async function vectorSearch(vec: number[], f: SearchFilters): Promise<ChunkHit[]> {
  const v = `[${vec.join(",")}]`;
  const rows = await db.execute<{ id: number; message_id: number; chunk_index: number; content: string }>(sql`
    select c.id, c.message_id, c.chunk_index, c.content
    from message_chunks c join messages m on m.id = c.message_id
    where ${filterSql(f)}
    order by c.embedding <=> ${v}::vector
    limit ${VECTOR_K}`);
  return rows.map((r, i) => ({ chunkId: r.id, messageId: r.message_id, chunkIndex: r.chunk_index, content: r.content, rank: i + 1 }));
}

async function keywordSearch(q: string, f: SearchFilters): Promise<ChunkHit[]> {
  const rows = await db.execute<{ id: number; message_id: number; chunk_index: number; content: string }>(sql`
    select c.id, c.message_id, c.chunk_index, c.content
    from message_chunks c join messages m on m.id = c.message_id
    where ${filterSql(f)} and to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${q})
    order by ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${q})) desc
    limit ${FTS_K}`);
  return rows.map((r, i) => ({ chunkId: r.id, messageId: r.message_id, chunkIndex: r.chunk_index, content: r.content, rank: i + 1 }));
}

// ---------- Rerank (cross-encoder) ----------

function chunkText(c: Candidate) {
  return c.chunks.map((ch) => ch.content).join("\n\n[...]\n\n");
}

async function rerank(question: string, candidates: Candidate[]): Promise<Candidate[]> {
  const reranker = getReranker();
  if (!reranker || candidates.length === 0) return candidates;
  const top = candidates.slice(0, RERANK_CANDIDATES);
  let scores: number[];
  try {
    scores = await reranker.score(question, top.map(chunkText));
  } catch (err) {
    console.warn(`[rerank] ${reranker.name} failed; using retrieval order:`, (err as Error).message);
    return candidates;
  }
  const scored = top.map((c, i) => ({ ...c, relevance: scores[i] }));
  // Sort by reranker relevance, fused retrieval score as tie-break; the unranked tail keeps its order.
  scored.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || b.score - a.score);
  return [...scored, ...candidates.slice(RERANK_CANDIDATES)];
}

// ---------- Public API ----------

export async function searchInbox(question: string, filters: SearchFilters = {}, limit = 8): Promise<Candidate[]> {
  const provider = getEmbeddingProvider();
  const [qvec, kw] = await Promise.all([provider.embedQuery(question), keywordSearch(question, filters).catch(() => [] as ChunkHit[])]);
  const vec = await vectorSearch(qvec, filters);

  // Reciprocal rank fusion per chunk, then aggregate per message (sum of its chunks' scores).
  const chunkScore = new Map<number, { hit: ChunkHit; score: number }>();
  for (const list of [vec, kw]) {
    for (const h of list) {
      const cur = chunkScore.get(h.chunkId) ?? { hit: h, score: 0 };
      cur.score += 1 / (RRF_K + h.rank);
      chunkScore.set(h.chunkId, cur);
    }
  }
  const byMessage = new Map<number, { score: number; chunks: ChunkHit[] }>();
  for (const { hit, score } of chunkScore.values()) {
    const cur = byMessage.get(hit.messageId) ?? { score: 0, chunks: [] };
    cur.score += score;
    cur.chunks.push(hit);
    byMessage.set(hit.messageId, cur);
  }
  if (byMessage.size === 0) return [];

  const ids = [...byMessage.keys()];
  const meta = await db.execute<{
    id: number; from_name: string | null; from_email: string | null; subject: string | null; date: Date; email: string; color: string;
  }>(sql`
    select m.id, m.from_name, m.from_email, m.subject, m.date, a.email, a.color
    from messages m join accounts a on a.id = m.account_id
    where m.id in ${ids}`);
  const metaById = new Map(meta.map((r) => [r.id, r]));

  let candidates: Candidate[] = ids
    .map((id) => {
      const m = metaById.get(id)!;
      const { score, chunks } = byMessage.get(id)!;
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      return {
        messageId: id,
        accountEmail: m.email,
        accountColor: m.color,
        fromName: m.from_name,
        fromEmail: m.from_email,
        subject: m.subject,
        date: new Date(m.date),
        chunks: chunks.slice(0, 3).map((c) => ({ chunkIndex: c.chunkIndex, content: c.content })),
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  candidates = await rerank(question, candidates);
  return candidates.slice(0, limit);
}
