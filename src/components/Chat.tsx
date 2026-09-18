"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type EmailMeta = {
  id: number;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  date: string;
  accountEmail: string;
  accountColor: string;
};
type ToolCall = { name: string; input: Record<string, unknown> };
type Turn = {
  role: "user" | "assistant";
  content: string;
  /** Tool calls Claude made while answering, in order. */
  tools?: ToolCall[];
  /** Every email a tool surfaced, keyed by id. */
  emails?: Record<number, EmailMeta>;
  /** Email ids the answer cited, in order of first citation. */
  cited?: number[];
  error?: string;
};
type IndexStatus = { total: number; embedded: number; chunks: number; provider: { ok: boolean; model: string; error?: string } };

const SUGGESTIONS = [
  "What job applications got a response this month?",
  "Do I owe anyone money right now?",
  "Summarize what my professors emailed about this week",
  "Any events or meetings I need to RSVP to?",
];

export function Chat({
  accountId,
  onOpenMessage,
  onClose,
}: {
  accountId: number | null;
  onOpenMessage: (id: number) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadIndex = useCallback(async () => {
    try {
      const res = await fetch("/api/index");
      setIndex(await res.json());
    } catch {
      /* status is informational only */
    }
  }, []);

  useEffect(() => {
    loadIndex();
  }, [loadIndex]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const runIndex = useCallback(async () => {
    setIndexing(true);
    try {
      await fetch("/api/index", { method: "POST" });
    } finally {
      setIndexing(false);
      loadIndex();
    }
  }, [loadIndex]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      setInput("");
      setBusy(true);
      const history = [...turns.filter((t) => !t.error), { role: "user" as const, content: q }];
      setTurns([...history, { role: "assistant", content: "" }]);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const update = (patch: (t: Turn) => Turn) =>
        setTurns((ts) => {
          const copy = ts.slice();
          copy[copy.length - 1] = patch(copy[copy.length - 1]);
          return copy;
        });
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })), accountId }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!raw.trim()) continue;
            const ev = JSON.parse(raw);
            if (ev.type === "tool_call") update((t) => ({ ...t, tools: [...(t.tools ?? []), { name: ev.name, input: ev.input }] }));
            else if (ev.type === "emails")
              update((t) => ({ ...t, emails: { ...(t.emails ?? {}), ...Object.fromEntries((ev.emails as EmailMeta[]).map((e) => [e.id, e])) } }));
            else if (ev.type === "text") update((t) => ({ ...t, content: t.content + ev.text }));
            else if (ev.type === "citation")
              update((t) => (t.cited?.includes(ev.messageId) ? t : { ...t, cited: [...(t.cited ?? []), ev.messageId] }));
            else if (ev.type === "error") update((t) => ({ ...t, error: ev.error }));
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") update((t) => ({ ...t, error: String((e as Error).message ?? e) }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [turns, busy, accountId],
  );

  const notIndexed = index && index.total > 0 && index.embedded === 0;

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold">Ask your inbox</h2>
          {index && (
            <div className="text-[11px] text-zinc-500" title={index.provider.error ?? index.provider.model}>
              {index.embedded}/{index.total} emails indexed · {index.provider.ok ? index.provider.model.split(":").slice(1).join(":") : "embedding model offline"}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {index && index.embedded < index.total && (
            <button
              onClick={runIndex}
              disabled={indexing || !index.provider.ok}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {indexing ? "Indexing…" : "Index more"}
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800" title="Close">
            ×
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {index && !index.provider.ok && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Embedding model unreachable: {index.provider.error}
          </div>
        )}
        {notIndexed && (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            Nothing is indexed yet. Hit <b>Index more</b> (or Sync) to embed your emails, then ask away.
          </div>
        )}
        {turns.length === 0 && (
          <div className="space-y-2">
            <div className="text-xs text-zinc-500">Try asking:</div>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="block w-full rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ml-8 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">
              {t.content}
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {t.tools && t.tools.length > 0 && (
                <div className="space-y-0.5">
                  {t.tools.map((c, j) => (
                    <div key={j} className="truncate font-mono text-[11px] text-zinc-500" title={JSON.stringify(c.input, null, 1)}>
                      {c.name}
                      {"("}
                      {Object.entries(c.input)
                        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
                        .join(", ")}
                      {")"}
                    </div>
                  ))}
                </div>
              )}
              {t.cited && t.cited.length > 0 && t.emails && (
                <div className="flex flex-wrap gap-1">
                  {t.cited
                    .map((id) => t.emails![id])
                    .filter(Boolean)
                    .map((s) => (
                      <button
                        key={s.id}
                        onClick={() => onOpenMessage(s.id)}
                        title={`${s.fromName ?? s.fromEmail ?? ""} · ${new Date(s.date).toLocaleDateString()} · ${s.accountEmail}`}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.accountColor }} />
                        <span className="truncate">{s.subject || "(no subject)"}</span>
                      </button>
                    ))}
                </div>
              )}
              <div className="whitespace-pre-wrap rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800">
                {t.content || (busy && i === turns.length - 1 ? <span className="text-zinc-400">{t.tools?.length ? "Reading results…" : "Looking through your inbox…"}</span> : null)}
              </div>
              {t.error && <div className="text-xs text-red-600 dark:text-red-400">{t.error}</div>}
            </div>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="border-t border-zinc-200 p-3 dark:border-zinc-800"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={accountId ? "Ask about this account's inbox…" : "Ask about all your inboxes…"}
            className="flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800"
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-md border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Ask
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
