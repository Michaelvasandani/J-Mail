import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { accounts, db, messageTriage, messages } from "@/db";
import { fetchMessageBody } from "@/lib/gmail";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const msgId = Number(id);
  if (!Number.isInteger(msgId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const row = await db.query.messages.findFirst({ where: eq(messages.id, msgId) });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, row.accountId) });
  if (!account) return NextResponse.json({ error: "account missing" }, { status: 404 });

  const triage = (await db.query.messageTriage.findFirst({ where: eq(messageTriage.messageId, row.id) })) ?? null;

  let body = { bodyHtml: row.bodyHtml, bodyText: row.bodyText, attachments: row.attachments };
  if (!row.bodyFetchedAt) body = await fetchMessageBody(account, row.gmailId);

  return NextResponse.json({
    id: row.id,
    accountEmail: account.email,
    accountColor: account.color,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    toHeader: row.toHeader,
    subject: row.subject,
    date: row.date,
    unread: row.unread,
    triage,
    ...body,
  });
}
