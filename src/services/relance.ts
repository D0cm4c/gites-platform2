// Relance des réservations abandonnées (issue #37, volet a).
//
// Un visiteur remplit le formulaire, son créneau est bloqué 30 minutes, puis il
// n'achève pas le paiement. Sans un mot, il est perdu — alors qu'on a son
// e-mail et, parfois, son consentement explicite pour être recontacté.
//
// TROIS PIÈGES, tous encodés ici :
//
// 1. « Réservation en attente dont le hold a expiré » n'existe presque jamais
//    en base. Le cron `expireStaleHolds` passe toutes les 15 minutes et bascule
//    ces résas en `cancelled` avec `cancel_reason = 'hold_expired'`. Chercher
//    uniquement `status = 'pending'` ne trouverait donc quasi rien — et la
//    fonctionnalité aurait l'air de marcher (aucune erreur, aucun envoi). La
//    requête couvre les DEUX états.
//
// 2. Sans consentement, pas de relance. Un e-mail donné pour recevoir une
//    confirmation de réservation n'est pas un e-mail donné pour recevoir de la
//    prospection. La case d'opt-in est distincte, non pré-cochée, horodatée, et
//    c'est elle seule qui ouvre le droit à ce message.
//
// 3. Ne jamais relancer sur un créneau qui n'est plus libre. Inviter quelqu'un
//    à « reprendre sa réservation » pour des dates entre-temps vendues est une
//    promesse qu'on ne peut pas tenir : la disponibilité est revérifiée juste
//    avant l'envoi, exactement comme le fait la recherche publique.
//
// Dédoublonnage : `email_log`, pas de table nouvelle. Une relance déjà
// journalisée pour cette réservation interdit la suivante — « jamais plus
// d'une relance par personne et par séjour » se lit directement dans le
// journal des envois.

import { sqlNow, type IsoDate } from "../core/dates";
import { blocksAsSpans, isUnitFree, type BookingSpan, type UnitLink } from "../core/availability";
import {
  audit,
  bookingsInWindow,
  getProperty,
  hasEmailOfKind,
  listLinks,
  manualBlocksInWindow,
  type PropertyRow,
} from "../db/repo";
import { formatDateFr, queueEmail, refSubject } from "./email";

/** Délai après l'expiration du blocage avant d'envoyer la relance (issue : « proposer 24 h »). */
export const ABANDON_DELAY_HOURS = 24;
/** Au-delà, on ne relance plus : un abandon d'il y a trois semaines n'est plus
 *  une hésitation, c'est un renoncement. */
export const ABANDON_MAX_AGE_DAYS = 7;
/** Type d'envoi dans email_log — c'est la clé du dédoublonnage. */
export const ABANDON_KIND = "abandon_reminder";

export interface AbandonedBooking {
  id: number;
  reference: string;
  unitId: number;
  unitSlug: string;
  unitName: string;
  propertyId: number;
  propertySlug: string;
  guestFirstName: string | null;
  guestEmail: string;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  holdExpiresAt: string;
}

interface Raw {
  [key: string]: unknown;
}

/** Réservations directes abandonnées, éligibles à une relance.
 *
 *  Le filtre de CONSENTEMENT est dans le SQL et non dans le code appelant : il
 *  ne doit pas pouvoir être oublié par une refonte de la boucle d'envoi. */
export async function listAbandonedBookings(
  db: D1Database,
  opts: { now?: Date } = {},
): Promise<AbandonedBooking[]> {
  const now = opts.now ?? new Date();
  const notAfter = sqlNow(new Date(now.getTime() - ABANDON_DELAY_HOURS * 3_600_000));
  const notBefore = sqlNow(new Date(now.getTime() - ABANDON_MAX_AGE_DAYS * 86_400_000));
  const today = sqlNow(now).slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT b.id, b.reference, b.unit_id, b.checkin, b.checkout, b.adults, b.children,
              b.hold_expires_at, u.slug AS unit_slug, u.name AS unit_name,
              u.property_id AS property_id, p.slug AS property_slug,
              g.first_name AS guest_first_name, g.email AS guest_email
         FROM bookings b
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
         JOIN guests g ON g.id = b.guest_id
        WHERE b.source = 'direct'
          AND b.paid_cents = 0
          AND b.hold_expires_at IS NOT NULL
          AND b.hold_expires_at <= ?1
          AND b.hold_expires_at >= ?2
          AND b.checkin > ?3
          AND g.email IS NOT NULL
          AND g.marketing_opt_in = 1
          AND (
                b.status = 'cancelled' AND b.cancel_reason = 'hold_expired'
             OR b.status = 'pending'
          )
          AND NOT EXISTS (
                SELECT 1 FROM bookings c
                 WHERE c.guest_id = b.guest_id AND c.status = 'confirmed'
                   AND c.checkin = b.checkin AND c.checkout = b.checkout
          )
        ORDER BY b.hold_expires_at`,
    )
    .bind(notAfter, notBefore, today)
    .all();

  return (results as Raw[]).map((r) => ({
    id: Number(r.id),
    reference: String(r.reference),
    unitId: Number(r.unit_id),
    unitSlug: String(r.unit_slug),
    unitName: String(r.unit_name),
    propertyId: Number(r.property_id),
    propertySlug: String(r.property_slug),
    guestFirstName: r.guest_first_name == null ? null : String(r.guest_first_name),
    guestEmail: String(r.guest_email),
    checkin: String(r.checkin),
    checkout: String(r.checkout),
    adults: Number(r.adults),
    children: Number(r.children),
    holdExpiresAt: String(r.hold_expires_at),
  }));
}

/** Lien de reprise : le tunnel sait déjà se rouvrir sur des dates données
 *  (`?property=&checkin=&checkout=&adults=&children=&unit=`). On ne renvoie pas
 *  vers l'ancienne session de paiement : son blocage a expiré, elle répondrait
 *  410 et donnerait au client l'impression d'un lien cassé. */
export function resumeUrl(base: string, b: AbandonedBooking): string {
  const q = new URLSearchParams({
    property: b.propertySlug,
    checkin: b.checkin,
    checkout: b.checkout,
    adults: String(b.adults),
    unit: b.unitSlug,
  });
  if (b.children > 0) q.set("children", String(b.children));
  return `${base}/book/?${q.toString()}`;
}

/** Message de relance — sobre, une seule fois, sans urgence fabriquée.
 *
 *  Ce que le texte NE dit pas est aussi important que ce qu'il dit : pas de
 *  compte à rebours, pas de « dernières disponibilités », pas de remise
 *  d'appoint inventée pour l'occasion. La ligne éditoriale du propriétaire vaut
 *  pour les e-mails comme pour le site. */
export function buildAbandonReminderEmail(
  b: AbandonedBooking,
  property: PropertyRow,
  url: string,
): { subject: string; bodyText: string } {
  const bonjour = b.guestFirstName ? `Bonjour ${b.guestFirstName},` : "Bonjour,";
  return {
    subject: refSubject(b.reference, `Votre réservation en cours — ${b.unitName} du ${formatDateFr(b.checkin)} (${property.name})`),
    bodyText: [
      bonjour,
      ``,
      `Vous avez commencé une réservation pour ${b.unitName} du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)}, sans aller jusqu'au paiement.`,
      ``,
      `Le blocage de 30 minutes a pris fin, mais ces dates sont encore libres au moment où nous vous écrivons. Si vous souhaitez reprendre, tout est prérempli ici :`,
      ``,
      url,
      ``,
      `Si vous avez changé d'avis, il n'y a rien à faire : c'est notre seul message à ce sujet.`,
      ``,
      `Une question, une date à ajuster ? Répondez simplement à cet e-mail.`,
      ``,
      `À bientôt,`,
      `${property.name}`,
      property.contactEmail ? `${property.contactEmail}` : ``,
    ].join("\n"),
  };
}

export interface AbandonRunResult {
  /** Relances effectivement journalisées (ou envoyées si les envois sont actifs). */
  sent: number;
  /** Candidates écartées au dernier moment : déjà relancées, ou créneau repris. */
  skipped: number;
}

/** Passe de relance — appelée par le cron. Idempotente : un second passage
 *  dans la même journée ne renvoie rien, `email_log` faisant foi. */
export async function runAbandonedReminders(env: Env, now: Date = new Date()): Promise<AbandonRunResult> {
  const db = env.DB;
  const candidates = await listAbandonedBookings(db, { now });
  const result: AbandonRunResult = { sent: 0, skipped: 0 };
  if (candidates.length === 0) return result;

  const nowSql = sqlNow(now);
  // Les liaisons d'un domaine ne changent pas pendant la passe : une lecture
  // par domaine suffit. Les réservations, elles, se relisent par séjour — la
  // fenêtre diffère d'une candidate à l'autre.
  const linksByProperty = new Map<number, UnitLink[]>();

  for (const b of candidates) {
    if (await hasEmailOfKind(db, b.id, ABANDON_KIND)) {
      result.skipped += 1;
      continue;
    }
    if (!linksByProperty.has(b.propertyId)) {
      linksByProperty.set(b.propertyId, await listLinks(db, b.propertyId));
    }
    // Un blocage manuel posé depuis l'abandon rend le créneau invendable : on
    // ne relance pas sur des dates qu'on a soi-même fermées (issue #74).
    const spans: BookingSpan[] = [
      ...(await bookingsInWindow(db, b.propertyId, b.checkin, b.checkout))
        .filter((r) => r.id !== b.id) // sa propre trace ne doit pas la bloquer
        .map((r) => ({
          unitId: r.unitId,
          checkin: r.checkin,
          checkout: r.checkout,
          status: r.status,
          holdExpiresAt: r.holdExpiresAt,
        })),
      ...blocksAsSpans(await manualBlocksInWindow(db, b.propertyId, b.checkin, b.checkout)),
    ];
    const free = isUnitFree(b.unitId, b.checkin, b.checkout, spans, linksByProperty.get(b.propertyId) ?? [], nowSql);
    if (!free) {
      result.skipped += 1;
      continue;
    }

    const property = await getProperty(db, b.propertyId);
    if (!property) {
      result.skipped += 1;
      continue;
    }
    const email = buildAbandonReminderEmail(b, property, resumeUrl(env.PUBLIC_BASE_URL, b));
    await queueEmail(db, env, {
      bookingId: b.id,
      to: b.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      kind: ABANDON_KIND,
    });
    await audit(db, "cron", "email.abandon_reminder", `booking:${b.id}`, { reference: b.reference });
    result.sent += 1;
  }
  return result;
}
