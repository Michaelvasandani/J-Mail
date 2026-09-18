import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { accounts, db, messages } from "@/db";
import { fetchAttachment } from "@/lib/gmail";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await ctx.params;
  const row = await db.query.messages.findFirst({ where: eq(messages.id, Number(id)) });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const meta = row.attachments.find((a) => a.attachmentId === attachmentId);
  if (!meta) return NextResponse.json({ error: "attachment not found" }, { status: 404 });
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, row.accountId) });
  if (!account) return NextResponse.json({ error: "account missing" }, { status: 404 });

  const buf = await fetchAttachment(account, row.gmailId, attachmentId);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": meta.mimeType || "application/octet-stream",
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="${meta.filename.replace(/"/g, "")}"`,
    },
  });
}
