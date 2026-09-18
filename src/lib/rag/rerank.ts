/**
 * Second-stage reranking: score (query, email) pairs with a cross-encoder and reorder.
 *
 *   RERANKER=local  (default)  mixedbread-ai/mxbai-rerank-base-v1 via Transformers.js, on-device, free.
 *                              The model (~150 MB quantized) downloads from Hugging Face on first use
 *                              and is cached under node_modules/@huggingface/transformers/.cache.
 *   RERANKER=voyage            Voyage AI rerank-2.5 (hosted; needs VOYAGE_API_KEY).
 *   RERANKER=none              Skip reranking; use the fused retrieval order.
 */

export type Reranker = {
  readonly name: string;
  /** Returns one relevance score in [0, 1] per document, same order as `documents`. */
  score(query: string, documents: string[]): Promise<number[]>;
};

// ---------- Local cross-encoder (Transformers.js) ----------

const LOCAL_MODEL = process.env.LOCAL_RERANK_MODEL ?? "mixedbread-ai/mxbai-rerank-base-v1";

type LocalPipeline = {
  tokenizer: (texts: string[], opts: Record<string, unknown>) => Record<string, unknown>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { sigmoid(): { tolist(): number[][] } } }>;
};
let localPipeline: Promise<LocalPipeline> | undefined;

async function loadLocal(): Promise<LocalPipeline> {
  if (localPipeline) return localPipeline;
  localPipeline = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(LOCAL_MODEL),
      AutoModelForSequenceClassification.from_pretrained(LOCAL_MODEL, { dtype: "q8" }),
    ]);
    return { tokenizer, model } as unknown as LocalPipeline;
  })();
  localPipeline.catch(() => (localPipeline = undefined)); // allow retry after a failed download
  return localPipeline;
}

const local: Reranker = {
  name: `local:${LOCAL_MODEL}`,
  async score(query, documents) {
    const { tokenizer, model } = await loadLocal();
    const out: number[] = [];
    // Small batches keep memory bounded; each pair is truncated to the model's 512-token window.
    for (let i = 0; i < documents.length; i += 8) {
      const batch = documents.slice(i, i + 8);
      const inputs = tokenizer(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true, max_length: 512 });
      const { logits } = await model(inputs);
      out.push(...logits.sigmoid().tolist().map(([s]) => s));
    }
    return out;
  },
};

// ---------- Voyage AI (hosted) ----------

const VOYAGE_RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5";

const voyage: Reranker = {
  name: `voyage:${VOYAGE_RERANK_MODEL}`,
  async score(query, documents) {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ query, documents, model: VOYAGE_RERANK_MODEL, truncation: true }),
    });
    if (!res.ok) throw new Error(`Voyage rerank failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { data: { index: number; relevance_score: number }[] };
    const scores = new Array<number>(documents.length).fill(0);
    for (const d of data.data) scores[d.index] = d.relevance_score;
    return scores;
  },
};

// ---------- Selection ----------

export function getReranker(): Reranker | null {
  const which = (process.env.RERANKER ?? "local").toLowerCase();
  if (which === "none") return null;
  if (which === "voyage") {
    if (!process.env.VOYAGE_API_KEY?.trim()) throw new Error("RERANKER=voyage but VOYAGE_API_KEY is not set");
    return voyage;
  }
  return local;
}

/** Warm the local model so the first question doesn't pay the download + load cost. */
export async function warmReranker() {
  const r = getReranker();
  if (r === local) await loadLocal();
}
