import { eq, inArray, isNull, sql } from "drizzle-orm";
import { choice, noul, TypeSafeClient, type ChoiceCriteria } from "@typesafe-ai/sdk";
import { accounts, db, messageTriage, messages } from "@/db";

/**
 * Inbox triage with TypeSafe's Jev (a System One model).
 *
 * One request per message, every question asked together over the same state.
 * Jev returns typed answers with probabilities; this module stores them as-is.
 * All policy (thresholds, what counts as "needs attention") lives in code and
 * can change without re-running inference.
 */

const CONCURRENCY = 8;
const BACKFILL_LIMIT = 200; // untriaged messages picked up per sync, on top of newly synced ones

// ---------- Categories (Choice) ----------

export const CATEGORIES = {
  newsletter: {
    what: "Editorial or informational content sent on a schedule to a list the recipient subscribed to: digests, blog posts, curated links, community updates",
    not_for: "Sales or discount emails (promotion); billing notices (subscription_billing)",
  },
  promotion: {
    what: "Marketing that tries to sell: discounts, sales, product launches, coupons, 'limited time' offers, abandoned-cart nudges",
    not_for: "Receipts or shipping updates for something already bought (transactional)",
  },
  transactional: {
    what: "Automated confirmation of a one-time action or purchase: single-order receipts, order and shipping updates, booking confirmations, delivery notices, verification codes",
    not_for: "Anything about a recurring plan, membership, or subscription, including its receipts and renewals (subscription_billing); login or password alerts (security_alert)",
  },
  subscription_billing: {
    what: "Anything about a recurring plan, membership, or subscription: receipts and invoices for a recurring charge (monthly, yearly), renewal reminders, subscription confirmed, payment failed, card expiring, plan or price changes, trial ending, cancellation confirmations",
    not_for: "One-time purchase receipts with no recurring plan (transactional)",
    examples: ["Your payment receipt from Lenny's Newsletter", "Receipt for Academy Unlimited Access (Monthly)", "Your Subscription is Confirmed"],
  },
  job_update: {
    what: "A message about a specific job or internship application or hiring process the recipient is personally in, or a real recruiter or hiring manager personally contacting the recipient: application received, interview scheduling, assessments, take-home tasks, offers, rejections, applicant tracking system notifications",
    not_for: "Automated job recommendations, job alerts, 'apply now' nudges, profile tips, or onboarding emails from job boards such as LinkedIn, Jobright, Indeed, Glassdoor, Simplify, Handshake (job_board)",
  },
  job_board: {
    what: "Automated emails from a job board or job-search platform (LinkedIn, Jobright, Indeed, Glassdoor, Simplify, Handshake, ZipRecruiter, Wellfound): job alerts, recommended or matching jobs, 'X is hiring', 'apply now', saved-job reminders, profile or resume tips, welcome and onboarding emails",
    not_for: "A named recruiter or hiring manager writing personally to the recipient, even through LinkedIn (job_update); updates about an application the recipient already submitted (job_update)",
    examples: ["Michael, apply now to 'AI Software Engineer Intern at SemiAI'", "Parth and 2,700+ others are hiring for Software Engineer roles", "Welcome to Jobright!", "Your profile is set to private"],
  },
  calendar_event: {
    what: "A meeting or event invitation, RSVP, reminder, reschedule, or cancellation for a specific date and time",
    not_for: "Interview scheduling for a job application (job_update)",
  },
  personal: {
    what: "A real person writing directly to the recipient about non-work, non-school matters: friends, family, acquaintances, personal favors",
    not_for: "Messages from coworkers, classmates, professors, or administrators (work_school)",
  },
  work_school: {
    what: "A person or office writing about the recipient's job, courses, research, or institution: professors, teaching assistants, classmates, coworkers, department or registrar announcements, assignment and grade notices",
    not_for: "Hiring for a new job (job_update); personal matters (personal)",
  },
  social_notification: {
    what: "Automated activity notifications from a platform: new follower, mention, comment, connection request, pull request activity, workspace digest, 'X posted in Y'",
    not_for: "A person writing directly (personal or work_school)",
  },
  security_alert: {
    what: "Account security: new sign-in, new device, password reset, suspicious activity, two-factor changes, permission grants",
    not_for: "One-time verification codes requested during a normal login (transactional)",
  },
  spam_phishing: {
    what: "Unsolicited junk, scams, or messages impersonating a company to steal credentials or money; unexpected prizes, urgent account threats from unknown senders, mismatched sender domains",
    not_for: "Legitimate marketing from a company the recipient plausibly has a relationship with (promotion)",
  },
  other: "None of the other categories describes this message",
} satisfies ChoiceCriteria;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];

// ---------- Job outcome (Choice, speculative: only read when category === job_update) ----------

export const JOB_OUTCOMES = {
  interview_or_next_step: "The recipient is invited to an interview, phone screen, assessment, or any further stage in the process",
  offer: "The recipient is being offered the position, or offer details and paperwork are being discussed",
  rejection: "The recipient is told they were not selected, the position is filled, or they will not move forward",
  application_received: "Only confirms that an application was received or is under review; no decision yet",
  action_needed: "The recipient must do something to continue: complete a form, provide documents, confirm availability, sign, or reply by a date",
  recruiter_outreach: {
    what: "A named recruiter, hiring manager, or founder personally writes to the recipient about a specific opportunity the recipient has not applied to; this can arrive through LinkedIn or email",
    not_for: "Automated job alerts, recommended jobs, or 'apply now' emails generated by a job board (answer `other`)",
  },
  other: "A job-related message that fits none of the above, or this is not a job-related message",
} satisfies ChoiceCriteria;

export type JobOutcome = keyof typeof JOB_OUTCOMES;

// ---------- Questions ----------

export const TRIAGE_QUESTIONS = {
  category: choice(
    {
      question: "Which one category best describes this email?",
      guidance:
        "Judge from `sender`, `subject`, `preview`, and `gmail_hints`. `recipient` is the account owner reading the email. Pick the single best fit; use `other` when nothing fits.",
    },
    CATEGORIES,
  ),
  job_outcome: choice(
    {
      question: "If this email is about a job or internship the recipient applied to or is being recruited for, what is its outcome for the recipient?",
      guidance: "If the email is not job-related, answer `other`.",
    },
    JOB_OUTCOMES,
  ),
  needs_reply: noul("Does the sender expect a reply from the recipient?", {
    true: "The email asks the recipient a question, requests a decision, or asks them to respond, confirm, or schedule something",
    false: "Purely informational, automated, or a no-reply broadcast; no response is expected",
  }),
  has_deadline: noul("Does this email mention a specific deadline or time-limited action the recipient must take?", {
    true: "Names a date, time, or window by which the recipient must act (for example 'reply by Friday', 'expires in 24 hours', 'RSVP by June 3')",
    false: "No date-bound action is required of the recipient; generic urgency words alone do not count",
  }),
  from_human: noul("Was this email written and sent by an individual person rather than generated by an automated system?", {
    true: "A specific person composed it and addressed the recipient; conversational tone, personal sender name, individual signature",
    false: "Sent by a system, platform, marketing tool, or no-reply address; templated or bulk content",
  }),
  money_owed: noul("Does this email say the recipient owes money, will be charged, or has a payment that failed?", {
    true: "An amount is due, a charge is upcoming or failed, an invoice is attached, or a payment method needs updating",
    false: "No money is requested from the recipient; receipts for completed payments and promotional prices do not count",
  }),
};

// ---------- State ----------

type TriageInput = {
  id: number;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  labelIds: string[];
  accountEmail: string;
};

const HINT_LABELS: Record<string, string> = {
  CATEGORY_PROMOTIONS: "Gmail placed this in the Promotions tab",
  CATEGORY_SOCIAL: "Gmail placed this in the Social tab",
  CATEGORY_UPDATES: "Gmail placed this in the Updates tab",
  CATEGORY_FORUMS: "Gmail placed this in the Forums tab",
  CATEGORY_PERSONAL: "Gmail placed this in the Primary tab",
  IMPORTANT: "Gmail marked this as important",
  SPAM: "Gmail marked this as spam",
};

// Gmail snippets are HTML-escaped; give the model plain text.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function buildState(m: TriageInput) {
  const hints = m.labelIds.map((l) => HINT_LABELS[l]).filter(Boolean);
  return {
    recipient: m.accountEmail,
    sender: { name: m.fromName ?? "", email: m.fromEmail ?? "" },
    subject: decodeEntities(m.subject ?? ""),
    preview: decodeEntities(m.snippet ?? ""),
    gmail_hints: hints.length ? hints : ["none"],
  };
}

// ---------- Client ----------

let client: TypeSafeClient | null | undefined;
function getClient(): TypeSafeClient | null {
  if (client !== undefined) return client;
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    client = null;
    console.warn("[triage] TYPESAFE_API_KEY not set; skipping inbox triage.");
  } else {
    client = new TypeSafeClient({ timeout: 20_000 });
  }
  return client;
}

export function triageEnabled() {
  return getClient() !== null;
}

// ---------- Inference ----------

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function triageOne(ts: TypeSafeClient, m: TriageInput) {
  const { answers, model } = await ts.systemOne({ state: buildState(m), questions: TRIAGE_QUESTIONS });
  const category = answers.category.choice as Category;
  // job_outcome is speculative: only meaningful when the category says this is a job update.
  const isJob = category === "job_update";
  return {
    messageId: m.id,
    category,
    categoryConfidence: answers.category.confidence,
    jobOutcome: isJob ? (answers.job_outcome.choice as JobOutcome) : null,
    jobOutcomeConfidence: isJob ? answers.job_outcome.confidence : null,
    needsReply: answers.needs_reply.noul,
    hasDeadline: answers.has_deadline.noul,
    fromHuman: answers.from_human.noul,
    moneyOwed: answers.money_owed.noul,
    probabilities: {
      category: { ...answers.category.probabilities },
      job_outcome: { ...answers.job_outcome.probabilities },
    },
    model,
  };
}

/** Triage the given message ids (plus a bounded backfill of anything still untriaged). Returns count stored. */
export async function triageMessages(ids: number[]): Promise<{ triaged: number; failed: number }> {
  const ts = getClient();
  if (!ts) return { triaged: 0, failed: 0 };

  const wanted = new Set(ids);
  if (wanted.size < BACKFILL_LIMIT) {
    const backlog = await db
      .select({ id: messages.id })
      .from(messages)
      .leftJoin(messageTriage, eq(messageTriage.messageId, messages.id))
      .where(isNull(messageTriage.messageId))
      .orderBy(sql`${messages.date} desc`)
      .limit(BACKFILL_LIMIT - wanted.size);
    for (const b of backlog) wanted.add(b.id);
  }
  if (wanted.size === 0) return { triaged: 0, failed: 0 };

  const rows = await db
    .select({
      id: messages.id,
      fromName: messages.fromName,
      fromEmail: messages.fromEmail,
      subject: messages.subject,
      snippet: messages.snippet,
      labelIds: messages.labelIds,
      accountEmail: accounts.email,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(inArray(messages.id, [...wanted]));

  let failed = 0;
  const results = await mapLimit(rows, CONCURRENCY, async (m) => {
    try {
      return await triageOne(ts, m);
    } catch (err) {
      failed++;
      console.error(`[triage] message ${m.id} failed:`, (err as Error)?.message ?? err);
      return null;
    }
  });
  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (valid.length === 0) return { triaged: 0, failed };

  await db
    .insert(messageTriage)
    .values(valid)
    .onConflictDoUpdate({
      target: messageTriage.messageId,
      set: {
        category: sql`excluded.category`,
        categoryConfidence: sql`excluded.category_confidence`,
        jobOutcome: sql`excluded.job_outcome`,
        jobOutcomeConfidence: sql`excluded.job_outcome_confidence`,
        needsReply: sql`excluded.needs_reply`,
        hasDeadline: sql`excluded.has_deadline`,
        fromHuman: sql`excluded.from_human`,
        moneyOwed: sql`excluded.money_owed`,
        probabilities: sql`excluded.probabilities`,
        model: sql`excluded.model`,
        triagedAt: sql`now()`,
      },
    });
  return { triaged: valid.length, failed };
}

/** Drop all stored labels and re-run triage on the most recent messages (e.g. after questions change). */
export async function retriageAll(): Promise<{ triaged: number; failed: number }> {
  await db.delete(messageTriage);
  return triageMessages([]);
}

// ---------- Policy (thresholds) ----------
// Evaluated on stored probabilities; change freely without re-running inference.

export const FLAG_THRESHOLD = 0.6;
export const LOW_CONFIDENCE = 0.35;

export type Flag = "needs_reply" | "has_deadline" | "from_human" | "money_owed";
export const FLAG_COLUMNS = {
  needs_reply: messageTriage.needsReply,
  has_deadline: messageTriage.hasDeadline,
  from_human: messageTriage.fromHuman,
  money_owed: messageTriage.moneyOwed,
} as const;
