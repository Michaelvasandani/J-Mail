import { NextRequest, NextResponse } from "next/server";
import { embeddingsAvailable } from "@/lib/rag/embeddings";
import { indexMessages, indexStats, reindexAll } from "@/lib/rag/indexer";
import { getReranker, warmReranker } from "@/lib/rag/rerank";

export const maxDuration = 300;

/** Index status: how much of the inbox is embedded and whether the embedding model is reachable. */
export async function GET() {
  const [stats, provider] = await Promise.all([indexStats(), embeddingsAvailable()]);
  // Kick off the local reranker download/load in the background so the first question is fast.
  warmReranker().catch((err) => console.warn("[rerank] warm-up failed:", (err as Error).message));
  return NextResponse.json({ ...stats, provider, reranker: getReranker()?.name ?? null });
}

/** Embed the backlog (or everything again with ?reset=1 after changing the embedding model). */
export async function POST(req: NextRequest) {
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  try {
    const result = reset ? await reindexAll() : await indexMessages([]);
    return NextResponse.json({ ...result, ...(await indexStats()) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
