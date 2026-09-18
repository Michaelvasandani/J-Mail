import { google } from "googleapis";
import { decrypt } from "./crypto";
import type { Account } from "@/db";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be set");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

export function authUrl(state: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token to be returned every time
    scope: GMAIL_SCOPES,
    state,
  });
}

/** Gmail API client for a stored account. Access tokens are refreshed automatically. */
export function gmailFor(account: Pick<Account, "refreshTokenEnc">) {
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: decrypt(account.refreshTokenEnc) });
  return google.gmail({ version: "v1", auth });
}
