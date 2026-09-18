/**
 * Turn an email into one or more self-describing text chunks for embedding.
 *
 * Strategy: one chunk per email, each prefixed with a metadata header (account, sender, date,
 * subject, category). Only bodies longer than MAX_BODY_CHARS are split, on paragraph boundaries,
 * and every piece repeats the header so it stays meaningful on its own.
 */

// ~1500 tokens of body per chunk; comfortably under the 4K-token Ollama context after the header.
const MAX_BODY_CHARS = 6000;
const MIN_TAIL_CHARS = 800; // don't leave a tiny trailing chunk; merge it into the previous one
const MAX_CHUNKS_PER_MESSAGE = 6; // newsletters can be enormous; the tail is rarely useful

export type ChunkSource = {
  accountEmail: string;
  fromName: string | null;
  fromEmail: string | null;
  toHeader: string | null;
  subject: string | null;
  snippet: string | null;
  date: Date;
  bodyText: string | null;
  bodyHtml: string | null;
  category?: string | null;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Strip HTML to readable text, keeping paragraph breaks and link targets out of the way. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<(td|th)[^>]*>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s;
}

/** Remove quoted replies, forwarded headers and signatures; collapse whitespace. */
export function cleanBody(text: string): string {
  let s = text.replace(/\r\n?/g, "\n");
  // Zero-width and non-breaking spaces common in marketing mail.
  s = s.replace(/[\u200b\u200c\u200d\u200e\u200f\u2060\u034f\ufeff]/g, "").replace(/\u00a0/g, " ");
  // Cut at the first quoted-reply marker; the earlier message is indexed on its own row.
  const cut = s.search(
    /^(On .{5,200} wrote:|From: .+\n(Sent|Date): .+|-{3,} ?(Original|Forwarded) message ?-{3,}|_{5,}\s*$|> )/m,
  );
  if (cut > 200) s = s.slice(0, cut);
  // Signature delimiter.
  const sig = s.search(/^-- ?$/m);
  if (sig > 200) s = s.slice(0, sig);
  // Bare URLs add tokens, not meaning. Keep the host so "the link from stripe.com" still works.
  s = s.replace(/https?:\/\/([^\s/]+)[^\s)>\]]*/g, (_, host: string) => host);
  const lines = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const kept: string[] = [];
  let prev = "";
  for (const l of lines) {
    if (isNoiseLine(l)) continue;
    if (l && l === prev) continue; // repeated boilerplate lines
    kept.push(l);
    prev = l;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Lines that carry no meaning once URLs are reduced to hosts: bare hostnames, rules, decorations.
const HOST_ONLY = /^[\w-]+(\.[\w-]+)+\/?$/;
function isNoiseLine(l: string) {
  if (!l) return false;
  if (HOST_ONLY.test(l)) return true;
  if (/^[\s=\-_*~#.|:•·]{3,}$/.test(l)) return true; // ===== ----- ..... rules
  return false;
}

/** Plain-text alternatives of marketing mail are often just link lists; measure how much real prose is left. */
function proseRatio(text: string): number {
  const words = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return words / Math.max(1, text.length / 6);
}

export function bodyForIndex(src: Pick<ChunkSource, "bodyText" | "bodyHtml" | "snippet">): string {
  const fromText = src.bodyText?.trim() ? cleanBody(src.bodyText) : "";
  const fromHtml = src.bodyHtml ? cleanBody(htmlToText(src.bodyHtml)) : "";
  // Prefer the text/plain part, unless it is a stub (short, or mostly link chrome) and the HTML has more to say.
  let cleaned = fromText;
  if (fromHtml && (fromText.length < 200 || (proseRatio(fromText) < 0.5 && fromHtml.length > fromText.length))) cleaned = fromHtml;
  return cleaned || decodeEntities(src.snippet ?? "");
}

export function headerFor(src: ChunkSource): string {
  const from = src.fromName && src.fromEmail ? `${src.fromName} <${src.fromEmail}>` : src.fromEmail ?? src.fromName ?? "unknown";
  const lines = [
    `Account: ${src.accountEmail}`,
    `From: ${from}`,
    src.toHeader ? `To: ${src.toHeader}` : null,
    `Date: ${src.date.toISOString().slice(0, 10)} (${src.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })})`,
    `Subject: ${decodeEntities(src.subject ?? "(no subject)")}`,
    src.category ? `Category: ${src.category.replace(/_/g, " ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function splitParagraphs(body: string, max: number): string[] {
  if (body.length <= max) return [body];
  const paras = body.split(/\n\n+/);
  const pieces: string[] = [];
  let cur = "";
  for (let p of paras) {
    // A single paragraph longer than max: hard-split on sentence-ish boundaries.
    while (p.length > max) {
      let at = p.lastIndexOf(". ", max);
      if (at < max / 2) at = p.lastIndexOf(" ", max);
      if (at < max / 2) at = max;
      if (cur) {
        pieces.push(cur);
        cur = "";
      }
      pieces.push(p.slice(0, at + 1).trim());
      p = p.slice(at + 1).trim();
    }
    if (!p) continue;
    if (cur.length + p.length + 2 > max) {
      pieces.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) pieces.push(cur);
  if (pieces.length > 1 && pieces[pieces.length - 1].length < MIN_TAIL_CHARS) {
    const tail = pieces.pop()!;
    pieces[pieces.length - 1] += `\n\n${tail}`;
  }
  return pieces;
}

export type Chunk = { index: number; content: string };

export function chunkMessage(src: ChunkSource): Chunk[] {
  const header = headerFor(src);
  const body = bodyForIndex(src);
  const pieces = splitParagraphs(body, MAX_BODY_CHARS).slice(0, MAX_CHUNKS_PER_MESSAGE);
  return pieces.map((piece, index) => ({
    index,
    content: pieces.length > 1 ? `${header}\nPart: ${index + 1} of ${pieces.length}\n\n${piece}` : `${header}\n\n${piece}`,
  }));
}
