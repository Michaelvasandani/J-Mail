import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { accounts, db, messageTriage, messages } from "@/db";
import { CATEGORY_KEYS, FLAG_COLUMNS, FLAG_THRESHOLD, JOB_OUTCOMES, type Category, type Flag, type JobOutcome } from "@/lib/triage";

const PAGE = 50;

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  const accountId = p.get("account") ? Number(p.get("account")) : null;
  const q = p.get("q")?.trim() ?? "";
  const before = p.get("before"); // ISO date cursor
  const unreadOnly = p.get("unread") === "1";
  const category = p.get("category"); // a Category key, or "untriaged"
  const outcome = p.get("outcome"); // a JobOutcome key; implies category=job_update
  const flags = p.getAll("flag").filter((f): f is Flag => f in FLAG_COLUMNS);

  const conds = [];
  if (accountId) conds.push(eq(messages.accountId, accountId));
  if (unreadOnly) conds.push(eq(messages.unread, true));
  if (before) conds.push(lt(messages.date, new Date(before)));
  if (category === "untriaged") conds.push(isNull(messageTriage.messageId));
  else if (category && (CATEGORY_KEYS as string[]).includes(category)) {
    conds.push(eq(messageTriage.category, category as Category));
  }
  if (outcome && outcome in JOB_OUTCOMES) conds.push(eq(messageTriage.jobOutcome, outcome as JobOutcome));
  for (const f of flags) conds.push(gte(FLAG_COLUMNS[f], FLAG_THRESHOLD));
  if (q) {
    const pat = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
    conds.push(
      or(
        ilike(messages.subject, pat),
        ilike(messages.fromName, pat),
        ilike(messages.fromEmail, pat),
        ilike(messages.snippet, pat),
        ilike(messages.bodyText, pat),
        sql`regexp_replace(coalesce(${messages.bodyHtml}, ''), '<[^>]*>', ' ', 'g') ILIKE ${pat}`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      accountEmail: accounts.email,
      accountColor: accounts.color,
      gmailId: messages.gmailId,
      fromName: messages.fromName,
      fromEmail: messages.fromEmail,
      subject: messages.subject,
      snippet: messages.snippet,
      date: messages.date,
      unread: messages.unread,
      triage: {
        category: messageTriage.category,
        categoryConfidence: messageTriage.categoryConfidence,
        jobOutcome: messageTriage.jobOutcome,
        needsReply: messageTriage.needsReply,
        hasDeadline: messageTriage.hasDeadline,
        fromHuman: messageTriage.fromHuman,
        moneyOwed: messageTriage.moneyOwed,
      },
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageTriage, eq(messageTriage.messageId, messages.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(messages.date), desc(messages.id))
    .limit(PAGE + 1);

  const hasMore = rows.length > PAGE;
  const page = hasMore ? rows.slice(0, PAGE) : rows;
  return NextResponse.json({
    // A left join yields a triage object with all-null fields when there is no row; collapse it to null.
    messages: page.map((r) => ({ ...r, triage: r.triage?.category ? r.triage : null })),
    nextBefore: hasMore ? page[page.length - 1].date : null,
  });
}
