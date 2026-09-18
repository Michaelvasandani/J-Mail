# J-Mail

A minimal, **read-only** unified inbox for multiple Gmail accounts. Runs locally.

- Connect any number of Gmail accounts via Google OAuth (readonly scope only, so it cannot send, delete or modify mail).
- One list of all inbox messages across accounts, newest first, with a colored badge per account.
- Incremental sync after the first pull.
- Full message view (sanitized HTML, tracking pixels stripped), attachment download, text search.
- Postgres with pgvector, so semantic search can be added later without changing stores.

## Stack

Next.js (App Router) · Drizzle ORM · Postgres 16 + pgvector (Docker) · googleapis

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
