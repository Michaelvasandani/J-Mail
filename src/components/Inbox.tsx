"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

type Account = { id: number; email: string; color: string; lastSyncedAt: string | null };
type Row = {
  id: number;
  accountId: number;
  accountEmail: string;
  accountColor: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  date: string;
  unread: boolean;
};
type Attachment = { attachmentId: string; filename: string; mimeType: string; size: number };
type Detail = Row & {
  toHeader: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: Attachment[];
};
type SyncReport = { email: string; ok: boolean; added?: number; mode?: string; error?: string }[];

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Inbox() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounced(query, 250);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listLoading, startListTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/accounts");
    setAccounts(await res.json());
  }, []);

  const buildParams = useCallback(
    (before?: string | null) => {
      const p = new URLSearchParams();
      if (selectedAccount) p.set("account", String(selectedAccount));
      if (unreadOnly) p.set("unread", "1");
      if (q) p.set("q", q);
      if (before) p.set("before", before);
      return p;
    },
    [selectedAccount, unreadOnly, q],
  );

  const loadMessages = useCallback(() => {
    startListTransition(async () => {
      const res = await fetch(`/api/messages?${buildParams()}`);
      const data = await res.json();
      startTransition(() => {
        setRows(data.messages);
        setNextBefore(data.nextBefore);
      });
    });
  }, [buildParams, startListTransition]);

  const loadMore = useCallback(() => {
    if (!nextBefore || listLoading) return;
    startListTransition(async () => {
      const res = await fetch(`/api/messages?${buildParams(nextBefore)}`);
      const data = await res.json();
      startTransition(() => {
        setRows((r) => [...r, ...data.messages]);
        setNextBefore(data.nextBefore);
      });
    });
  }, [buildParams, nextBefore, listLoading, startListTransition]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setStatus("Syncing…");
    setError(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const report: SyncReport = await res.json();
      const ok = report.filter((r) => r.ok);
      const bad = report.filter((r) => !r.ok);
      const added = ok.reduce((n, r) => n + (r.added ?? 0), 0);
      setStatus(`Synced ${ok.length} account${ok.length === 1 ? "" : "s"}, ${added} new message${added === 1 ? "" : "s"}`);
      if (bad.length) setError(bad.map((b) => `${b.email}: ${b.error}`).join(" · "));
      await loadAccounts();
      loadMessages();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [loadAccounts, loadMessages]);

  const removeAccount = useCallback(
    async (a: Account) => {
      if (!confirm(`Remove ${a.email}? Cached messages for this account will be deleted locally.`)) return;
      await fetch(`/api/accounts/${a.id}`, { method: "DELETE" });
      if (selectedAccount === a.id) setSelectedAccount(null);
      await loadAccounts();
      loadMessages();
    },
    [selectedAccount, loadAccounts, loadMessages],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const added = params.get("added");
    if (err || added) window.history.replaceState({}, "", "/");
    startTransition(() => {
      if (err) setError(`Google sign-in failed: ${err}`);
    });
    // Mount-time data fetch; state is set only after the response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAccounts().then(() => {
      if (added) sync();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const openSeq = useRef(0);
  const openMessage = useCallback((id: number) => {
    const seq = ++openSeq.current;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    fetch(`/api/messages/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return r.json();
      })
      .then((d) => {
        if (openSeq.current === seq) setDetail(d);
      })
      .catch((e) => {
        if (openSeq.current === seq) setError(String(e));
      })
      .finally(() => {
        if (openSeq.current === seq) setDetailLoading(false);
      });
  }, []);

  const srcDoc = useMemo(() => {
    if (!detail) return "";
    const inner =
      detail.bodyHtml ??
      `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif">${(detail.bodyText ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</pre>`;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{margin:0;padding:16px;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#111;background:#fff;word-break:break-word}img{max-width:100%;height:auto}</style>
</head><body>${inner}</body></html>`;
  }, [detail]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold tracking-tight">J-Mail</h1>
          <button
            onClick={sync}
            disabled={syncing || accounts.length === 0}
            className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2">
          <SidebarItem active={selectedAccount === null} onClick={() => setSelectedAccount(null)}>
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-400" />
            All inboxes
          </SidebarItem>
          {accounts.map((a) => (
            <SidebarItem key={a.id} active={selectedAccount === a.id} onClick={() => setSelectedAccount(a.id)}>
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
              <span className="truncate" title={a.email}>
                {a.email}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeAccount(a);
                }}
                title="Remove account"
                className="ml-auto hidden rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 group-hover:block dark:hover:bg-zinc-700"
              >
                ×
              </button>
            </SidebarItem>
          ))}
          <a
            href="/api/auth/google"
            className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-blue-600 hover:bg-zinc-100 dark:text-blue-400 dark:hover:bg-zinc-800"
          >
            + Add Gmail account
          </a>
        </nav>

        <div className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            Unread only
          </label>
          {status && <div className="mt-2 truncate" title={status}>{status}</div>}
        </div>
      </aside>

      {/* Message list */}
      <section className="flex w-[420px] shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sender, subject, body…"
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>
        {error && (
          <div className="flex items-start justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <span className="break-words">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0">×</button>
          </div>
        )}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore();
          }}
        >
          {rows.length === 0 && !listLoading && (
            <div className="p-6 text-center text-sm text-zinc-500">
              {accounts.length === 0 ? "Add a Gmail account to get started." : q ? "No matches." : "No messages yet. Hit Sync."}
            </div>
          )}
          {rows.map((m) => (
            <button
              key={m.id}
              onClick={() => openMessage(m.id)}
              className={`block w-full border-b border-zinc-100 px-3 py-2 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800 ${
                selectedId === m.id ? "bg-blue-50 dark:bg-zinc-800" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: m.accountColor }} title={m.accountEmail} />
                <span className={`truncate text-sm ${m.unread ? "font-semibold" : "text-zinc-700 dark:text-zinc-300"}`}>
                  {m.fromName || m.fromEmail || "(unknown)"}
                </span>
                <span className="ml-auto shrink-0 text-xs text-zinc-500">{fmtDate(m.date)}</span>
              </div>
              <div className={`truncate text-sm ${m.unread ? "font-medium" : ""}`}>{m.subject || "(no subject)"}</div>
              <div className="truncate text-xs text-zinc-500">{m.snippet}</div>
            </button>
          ))}
          {listLoading && <div className="p-3 text-center text-xs text-zinc-500">Loading…</div>}
        </div>
      </section>

      {/* Reading pane */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!detail && !detailLoading && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">Select a message to read it.</div>
        )}
        {detailLoading && <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">Loading…</div>}
        {detail && !detailLoading && (
          <>
            <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-semibold">{detail.subject || "(no subject)"}</h2>
              <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{detail.fromName || detail.fromEmail}</span>
                {detail.fromName && detail.fromEmail && <span> &lt;{detail.fromEmail}&gt;</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-zinc-500">
                <span>to {detail.toHeader || detail.accountEmail}</span>
                <span>{new Date(detail.date).toLocaleString()}</span>
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: detail.accountColor, color: detail.accountColor }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: detail.accountColor }} />
                  {detail.accountEmail}
                </span>
              </div>
              {detail.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.attachments.map((a) => (
                    <a
                      key={a.attachmentId}
                      href={`/api/messages/${detail.id}/attachments/${a.attachmentId}`}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    >
                      📎 {a.filename} <span className="text-zinc-400">({fmtSize(a.size)})</span>
                    </a>
                  ))}
                </div>
              )}
            </header>
            <iframe title="Message body" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} className="flex-1 w-full bg-white" />
          </>
        )}
      </main>
    </div>
  );
}

function SidebarItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      }`}
    >
      {children}
    </div>
  );
}
