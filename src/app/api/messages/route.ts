import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { accounts, db, messages } from "@/db";

const PAGE = 50;

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  const accountId = p.get("account") ? Number(p.get("account")) : null;
  const q = p.get("q")?.trim() ?? "";
  const before = p.get("before"); // ISO date cursor
  const unreadOnly = p.get("unread") === "1";

  const conds = [];
  if (accountId) conds.push(eq(messages.accountId, accountId));
  if (unreadOnly) conds.push(eq(messages.unread, true));
  if (before) conds.push(lt(messages.date, new Date(before)));
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
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(messages.date), desc(messages.id))
    .limit(PAGE + 1);

  const hasMore = rows.length > PAGE;
  const page = hasMore ? rows.slice(0, PAGE) : rows;
  return NextResponse.json({
    messages: page,
    nextBefore: hasMore ? page[page.length - 1].date : null,
  });
}
