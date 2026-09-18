import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authUrl } from "@/lib/google";

export async function GET() {
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set("oauth_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
