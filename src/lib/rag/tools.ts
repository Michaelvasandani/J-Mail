import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { and, desc, asc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { accounts, db, messages, messageTriage } from "@/db";
import { fetchMessageBody } from "@/lib/gmail";
import { CATEGORIES, CATEGORY_KEYS, FLAG_COLUMNS, FLAG_THRESHOLD, JOB_OUTCOMES, type Flag } from "@/lib/triage";
import { bodyForIndex, decodeEntities } from "./chunk";
import { searchInbox } from "./search";

/**
 * Tools Claude can call while answering an inbox question.
 *
 *   list_emails    structured query over headers + triage labels (counts, "latest", time windows)
 *   search_emails  hybrid semantic search over email content (what did X say about Y)
 *   read_email     full cleaned body of one email
 *
 * Every tool returns `search_result` blocks so Claude's answer can cite emails by id.
 */

export type EmailMeta = {
  id: number;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  date: string;
  accountEmail: string;
  accountColor: string;
  category?: string | null;
  jobOutcome?: string | null;
};

export type ToolEvents = {
  /** Called with every email a tool surfaced, so the UI can render citation chips. */
  onEmails(emails: EmailMeta[]): void;
};

const MAX_LIST = 50;
const MAX_BODY_CHARS = 12_000;

export function emailSource(id: number) {
  return `email:${id}`;
}
export function parseEmailSource(source: string): number | null {
  const m = /^email:(\d+)$/.exec(source);
  return m ? Number(m[1]) : null;
}

function title(m: { fromName: string | null; fromEmail: string | null; subject: string | null; date: Date }) {
  const from = m.fromName ?? m.fromEmail ?? "unknown";
  return `${from}: ${decodeEntities(m.subject ?? "(no subject)")} (${m.date.toISOString().slice(0, 10)})`;
}

function searchResult(id: number, t: string, paragraphs: string[]): Anthropic.Beta.BetaSearchResultBlockParam {
  const content = paragraphs.filter((p) => p.trim()).map((p) => ({ type: "text" as const, text: p }));
  return { type: "search_result", source: emailSource(id), title: t, content: content.length ? content : [{ type: "text", text: "(empty)" }], citations: { enabled: true } };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "ISO date, e.g. 2026-09-15").describe("ISO date (inclusive lower bound / exclusive upper bound)");

export function makeTools(events: ToolEvents) {
  const listEmails = betaZodTool({
    name: "list_emails",
    description:
      "Query the inbox by metadata: sender, subject, date range, account, triage category, job-application outcome, flags. Use this for counting, for 'latest'/'most recent'/'last' questions, for time windows ('last 3 days', 'this month'), and for anything a label answers (job applications, bills, calendar invites). Returns matching emails newest-first with headers and a preview, plus the total match count.",
    inputSchema: z.object({
      account: z.string().optional().describe("Restrict to one account's email address"),
      category: z.enum(CATEGORY_KEYS as [string, ...string[]]).optional().describe("Triage category"),
      job_outcome: z.enum(Object.keys(JOB_OUTCOMES) as [string, ...string[]]).optional().describe("Only with category=job_update"),
      from: z.string().optional().describe("Substring of sender name or address, case-insensitive"),
      subject_contains: z.string().optional().describe("Substring of subject, case-insensitive"),
      after: isoDate.optional(),
      before: isoDate.optional(),
      unread: z.boolean().optional(),
      flags: z.array(z.enum(Object.keys(FLAG_COLUMNS) as [string, ...string[]])).optional().describe("All listed flags must be set: needs_reply, has_deadline, money_owed, from_human"),
      sort: z.enum(["newest", "oldest"]).default("newest"),
      limit: z.number().int().min(1).max(MAX_LIST).default(20),
    }),
    run: async (input) => {
      const conds: SQL[] = [];
      if (input.account) conds.push(ilike(accounts.email, input.account));
      if (input.category) conds.push(eq(messageTriage.category, input.category));
      if (input.job_outcome) conds.push(eq(messageTriage.jobOutcome, input.job_outcome));
      if (input.from) {
        const pat = `%${input.from}%`;
        conds.push(or(ilike(messages.fromName, pat), ilike(messages.fromEmail, pat))!);
      }
      if (input.subject_contains) conds.push(ilike(messages.subject, `%${input.subject_contains}%`));
      if (input.after) conds.push(gte(messages.date, new Date(input.after)));
      if (input.before) conds.push(lt(messages.date, new Date(input.before)));
      if (input.unread !== undefined) conds.push(eq(messages.unread, input.unread));
      for (const f of input.flags ?? []) conds.push(gte(FLAG_COLUMNS[f as Flag], FLAG_THRESHOLD));
      const where = conds.length ? and(...conds) : undefined;

      const base = db
        .select({
          id: messages.id,
          fromName: messages.fromName,
          fromEmail: messages.fromEmail,
          subject: messages.subject,
          snippet: messages.snippet,
          date: messages.date,
          unread: messages.unread,
          accountEmail: accounts.email,
          accountColor: accounts.color,
          category: messageTriage.category,
          jobOutcome: messageTriage.jobOutcome,
          needsReply: messageTriage.needsReply,
          hasDeadline: messageTriage.hasDeadline,
          moneyOwed: messageTriage.moneyOwed,
        })
        .from(messages)
        .innerJoin(accounts, eq(accounts.id, messages.accountId))
        .leftJoin(messageTriage, eq(messageTriage.messageId, messages.id))
        .where(where);
      const [rows, [{ total }]] = await Promise.all([
        base.orderBy(input.sort === "oldest" ? asc(messages.date) : desc(messages.date)).limit(input.limit),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(messages)
          .innerJoin(accounts, eq(accounts.id, messages.accountId))
          .leftJoin(messageTriage, eq(messageTriage.messageId, messages.id))
          .where(where),
      ]);

      events.onEmails(rows.map((r) => ({ ...r, date: r.date.toISOString() })));
      const summary = `${total} matching email${total === 1 ? "" : "s"}${total > rows.length ? ` (showing ${rows.length}, ${input.sort} first)` : ""}.`;
      const results = rows.map((r) => {
        const flags = [r.needsReply != null && r.needsReply >= FLAG_THRESHOLD && "needs_reply", r.hasDeadline != null && r.hasDeadline >= FLAG_THRESHOLD && "has_deadline", r.moneyOwed != null && r.moneyOwed >= FLAG_THRESHOLD && "money_owed"].filter(Boolean);
        const header = [
          `Email id: ${r.id}`,
          `Account: ${r.accountEmail}`,
          `From: ${r.fromName ?? ""} <${r.fromEmail ?? ""}>`,
          `Date: ${r.date.toISOString()}`,
          `Subject: ${decodeEntities(r.subject ?? "(no subject)")}`,
          `Category: ${r.category ?? "unlabeled"}${r.jobOutcome ? ` / ${r.jobOutcome}` : ""}${flags.length ? ` / ${flags.join(", ")}` : ""}${r.unread ? " / unread" : ""}`,
        ].join("\n");
        return searchResult(r.id, title(r), [header, `Preview: ${decodeEntities(r.snippet ?? "")}`]);
      });
      // A tool_result may not mix text and search_result blocks, and citations must be on for all of them,
      // so the summary is a search_result too; its source is not an email id, so the UI never renders it as a chip.
      const summaryBlock: Anthropic.Beta.BetaSearchResultBlockParam = {
        type: "search_result",
        source: "summary:list_emails",
        title: "Query summary",
        content: [{ type: "text", text: summary }],
        citations: { enabled: true },
      };
      return [summaryBlock, ...results];
    },
  });

  const searchEmails = betaZodTool({
    name: "search_emails",
    description:
      "Semantic + keyword search over the full text of emails. Use this for questions about what an email says (details, amounts, names, instructions, what someone asked). Returns the most relevant emails with the matching passages. Not suitable for counting or for 'most recent' questions; use list_emails for those.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language description of what to find"),
      account: z.string().optional().describe("Restrict to one account's email address"),
      after: isoDate.optional(),
      before: isoDate.optional(),
      limit: z.number().int().min(1).max(12).default(8),
    }),
    run: async (input) => {
      let accountId: number | null = null;
      if (input.account) {
        const [a] = await db.select({ id: accounts.id }).from(accounts).where(ilike(accounts.email, input.account));
        accountId = a?.id ?? -1;
      }
      const hits = await searchInbox(input.query, { accountId, after: input.after ? new Date(input.after) : null, before: input.before ? new Date(input.before) : null }, input.limit);
      events.onEmails(hits.map((h) => ({ id: h.messageId, subject: h.subject, fromName: h.fromName, fromEmail: h.fromEmail, date: h.date.toISOString(), accountEmail: h.accountEmail, accountColor: h.accountColor })));
      if (hits.length === 0) return "No emails matched.";
      return hits.map((h) =>
        searchResult(h.messageId, title({ ...h }), [`Email id: ${h.messageId}`, ...h.chunks.flatMap((c) => c.content.split(/\n\n+/))]),
      );
    },
  });

  const readEmail = betaZodTool({
    name: "read_email",
    description: "Read the full text of one email by its id (from list_emails or search_emails). Use when the preview or passages are not enough.",
    inputSchema: z.object({ id: z.number().int() }),
    run: async ({ id }) => {
      const [m] = await db
        .select({ msg: messages, account: accounts })
        .from(messages)
        .innerJoin(accounts, eq(accounts.id, messages.accountId))
        .where(eq(messages.id, id));
      if (!m) return `No email with id ${id}.`;
      let { bodyText, bodyHtml } = m.msg;
      if (!m.msg.bodyFetchedAt) {
        const b = await fetchMessageBody(m.account, m.msg.gmailId);
        bodyText = b.bodyText;
        bodyHtml = b.bodyHtml;
      }
      const body = bodyForIndex({ bodyText, bodyHtml, snippet: m.msg.snippet }).slice(0, MAX_BODY_CHARS);
      events.onEmails([{ id, subject: m.msg.subject, fromName: m.msg.fromName, fromEmail: m.msg.fromEmail, date: m.msg.date.toISOString(), accountEmail: m.account.email, accountColor: m.account.color }]);
      const header = `Email id: ${id}\nAccount: ${m.account.email}\nFrom: ${m.msg.fromName ?? ""} <${m.msg.fromEmail ?? ""}>\nTo: ${m.msg.toHeader ?? ""}\nDate: ${m.msg.date.toISOString()}\nSubject: ${decodeEntities(m.msg.subject ?? "")}`;
      return [searchResult(id, title(m.msg), [header, ...body.split(/\n\n+/)])];
    },
  });

  return [listEmails, searchEmails, readEmail];
}

/** Vocabulary for the system prompt so Claude picks the right labels. */
export function labelGuide(): string {
  const cats = Object.entries(CATEGORIES).map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : v.what}`);
  const outs = Object.entries(JOB_OUTCOMES).map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : v.what}`);
  return `Triage categories (list_emails.category):\n${cats.join("\n")}\n\nJob outcomes (list_emails.job_outcome, only meaningful with category=job_update):\n${outs.join("\n")}\n\nFlags: needs_reply, has_deadline, money_owed, from_human. Labels come from an AI triage pass at sync time and can be missing on very new mail (category "unlabeled"); when a count matters, cross-check with a sender or subject filter.`;
}
