import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  vector,
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
    // Set when the message has been chunked + embedded into message_chunks (see src/lib/rag/indexer.ts).
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_account_gmail_idx").on(t.accountId, t.gmailId),
    index("messages_date_idx").on(t.date),
    index("messages_account_date_idx").on(t.accountId, t.date),
  ],
);

// Triage labels produced by TypeSafe (Jev) at sync time. See src/lib/triage.ts.
// The option keys are defined once in the triage module and stored as text here.
export const messageTriage = pgTable(
  "message_triage",
  {
    messageId: integer("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    // Choice: what kind of message this is (newsletter, transactional, job_update, ...)
    category: text("category").notNull(),
    categoryConfidence: real("category_confidence").notNull(),
    // Choice: only meaningful when category === "job_update"; null otherwise.
    jobOutcome: text("job_outcome"),
    jobOutcomeConfidence: real("job_outcome_confidence"),
    // Nouls: probability (0..1) that each condition holds. Thresholds live in code.
    needsReply: real("needs_reply").notNull(),
    hasDeadline: real("has_deadline").notNull(),
    fromHuman: real("from_human").notNull(),
    moneyOwed: real("money_owed").notNull(),
    // Full per-option probability distributions so policy can change without re-inference.
    probabilities: jsonb("probabilities").$type<Record<string, Record<string, number>>>().notNull(),
    model: text("model").notNull(),
    triagedAt: timestamp("triaged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_triage_category_idx").on(t.category)],
);

// Embedding vector size. Must match the model in src/lib/rag/embeddings.ts; changing it requires a re-index.
export const EMBEDDING_DIMENSIONS = 1024;

// One row per chunk of a message: metadata header + (part of) the cleaned body, embedded for semantic
// search, plus a tsvector for keyword search. A message owns 1..n chunks. See src/lib/rag/chunk.ts.
export const messageChunks = pgTable(
  "message_chunks",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    // The exact text that was embedded (header + body slice).
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_chunks_message_idx").on(t.messageId, t.chunkIndex),
    index("message_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("message_chunks_fts_idx").using("gin", sql`to_tsvector('english', ${t.content})`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageTriage = typeof messageTriage.$inferSelect;
export type MessageChunk = typeof messageChunks.$inferSelect;
