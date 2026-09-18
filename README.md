# J-Mail

A minimal, **read-only** unified inbox for multiple Gmail accounts. Runs locally.

- Connect any number of Gmail accounts via Google OAuth (readonly scope only, so it cannot send, delete or modify mail).
- One list of all inbox messages across accounts, newest first, with a colored badge per account.
- Incremental sync after the first pull.
- Full message view (sanitized HTML, tracking pixels stripped), attachment download, text search.
- Postgres with pgvector, so semantic search can be added later without changing stores.
- **AI triage on sync** via [TypeSafe](https://docs.typesafe.ai) (Jev): every synced message gets a category (newsletter, promotion, transactional, subscription, job update with outcome, job board, calendar, personal, work/school, social, security, spam, other) plus flags for needs-reply, deadline, payment due, and from-a-person. Filter by any of them in the sidebar.

## Stack

Next.js (App Router) · Drizzle ORM · Postgres 16 + pgvector (Docker) · googleapis · @typesafe-ai/sdk

## Setup

### 1. Google Cloud OAuth client (one time)

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → fill in app name and your email. Under **Scopes** add `https://www.googleapis.com/auth/gmail.readonly`. Under **Test users** add every Gmail address you want to connect.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Web application.
   Authorized redirect URI: `http://localhost:3000/api/auth/google/callback`
5. Copy the client ID and secret.

> While the consent screen is in *Testing* mode, refresh tokens expire after 7 days and you will need to re-add accounts. Click **Publish app** to make tokens permanent. No Google verification is needed for a personal-use readonly app; users just see an "unverified app" warning once.

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and set `TOKEN_ENCRYPTION_KEY` to the output of `openssl rand -hex 32`.

Optionally set `TYPESAFE_API_KEY` (from <https://typesafe.ai>) to enable inbox triage. Without it, sync works normally and no labels are produced.

### 3. Database

```bash
npm run db:up      # starts Postgres + pgvector on localhost:5433
npm run db:push    # creates the tables
```

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>, click **Add Gmail account**, sign in, repeat for each account. Hit **Sync** any time to pull new mail.

## Notes

- Refresh tokens are AES-256-GCM encrypted at rest with `TOKEN_ENCRYPTION_KEY`.
- Only the INBOX label is synced. First sync pulls the 200 most recent messages per account; later syncs use Gmail's history API.
- Message bodies are fetched on first open and cached.
- `npm run db:studio` opens Drizzle Studio to inspect the database.

## Triage

Triage runs inside **Sync**: each new message (plus up to 200 not-yet-labeled older ones per sync) is sent to Jev as one request with all questions asked together, and the answers are stored in `message_triage`:

| Question | Primitive | Stored as |
| --- | --- | --- |
| Which category best describes this email? | Choice (13 options incl. `other`) | `category`, `category_confidence`, full distribution in `probabilities` |
| If it is a job update, what is the outcome? | Choice (speculative; read only when category is `job_update`) | `job_outcome`, `job_outcome_confidence` |
| Does the sender expect a reply? | Noul | `needs_reply` (0..1) |
| Is there a specific deadline? | Noul | `has_deadline` (0..1) |
| Written by an individual person? | Noul | `from_human` (0..1) |
| Does the recipient owe money? | Noul | `money_owed` (0..1) |

Only headers and the Gmail snippet are sent (bodies are not fetched at sync time), plus the recipient address and Gmail tab hints. Questions and category definitions live in `src/lib/triage.ts`; flag thresholds and the low-confidence cutoff are code constants, so you can tune them without re-running inference. After editing the questions, re-label everything with:

```bash
curl -X POST 'http://localhost:3000/api/triage?reset=1'
```
