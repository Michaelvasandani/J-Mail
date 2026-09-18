import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { getReranker } from "@/lib/rag/rerank";
import { searchInbox, type Candidate } from "@/lib/rag/search";

export const maxDuration = 300;

const MODEL = process.env.CHAT_MODEL ?? "claude-opus-5";
const TOP_K = 8;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Body = { messages: ChatMessage[]; accountId?: number | null };

export type Source = {
  index: number;
  messageId: number;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  date: string;
  accountEmail: string;
  accountColor: string;
  score: number;
  relevance?: number;
};

const SYSTEM = `You are an assistant that answers questions about the user's own email inbox.
The user's emails that may be relevant are attached as documents; each document is one email with its headers (account, sender, date, subject, category) followed by the body. Today's date is {{today}}.

Answer from the documents. Cite the emails you rely on. Quote dates, amounts, names, and deadlines exactly as they appear. If the documents do not contain the answer, say so plainly and suggest how the user might rephrase; never guess or invent email content. When several emails are relevant, summarize them in date order. Keep answers concise and direct.

Write plain text: the reply is shown verbatim, so do not use markdown (no **bold**, no # headings, no tables). For lists, start lines with "- ".`;

function line(obj: unknown) {
  return JSON.stringify(obj) + "\n";
}

// Follow-up questions ("when was that?") retrieve poorly on their own; fold in the previous user turn.
function retrievalQuery(messages: ChatMessage[]) {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content.trim());
  const last = users[users.length - 1] ?? "";
  const prev = users[users.length - 2];
  return last.split(/\s+/).length < 5 && prev ? `${prev} ${last}` : last;
}

function documentBlock(c: Candidate, i: number): Anthropic.Beta.BetaContentBlockParam {
  return {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: c.chunks.map((ch) => ch.content).join("\n\n[...]\n\n") },
    title: `Email ${i + 1}: ${c.subject ?? "(no subject)"} — from ${c.fromName ?? c.fromEmail ?? "unknown"} on ${c.date.toISOString().slice(0, 10)}`,
    citations: { enabled: true },
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;
  const messages = (body.messages ?? []).filter((m) => m.content?.trim());
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return Response.json({ error: "messages must end with a user turn" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(line(obj)));
      try {
        const question = retrievalQuery(messages);
        const candidates = await searchInbox(question, { accountId: body.accountId ?? null }, TOP_K);
        const sources: Source[] = candidates.map((c, i) => ({
          index: i,
          messageId: c.messageId,
          subject: c.subject,
          fromName: c.fromName,
          fromEmail: c.fromEmail,
          date: c.date.toISOString(),
          accountEmail: c.accountEmail,
          accountColor: c.accountColor,
          score: c.score,
          relevance: c.relevance,
        }));
        send({ type: "sources", sources, reranker: getReranker()?.name ?? null });

        if (candidates.length === 0) {
          send({ type: "text", text: "I couldn't find any emails related to that. Make sure the inbox has been synced and indexed, or try different words." });
          send({ type: "done" });
          controller.close();
          return;
        }

        if (!process.env.ANTHROPIC_API_KEY?.trim()) {
          send({ type: "error", error: "Found matching emails, but answering needs ANTHROPIC_API_KEY in .env.local (restart the dev server after adding it)." });
          return;
        }
        const client = new Anthropic();
        const history: Anthropic.Beta.BetaMessageParam[] = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
        const last = messages[messages.length - 1];
        const finalTurn: Anthropic.Beta.BetaMessageParam = {
          role: "user",
          content: [...candidates.map(documentBlock), { type: "text", text: last.content }],
        };

        const claude = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 8000,
          system: SYSTEM.replace("{{today}}", new Date().toISOString().slice(0, 10)),
          messages: [...history, finalTurn],
          output_config: { effort: "medium" },
          // Route policy declines to a fallback model inside the same request instead of returning nothing.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });

        for await (const event of claude) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
          else if (event.delta.type === "citations_delta" && event.delta.citation.type === "char_location") {
            send({ type: "citation", documentIndex: event.delta.citation.document_index, citedText: event.delta.citation.cited_text });
          }
        }
        const final = await claude.finalMessage();
        if (final.stop_reason === "refusal") send({ type: "text", text: "\n\n(The model declined to answer this question.)" });
        send({ type: "done" });
      } catch (err) {
        const msg = err instanceof Anthropic.AuthenticationError
          ? "Anthropic API key missing or invalid. Set ANTHROPIC_API_KEY in .env.local."
          : (err as Error)?.message ?? String(err);
        send({ type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
