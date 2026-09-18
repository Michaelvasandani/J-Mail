import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { accounts, db } from "@/db";
import { labelGuide, makeTools, parseEmailSource, type EmailMeta } from "@/lib/rag/tools";

export const maxDuration = 300;

const MODEL = process.env.CHAT_MODEL ?? "claude-opus-5";
const MAX_ITERATIONS = 8;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Body = { messages: ChatMessage[]; accountId?: number | null };

/**
 * Streamed NDJSON events:
 *   {type:"tool_call", name, input}      Claude invoked a tool
 *   {type:"emails", emails: EmailMeta[]} emails a tool surfaced (for citation chips)
 *   {type:"text", text}                  answer text delta
 *   {type:"citation", messageId}         the current sentence cites this email
 *   {type:"error", error} | {type:"done"}
 */

function systemPrompt(accountList: string[], scope: string | null) {
  return `You are an assistant that answers questions about the user's own Gmail inbox using tools. Today's date is ${new Date().toISOString().slice(0, 10)}.
Connected accounts: ${accountList.join(", ")}.${scope ? `\nThe user is currently viewing only ${scope}; restrict tools to that account unless they ask otherwise.` : ""}

Choosing tools:
- list_emails for anything about counts, "how many", "latest"/"last"/"most recent", time windows ("last 3 days", "this week", "in August"), or a label (job applications, bills, invites, security alerts). Compute dates from today's date. For "did I apply to X" or "how many applications", use category=job_update; application confirmations are job_outcome=application_received. If a label may be missing on fresh mail, also try a sender or subject filter.
- search_emails for questions about what an email says.
- read_email when a preview or passage is not enough to answer precisely.
Call several tools when needed, and prefer one more tool call over guessing.

${labelGuide()}

Answering:
- Answer from the tool results only. Cite the emails you rely on. Quote dates, amounts, names, and deadlines exactly.
- If nothing matches, say so and suggest a rephrasing; never invent email content.
- List multiple emails in date order. Be concise.
- Plain text only: the reply is shown verbatim. No markdown, no **bold**, no headings. For lists start lines with "- ".`;
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
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        if (!process.env.ANTHROPIC_API_KEY?.trim()) {
          send({ type: "error", error: "Answering needs ANTHROPIC_API_KEY in .env.local (restart the dev server after adding it)." });
          return;
        }
        const all = await db.select({ id: accounts.id, email: accounts.email }).from(accounts);
        const scope = body.accountId ? all.find((a) => a.id === body.accountId)?.email ?? null : null;

        const seen = new Map<number, EmailMeta>();
        const tools = makeTools({
          onEmails(emails) {
            const fresh = emails.filter((e) => !seen.has(e.id));
            for (const e of emails) seen.set(e.id, e);
            if (fresh.length) send({ type: "emails", emails: fresh });
          },
        });

        const client = new Anthropic();
        const runner = client.beta.messages.toolRunner({
          model: MODEL,
          max_tokens: 8000,
          system: systemPrompt(all.map((a) => a.email), scope),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          tools,
          max_iterations: MAX_ITERATIONS,
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          stream: true,
        });

        let textBlocks = 0;
        for await (const messageStream of runner) {
          for await (const event of messageStream) {
            // Text before a tool call and text after it arrive as separate blocks; keep them on separate lines.
            if (event.type === "content_block_start" && event.content_block.type === "text") {
              if (textBlocks++ > 0) send({ type: "text", text: "\n\n" });
              continue;
            }
            if (event.type !== "content_block_delta") continue;
            if (event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
            else if (event.delta.type === "citations_delta" && event.delta.citation.type === "search_result_location") {
              const messageId = parseEmailSource(event.delta.citation.source);
              if (messageId !== null) send({ type: "citation", messageId });
            }
          }
          const message = await messageStream.finalMessage();
          for (const block of message.content) {
            if (block.type === "tool_use") send({ type: "tool_call", name: block.name, input: block.input });
          }
          if (message.stop_reason === "refusal") {
            send({ type: "text", text: "\n\n(The model declined to answer this question.)" });
            break;
          }
          if (message.stop_reason === "max_tokens") {
            send({ type: "error", error: "The answer was cut off (max_tokens). Try a narrower question." });
            break;
          }
        }
        send({ type: "done" });
      } catch (err) {
        const msg = err instanceof Anthropic.AuthenticationError
          ? "Anthropic API key invalid. Check ANTHROPIC_API_KEY in .env.local."
          : (err as Error)?.message ?? String(err);
        send({ type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
