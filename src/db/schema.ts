import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  // AES-256-GCM encrypted Google refresh token (see src/lib/crypto.ts)
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  // Gmail historyId at last successful sync; enables incremental sync
  historyId: text("history_id"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  color: text("color").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AttachmentMeta = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    gmailId: text("gmail_id").notNull(),
    threadId: text("thread_id").notNull(),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    toHeader: text("to_header"),
    subject: text("subject"),
    snippet: text("snippet"),
    date: timestamp("date", { withTimezone: true }).notNull(),
    unread: boolean("unread").notNull().default(false),
    labelIds: text("label_ids").array().notNull().default([]),
    // Body is fetched lazily on first open and cached here.
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    bodyFetchedAt: timestamp("body_fetched_at", { withTimezone: true }),
    attachments: jsonb("attachments").$type<AttachmentMeta[]>().notNull().default([]),
    // Future: embedding vector(1536) for semantic search (pgvector extension is enabled).
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_account_gmail_idx").on(t.accountId, t.gmailId),
    index("messages_date_idx").on(t.date),
    index("messages_account_date_idx").on(t.accountId, t.date),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type Message = typeof messages.$inferSelect;
