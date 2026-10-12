// Relève de la boîte de contact des gîtes (Gmail dédié, IMAP) — décision de Julien du
// 11/10/2026 : tous les messages reviennent dans la plateforme, avec leur origine.
//
// Le client IMAP (node/imap.mjs, node:tls) est injecté dans env.IMAP_FETCH par
// node/server.mjs. Sur Cloudflare Workers (pas de socket sortante) la relève est
// désactivée et le dit clairement. La boîte n'est JAMAIS modifiée (EXAMINE) : le
// curseur est un UID gardé ici (app_settings), avec UIDVALIDITY.
//
// Chaque mail devient une ligne de `messages` (channel 'email') : rattachée à la
// réservation (référence dans le sujet, sinon réponse à l'un de nos mails, sinon
// l'adresse de l'expéditeur = client d'une réservation, la plus proche dans le
// temps), sinon fil « sans réservation ». Idempotent par Message-ID.
//
// Jamais d'accusé de réception automatique sur ce chemin : seule une personne répond,
// depuis Messages.

import { sqlNow, todayInZone } from "../core/dates";
import {
  audit,
  bookingsForGuest,
  getBooking,
  getBookingByReference,
  insertInboundMessage,
  listProperties,
  type BookingRow,
} from "../db/repo";
import { extractMessageIds, parseRawEmail, type ParsedEmail } from "./inbound-email";
import { getSetting, setSetting } from "./settings";

export const MAILBOX_STATE_KEY = "mailbox_imap_state";
/** Premier passage (ou boîte reconstruite) : on remonte de 14 jours, pas plus. */
const FIRST_SINCE_DAYS = 14;
/** Mails au plus par appel IMAP, et appels au plus par relève (le reste au passage suivant). */
const BATCH = 40;
const MAX_BATCHES = 3;
const MAX_MAIL_BYTES = 512 * 1024;

export interface MailboxState {
  uidValidity?: number | null;
  lastUid?: number | null;
  at?: string;
  imported?: number;
  error?: string | null;
  disabled?: string | null;
}

export interface MailboxResult {
  ran: boolean;
  /** Pourquoi la relève n'a pas eu lieu (non configurée, Workers, déjà en cours). */
  reason?: string;
  fetched: number;
  imported: number;
  duplicates: number;
  linked: number;
  more: boolean;
  error?: string;
}

export const NO_SOCKET_MESSAGE =
  "Relève de la boîte désactivée : cette instance (Cloudflare Workers) n'ouvre pas de socket IMAP. Elle tourne sur le site Node (Infomaniak).";

/** La relève est-elle configurée (utilisateur et mot de passe posés) ? */
export function mailboxConfigured(env: Env): boolean {
  return (env.IMAP_USER ?? "").trim() !== "" && (env.IMAP_PASSWORD || env.SMTP_PASSWORD || "") !== "";
}

export async function getMailboxState(db: D1Database): Promise<MailboxState> {
  try {
    return JSON.parse((await getSetting(db, MAILBOX_STATE_KEY)) ?? "{}") as MailboxState;
  } catch {
    return {};
  }
}

function bareAddress(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase();
}

/** Adresses « des gîtes » : celles qu'un tiers ne doit pas pouvoir se donner. */
export async function ownAddresses(db: D1Database, env: Env): Promise<Set<string>> {
  const out = new Set<string>();
  if (env.IMAP_USER) out.add(env.IMAP_USER.trim().toLowerCase());
  if (env.MAIL_FROM) out.add(bareAddress(env.MAIL_FROM));
  for (const p of await listProperties(db)) {
    if (p.contactEmail) out.add(p.contactEmail.trim().toLowerCase());
  }
  out.delete("");
  return out;
}

/** Le mail prétend venir de l'adresse des gîtes sans que le serveur de réception l'atteste. */
export function isSpoofed(parsed: Pick<ParsedEmail, "from" | "senderAuthenticated">, own: Set<string>): boolean {
  return own.has(parsed.from.toLowerCase()) && !parsed.senderAuthenticated;
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Réservation la plus proche dans le temps (séjour en cours = 0), non annulée de préférence. */
export function closestBooking(bookings: BookingRow[], today: string): BookingRow | null {
  const live = bookings.filter((b) => b.status !== "cancelled");
  const pool = live.length ? live : bookings;
  let best: BookingRow | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const b of pool) {
    const inside = b.checkin <= today && today <= b.checkout;
    const score = inside ? 0 : Math.min(dayDiff(b.checkin, today), dayDiff(b.checkout, today));
    // à égalité, le séjour le plus tardif (à venir avant passé)
    if (score < bestScore || (score === bestScore && best && b.checkin > best.checkin)) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

export interface MailLink {
  booking: BookingRow | null;
  guestId: number | null;
  via: "reference" | "fil" | "adresse" | null;
}

/** Rattache un mail : référence PM-2026-001 > réponse à l'un de nos messages > adresse de l'expéditeur. */
export async function linkMail(db: D1Database, parsed: ParsedEmail, today: string): Promise<MailLink> {
  const refMatch = /\b([A-Z]{2}-\d{4}-\d{3,})\b/.exec(`${parsed.subject} ${parsed.textBody}`);
  if (refMatch) {
    const booking = await getBookingByReference(db, refMatch[1]!);
    if (booking) return { booking, guestId: booking.guestId, via: "reference" };
  }
  const ids = [...extractMessageIds(parsed.inReplyTo), ...extractMessageIds(parsed.references)].slice(0, 25);
  if (ids.length) {
    const row = await db
      .prepare(
        `SELECT booking_id, guest_id FROM messages
          WHERE message_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
            AND (booking_id IS NOT NULL OR guest_id IS NOT NULL)
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(...ids)
      .first<{ booking_id: number | null; guest_id: number | null }>();
    if (row) {
      const booking = row.booking_id ? await getBooking(db, row.booking_id) : null;
      return { booking, guestId: booking?.guestId ?? row.guest_id, via: "fil" };
    }
  }
  if (parsed.from) {
    const guest = await db
      .prepare("SELECT id FROM guests WHERE lower(email) = ?1 ORDER BY id LIMIT 1")
      .bind(parsed.from.toLowerCase())
      .first<{ id: number }>();
    if (guest) {
      const booking = closestBooking(await bookingsForGuest(db, guest.id), today);
      return { booking, guestId: guest.id, via: "adresse" };
    }
  }
  return { booking: null, guestId: null, via: null };
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/** Enregistre un mail relevé. true s'il est nouveau, false si déjà connu (même Message-ID). */
export async function ingestMail(
  db: D1Database,
  env: Env,
  mail: { uid: number; raw: string; size: number; truncated: boolean },
  uidValidity: number,
  own: Set<string>,
  now: Date,
): Promise<{ inserted: boolean; linked: boolean }> {
  let parsed: ParsedEmail;
  try {
    parsed = parseRawEmail(mail.raw, { binary: true, truncated: mail.truncated });
  } catch {
    // un mail illisible reste visible : il ne bloque pas le curseur et ne disparaît pas en silence
    parsed = {
      messageId: null, from: "inconnu", fromName: null, to: null, subject: "(message illisible)",
      textBody: "", isAutoGenerated: false, attachments: [], truncated: mail.truncated,
    };
  }
  const today = todayInZone(now);
  const link = await linkMail(db, parsed, today);
  const properties = await listProperties(db);
  const dest = [parsed.deliveredTo, parsed.to].filter(Boolean).map((a) => a!.toLowerCase());
  const property =
    properties.find((p) => link.booking?.propertyId === p.id) ??
    properties.find((p) => p.contactEmail && dest.includes(p.contactEmail.toLowerCase())) ??
    properties[0];

  let body = parsed.textBody;
  if (!body) body = parsed.attachments?.length ? "(message sans texte, avec pièce jointe)" : "(message vide)";
  if (mail.truncated) body += `\n\n[Message volumineux (${formatSize(mail.size)}) : seul le début a été relevé, les pièces jointes ne sont pas gardées.]`;

  const dateMs = parsed.date ? Date.parse(parsed.date) : Number.NaN;
  const limitFuture = now.getTime() + 86_400_000;
  const receivedAt = sqlNow(Number.isNaN(dateMs) || dateMs > limitFuture ? now : new Date(dateMs));
  const messageId = parsed.messageId ?? `<imap-${uidValidity}-${mail.uid}@boite.local>`;

  const id = await insertInboundMessage(db, {
    propertyId: property?.id ?? 1,
    messageId,
    channel: "email",
    fromEmail: parsed.from || "inconnu",
    fromName: parsed.fromName,
    toEmail: parsed.to,
    subject: parsed.subject || "(sans objet)",
    bodyText: body,
    bookingId: link.booking?.id ?? null,
    guestId: link.guestId,
    receivedAt,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    imapUid: mail.uid,
    attachments: parsed.attachments ?? [],
    spoofed: isSpoofed(parsed, own),
  });
  return { inserted: id !== null, linked: link.booking != null };
}

// Bail en base (et non un drapeau en mémoire) : deux instances du site, ou un cron et le
// minuteur, ne relèvent jamais en même temps ; un plantage laisse un bail qui expire seul.
export const MAILBOX_LEASE_KEY = "mailbox_imap_lease";
const LEASE_MINUTES = 5;

/** Prend le bail ; rend sa valeur (échéance|jeton) si on l'a, null sinon. Seul son propriétaire le libère. */
async function acquireLease(db: D1Database, now: Date): Promise<string | null> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const until = `${new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString()}|${token}`;
  const res = await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        WHERE app_settings.value < ?3`,
    )
    .bind(MAILBOX_LEASE_KEY, until, now.toISOString())
    .run();
  return res.meta.changes === 1 ? until : null;
}

async function releaseLease(db: D1Database, lease: string): Promise<void> {
  // seulement si le bail est encore le nôtre : une relève lente ne libère pas celui d'une autre
  await db
    .prepare("UPDATE app_settings SET value = '' WHERE key = ?1 AND value = ?2")
    .bind(MAILBOX_LEASE_KEY, lease)
    .run()
    .catch(() => undefined);
}

/** Écrit l'état en gardant le curseur monotone : à UIDVALIDITY égale, lastUid ne recule jamais. */
async function saveState(db: D1Database, patch: MailboxState): Promise<MailboxState> {
  const cur = await getMailboxState(db);
  let lastUid = patch.lastUid ?? null;
  if (cur.uidValidity != null && cur.uidValidity === patch.uidValidity && (cur.lastUid ?? 0) > (lastUid ?? 0)) lastUid = cur.lastUid ?? null;
  const next = { ...cur, ...patch, lastUid };
  await setSetting(db, MAILBOX_STATE_KEY, JSON.stringify(next));
  return next;
}

/** La relève du cron (et du bouton « Relever maintenant »). Ne lève jamais : tout est dans le résultat. */
export async function pullMailbox(env: Env, now: Date = new Date()): Promise<MailboxResult> {
  const db = env.DB;
  const result: MailboxResult = { ran: false, fetched: 0, imported: 0, duplicates: 0, linked: 0, more: false };
  if (!mailboxConfigured(env)) {
    result.reason = "Relève non configurée (IMAP_USER et IMAP_PASSWORD, ou SMTP_PASSWORD).";
    return result;
  }
  let state = await getMailboxState(db);
  if (!env.IMAP_FETCH) {
    result.reason = NO_SOCKET_MESSAGE;
    if (state.disabled !== NO_SOCKET_MESSAGE) {
      await setSetting(db, MAILBOX_STATE_KEY, JSON.stringify({ ...state, disabled: NO_SOCKET_MESSAGE, at: now.toISOString() }));
      await audit(db, "cron", "mailbox.imap.disabled", undefined, { reason: NO_SOCKET_MESSAGE });
    }
    return result;
  }
  const lease = await acquireLease(db, now);
  if (!lease) {
    result.reason = "Une relève est déjà en cours.";
    return result;
  }
  result.ran = true;
  try {
    const own = await ownAddresses(db, env);
    let uidValidity = state.uidValidity ?? null;
    let lastUid = state.lastUid ?? null;
    for (let batchNo = 0; batchNo < MAX_BATCHES; batchNo += 1) {
      const batch = await env.IMAP_FETCH({
        uidValidity, lastUid, sinceDays: FIRST_SINCE_DAYS, max: BATCH, maxBytes: MAX_MAIL_BYTES,
      });
      if (uidValidity !== batch.uidValidity) {
        // boîte reconstruite : les anciens UID ne veulent plus rien dire ; le Message-ID évite les doublons
        uidValidity = batch.uidValidity;
        lastUid = null;
      }
      result.fetched += batch.mails.length;
      let done = lastUid;
      try {
        for (const mail of [...batch.mails].sort((a, b) => a.uid - b.uid)) {
          const r = await ingestMail(db, env, mail, batch.uidValidity, own, now);
          if (r.inserted) result.imported += 1;
          else result.duplicates += 1;
          if (r.linked) result.linked += 1;
          done = mail.uid;
        }
        if (batch.highestUid != null && (done == null || batch.highestUid > done)) done = batch.highestUid;
      } finally {
        // le curseur n'avance que jusqu'au dernier mail réellement enregistré
        lastUid = done;
        state = await saveState(db, { uidValidity, lastUid, at: now.toISOString(), error: null, disabled: null, imported: result.imported });
        lastUid = state.lastUid ?? lastUid;
      }
      result.more = batch.more;
      if (!batch.more) break;
    }
    if (result.imported > 0) {
      await audit(db, "cron", "mailbox.imap", undefined, {
        imported: result.imported, linked: result.linked, duplicates: result.duplicates, more: result.more,
      });
    }
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    result.error = message;
    // une même panne ne remplit pas le journal toutes les 10 minutes
    if (state.error !== message) {
      await audit(db, "cron", "mailbox.imap.error", undefined, { error: message });
    }
    await saveState(db, { ...state, error: message, at: now.toISOString() }).catch(() => undefined);
  } finally {
    await releaseLease(db, lease);
  }
  return result;
}
