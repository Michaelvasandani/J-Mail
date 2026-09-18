import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { accounts, db } from "@/db";
import { encrypt } from "@/lib/crypto";
import { oauthClient } from "@/lib/google";
import { ACCOUNT_COLORS } from "@/lib/gmail";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const home = new URL("/", req.url);

  if (error) return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, req.url));
  if (!code || !state || state !== req.cookies.get("oauth_state")?.value) {
    return NextResponse.redirect(new URL("/?error=invalid_state", req.url));
  }

  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: client });
  const { data: profile } = await gmail.users.getProfile({ userId: "me" });
  const email = profile.emailAddress;
  if (!email) return NextResponse.redirect(new URL("/?error=no_email", req.url));

  const existing = await db.query.accounts.findFirst({ where: eq(accounts.email, email) });
  const refreshToken = tokens.refresh_token;

  if (existing) {
    if (refreshToken) {
      await db.update(accounts).set({ refreshTokenEnc: encrypt(refreshToken) }).where(eq(accounts.id, existing.id));
    }
  } else {
    if (!refreshToken) return NextResponse.redirect(new URL("/?error=no_refresh_token", req.url));
    const count = (await db.select({ id: accounts.id }).from(accounts)).length;
    await db.insert(accounts).values({
      email,
      refreshTokenEnc: encrypt(refreshToken),
      color: ACCOUNT_COLORS[count % ACCOUNT_COLORS.length],
    });
  }

  const res = NextResponse.redirect(new URL("/?added=" + encodeURIComponent(email), home));
  res.cookies.delete("oauth_state");
  return res;
}
