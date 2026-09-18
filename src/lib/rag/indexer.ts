import { eq, inArray, isNull, sql } from "drizzle-orm";
import { accounts, db, messageChunks, messages, messageTriage } from "@/db";
import { fetchMessageBody } from "@/lib/gmail";
import { chunkMessage } from "./chunk";
import { getEmbeddingProvider } from "./embeddings";

/**
 * Chunk + embed messages into message_chunks. Runs at the end of Sync for new messages, plus a
 * bounded backfill of anything not yet embedded. Bodies are fetched from Gmail when missing
 * (the inbox itself only fetches bodies lazily on open).
 */

const BACKFILL_LIMIT = 150; // messages embedded per sync on top of the new ones
const BODY_CONCURRENCY = 6;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function indexMessages(ids: number[]): Promise<{ embedded: number; chunks: number; failed: number }> {
  const provider = getEmbeddingProvider();
  const wanted = new Set(ids);
  if (wanted.size < BACKFILL_LIMIT) {
    const backlog = await db
      .select({ id: messages.id })
      .from(messages)
      .where(isNull(messages.embeddedAt))
      .orderBy(sql`${messages.date} desc`)
      .limit(BACKFILL_LIMIT - wanted.size);
    for (const b of backlog) wanted.add(b.id);
  }
  if (wanted.size === 0) return { embedded: 0, chunks: 0, failed: 0 };

  const rows = await db
    .select({
      id: messages.id,
      gmailId: messages.gmailId,
      fromName: messages.fromName,
      fromEmail: messages.fromEmail,
      toHeader: messages.toHeader,
      subject: messages.subject,
      snippet: messages.snippet,
      date: messages.date,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      bodyFetchedAt: messages.bodyFetchedAt,
      account: accounts,
      category: messageTriage.category,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageTriage, eq(messageTriage.messageId, messages.id))
    .where(inArray(messages.id, [...wanted]));

  let failed = 0;
  // 1. Make sure every message has a body (Gmail fetch, bounded concurrency).
  const withBodies = await mapLimit(rows, BODY_CONCURRENCY, async (m) => {
    if (m.bodyFetchedAt) return m;
    try {
      const body = await fetchMessageBody(m.account, m.gmailId);
      return { ...m, bodyText: body.bodyText, bodyHtml: body.bodyHtml };
    } catch (err) {
      console.warn(`[index] body fetch failed for message ${m.id}; indexing header+snippet only:`, (err as Error).message);
      return m;
    }
  });

  // 2. Chunk, then embed message by message so one failure doesn't lose the batch.
  let embedded = 0;
  let chunkCount = 0;
  for (const m of withBodies) {
    const chunks = chunkMessage({ ...m, accountEmail: m.account.email });
    try {
      const vectors = await provider.embedDocuments(chunks.map((c) => c.content));
      await db.transaction(async (tx) => {
        await tx.delete(messageChunks).where(eq(messageChunks.messageId, m.id));
        await tx.insert(messageChunks).values(
          chunks.map((c, i) => ({ messageId: m.id, chunkIndex: c.index, content: c.content, embedding: vectors[i], model: provider.model })),
        );
        await tx.update(messages).set({ embeddedAt: new Date() }).where(eq(messages.id, m.id));
      });
      embedded++;
      chunkCount += chunks.length;
    } catch (err) {
      failed++;
      console.error(`[index] message ${m.id} failed:`, (err as Error)?.message ?? err);
      // If the provider itself is down, every message will fail the same way; stop early.
      if (/Ollama|ECONNREFUSED|fetch failed|VOYAGE/i.test(String((err as Error)?.message))) throw err;
    }
  }
  return { embedded, chunks: chunkCount, failed };
}

/** Drop every chunk and re-embed (after changing the embedding model or chunking). */
export async function reindexAll() {
  await db.delete(messageChunks);
  await db.update(messages).set({ embeddedAt: null });
  return indexMessages([]);
}

export async function indexStats() {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      embedded: sql<number>`count(*) filter (where ${messages.embeddedAt} is not null)::int`,
    })
    .from(messages);
  const [c] = await db.select({ chunks: sql<number>`count(*)::int` }).from(messageChunks);
  return { ...row, chunks: c.chunks };
}

