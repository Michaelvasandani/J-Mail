import { and, eq, inArray, sql } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import sanitizeHtml from "sanitize-html";
import { accounts, db, messages, type Account, type AttachmentMeta } from "@/db";
import { gmailFor } from "./google";

const INITIAL_SYNC_LIMIT = 200;
const CONCURRENCY = 8;

type Header = { name?: string | null; value?: string | null };

function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: number | string; response?: { status?: number } };
  return e.response?.status ?? (e.code !== undefined ? Number(e.code) : undefined);
}

function header(headers: Header[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function parseFrom(raw?: string): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  return { name: null, email: raw.trim() };
}

function parseDate(msg: gmail_v1.Schema$Message): Date {
  if (msg.internalDate) return new Date(Number(msg.internalDate));
  const d = header(msg.payload?.headers ?? undefined, "Date");
  const parsed = d ? new Date(d) : new Date();
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

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

function metadataToRow(accountId: number, msg: gmail_v1.Schema$Message) {
  const headers = msg.payload?.headers ?? undefined;
  const from = parseFrom(header(headers, "From"));
  const labelIds = msg.labelIds ?? [];
  return {
    accountId,
    gmailId: msg.id!,
    threadId: msg.threadId ?? msg.id!,
    fromName: from.name,
    fromEmail: from.email,
    toHeader: header(headers, "To") ?? null,
    subject: header(headers, "Subject") ?? null,
    snippet: msg.snippet ?? null,
    date: parseDate(msg),
    unread: labelIds.includes("UNREAD"),
    labelIds,
  };
}

async function fetchAndUpsert(gmail: gmail_v1.Gmail, accountId: number, ids: string[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await mapLimit(ids, CONCURRENCY, async (id) => {
    try {
      const { data } = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      return metadataToRow(accountId, data);
    } catch (err) {
      if (httpStatus(err) === 404) return null; // deleted between list and get
      throw err;
    }
  });
  const valid = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  if (valid.length === 0) return [];
  const inserted = await db
    .insert(messages)
    .values(valid)
    .onConflictDoUpdate({
      target: [messages.accountId, messages.gmailId],
      set: {
        unread: sql`excluded.unread`,
        labelIds: sql`excluded.label_ids`,
        snippet: sql`excluded.snippet`,
        subject: sql`excluded.subject`,
      },
    })
    .returning({ id: messages.id });
  return inserted.map((r) => r.id);
}

async function fullSync(gmail: gmail_v1.Gmail, account: Account) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < INITIAL_SYNC_LIMIT) {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      maxResults: Math.min(100, INITIAL_SYNC_LIMIT - ids.length),
      pageToken,
    });
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  const { data: profile } = await gmail.users.getProfile({ userId: "me" });
  const addedIds = await fetchAndUpsert(gmail, account.id, ids);
  return { added: addedIds.length, addedIds, historyId: profile.historyId ?? null, mode: "full" as const };
}

async function incrementalSync(gmail: gmail_v1.Gmail, account: Account, startHistoryId: string) {
  const addedIds = new Set<string>();
  const removedIds = new Set<string>();
  const unreadChanges = new Map<string, boolean>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  do {
    const { data } = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      labelId: "INBOX",
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      pageToken,
    });
    if (data.historyId) latestHistoryId = data.historyId;
    for (const h of data.history ?? []) {
      for (const a of h.messagesAdded ?? []) if (a.message?.id) addedIds.add(a.message.id);
      for (const d of h.messagesDeleted ?? []) if (d.message?.id) removedIds.add(d.message.id);
      for (const l of h.labelsAdded ?? []) {
        const id = l.message?.id;
        if (!id) continue;
        if (l.labelIds?.includes("UNREAD")) unreadChanges.set(id, true);
        if (l.labelIds?.includes("INBOX")) addedIds.add(id);
      }
      for (const l of h.labelsRemoved ?? []) {
        const id = l.message?.id;
        if (!id) continue;
        if (l.labelIds?.includes("UNREAD")) unreadChanges.set(id, false);
        if (l.labelIds?.includes("INBOX")) removedIds.add(id); // archived: no longer in inbox
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const id of removedIds) addedIds.delete(id);

  if (removedIds.size > 0) {
    await db
      .delete(messages)
      .where(and(eq(messages.accountId, account.id), inArray(messages.gmailId, [...removedIds])));
  }
  for (const [gmailId, unread] of unreadChanges) {
    if (addedIds.has(gmailId) || removedIds.has(gmailId)) continue;
    await db
      .update(messages)
      .set({ unread })
      .where(and(eq(messages.accountId, account.id), eq(messages.gmailId, gmailId)));
  }
  const upsertedIds = await fetchAndUpsert(gmail, account.id, [...addedIds]);
  return { added: upsertedIds.length, addedIds: upsertedIds, historyId: latestHistoryId, mode: "incremental" as const };
}

export async function syncAccount(account: Account) {
  const gmail = gmailFor(account);
  let result;
  if (account.historyId) {
    try {
      result = await incrementalSync(gmail, account, account.historyId);
    } catch (err) {
      // 404 = historyId expired; Gmail requires a full resync.
      if (httpStatus(err) !== 404) throw err;
      result = await fullSync(gmail, account);
    }
  } else {
    result = await fullSync(gmail, account);
  }
  await db
    .update(accounts)
    .set({ historyId: result.historyId, lastSyncedAt: new Date() })
    .where(eq(accounts.id, account.id));
  return { email: account.email, ...result };
}

// ---------- Body fetching ----------

function decodeBody(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type Parsed = { html: string | null; text: string | null; attachments: AttachmentMeta[] };

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: Parsed) {
  if (!part) return;
  const mime = part.mimeType ?? "";
  const filename = part.filename ?? "";
  if (filename && part.body?.attachmentId) {
    acc.attachments.push({
      attachmentId: part.body.attachmentId,
      filename,
      mimeType: mime,
      size: part.body.size ?? 0,
    });
    return;
  }
  if (mime === "text/html" && part.body?.data && acc.html === null) {
    acc.html = decodeBody(part.body.data);
  } else if (mime === "text/plain" && part.body?.data && acc.text === null) {
    acc.text = decodeBody(part.body.data);
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img", "h1", "h2", "center", "font", "u", "s", "del", "ins", "span", "style",
  ]),
  allowedAttributes: {
    "*": ["style", "class", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing", "dir"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto", "data", "cid"],
  allowedSchemesByTag: { img: ["https", "data"] }, // block http/tracking-by-protocol; https images still load
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
  },
  // Strip 1x1 tracking pixels
  exclusiveFilter: (frame) =>
    frame.tag === "img" &&
    ((frame.attribs.width === "1" && frame.attribs.height === "1") ||
      /width\s*:\s*1px/.test(frame.attribs.style ?? "")),
};

export async function fetchMessageBody(account: Account, gmailId: string) {
  const gmail = gmailFor(account);
  const { data } = await gmail.users.messages.get({ userId: "me", id: gmailId, format: "full" });
  const acc: Parsed = { html: null, text: null, attachments: [] };
  walkParts(data.payload, acc);
  const bodyHtml = acc.html ? sanitizeHtml(acc.html, SANITIZE) : null;
  await db
    .update(messages)
    .set({ bodyHtml, bodyText: acc.text, attachments: acc.attachments, bodyFetchedAt: new Date() })
    .where(and(eq(messages.accountId, account.id), eq(messages.gmailId, gmailId)));
  return { bodyHtml, bodyText: acc.text, attachments: acc.attachments };
}

export async function fetchAttachment(account: Account, gmailId: string, attachmentId: string) {
  const gmail = gmailFor(account);
  const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId: gmailId, id: attachmentId });
  return Buffer.from((data.data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export const ACCOUNT_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];
