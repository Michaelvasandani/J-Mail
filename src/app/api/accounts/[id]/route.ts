import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { accounts, db } from "@/db";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const accountId = Number(id);
  if (!Number.isInteger(accountId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  await db.delete(accounts).where(eq(accounts.id, accountId)); // messages cascade
  return NextResponse.json({ ok: true });
}
