import { EMBEDDING_DIMENSIONS } from "@/db";

/**
 * Embedding provider abstraction.
 *
 * Default is a local open-weight model via Ollama (free, private). Set EMBEDDING_PROVIDER=voyage
 * and VOYAGE_API_KEY to use Voyage AI instead. Both produce unit-normalized vectors of
 * EMBEDDING_DIMENSIONS, so pgvector cosine distance works identically. Switching providers or
 * models requires a re-index (POST /api/index?reset=1) because the vector spaces differ.
 */

export type EmbeddingProvider = {
  /** Identifier stored alongside each chunk, e.g. "ollama:qwen3-embedding:0.6b". */
  readonly model: string;
  /** Rough upper bound on tokens per input; chunking stays under this. */
  readonly maxInputTokens: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

// ---------- Ollama (local) ----------

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b";
// Ollama's context window for embedding requests; inputs longer than this are truncated server-side.
const OLLAMA_NUM_CTX = 4096;

// Qwen3-Embedding is trained with an instruction on the query side only; documents are embedded raw.
function ollamaQueryPrefix(model: string, text: string) {
  if (model.startsWith("qwen3-embedding")) {
    return `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${text}`;
  }
  if (model.startsWith("nomic-embed-text")) return `search_query: ${text}`;
  return text;
}
function ollamaDocumentPrefix(model: string, text: string) {
  if (model.startsWith("nomic-embed-text")) return `search_document: ${text}`;
  return text;
}

async function ollamaEmbed(input: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, input, truncate: true, options: { num_ctx: OLLAMA_NUM_CTX } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404) {
      throw new Error(`Ollama model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}`);
    }
    throw new Error(`Ollama embed failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings.map(normalize);
}

const ollama: EmbeddingProvider = {
  model: `ollama:${OLLAMA_MODEL}`,
  maxInputTokens: OLLAMA_NUM_CTX,
  async embedDocuments(texts) {
    // Ollama processes inputs sequentially anyway; small batches keep request bodies bounded.
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => ollamaDocumentPrefix(OLLAMA_MODEL, t));
      out.push(...(await ollamaEmbed(batch)));
    }
    return out;
  },
  async embedQuery(text) {
    const [v] = await ollamaEmbed([ollamaQueryPrefix(OLLAMA_MODEL, text)]);
    return v;
  },
};

// ---------- Voyage AI (hosted) ----------

const VOYAGE_MODEL = process.env.VOYAGE_EMBEDDING_MODEL ?? "voyage-4-large";

async function voyageEmbed(input: string[], inputType: "query" | "document"): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ input, model: VOYAGE_MODEL, input_type: inputType, output_dimension: EMBEDDING_DIMENSIONS, truncation: true }),
  });
  if (!res.ok) throw new Error(`Voyage embed failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return data.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}

const voyage: EmbeddingProvider = {
  model: `voyage:${VOYAGE_MODEL}`,
  maxInputTokens: 32000,
  async embedDocuments(texts) {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) out.push(...(await voyageEmbed(texts.slice(i, i + 64), "document")));
    return out;
  },
  async embedQuery(text) {
    const [v] = await voyageEmbed([text], "query");
    return v;
  },
};

// ---------- Selection ----------

function normalize(v: number[]): number[] {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding has ${v.length} dimensions; schema expects ${EMBEDDING_DIMENSIONS}. Change EMBEDDING_DIMENSIONS and re-index.`);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const which = (process.env.EMBEDDING_PROVIDER ?? "ollama").toLowerCase();
  if (which === "voyage") {
    if (!process.env.VOYAGE_API_KEY?.trim()) throw new Error("EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is not set");
    return voyage;
  }
  return ollama;
}

/** True if the configured provider is reachable (used to report status without throwing). */
export async function embeddingsAvailable(): Promise<{ ok: boolean; model: string; error?: string }> {
  const p = getEmbeddingProvider();
  try {
    await p.embedQuery("ping");
    return { ok: true, model: p.model };
  } catch (err) {
    return { ok: false, model: p.model, error: (err as Error).message };
  }
}
