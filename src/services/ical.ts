// Synchronisation iCal — export de nos périodes occupées + import des flux
// externes (Airbnb pour le Moulin, phase 3). Parser maison minimal (RFC 5545 :
// dépliage des lignes, VALUE=DATE, DTEND exclusif — comme notre checkout).

import { addDays, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { blocksAsSpans, busySpans, isActiveBooking, mergeSpans } from "../core/availability";
import { icalScope } from "../core/sync-conflicts";
import { closeUnseenSyncConflicts, noteSyncConflict } from "./sync-conflicts";
import {
  audit,
  bookingsInWindow,
  cancelBooking,
  createBookingAtomic,
  getBookingByExternalUid,
  getManualBlockByExternalUid,
  listFeedBookings,
  moveManualBlockAtomic,
  listLinks,
  manualBlocksInWindow,
  reactivateBookingAtomic,
  setFeedStatus,
  updateBookingDatesAtomic,
  type FeedRow,
  type UnitRow,
} from "../db/repo";

// ---------------------------------------------------------------------------
// Export : /ical/<token>.ics — périodes occupées, blocages par liaison compris
// (si le Domaine entier est réservé, l'export de chaque maison est occupé).
// ---------------------------------------------------------------------------

export interface ExportSpan {
  checkin: IsoDate;
  checkout: IsoDate;
}

export function buildIcs(unitName: string, propertyName: string, spans: ExportSpan[], nowStamp: string): string {
  // RFC 5545 : fins de ligne CRLF. Nos lignes restent < 75 octets (pas de repli).
  const stamp = nowStamp.replace(/[-: ]/g, "").slice(0, 15) + "Z"; // 'YYYYMMDDTHHMMSSZ'
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gites Platform//Reservations//FR",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(`${unitName} — ${propertyName}`)}`,
  ];
  for (const s of spans) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.checkin.replaceAll("-", "")}-${s.checkout.replaceAll("-", "")}@gites-platform`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${s.checkin.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${s.checkout.replaceAll("-", "")}`,
      "SUMMARY:Réservé",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Périodes occupées d'une unité pour l'export (fenêtre glissante :
 *  30 j en arrière → 18 mois en avant), fusionnées. */
export async function exportSpansForUnit(db: D1Database, unit: UnitRow, now: Date): Promise<ExportSpan[]> {
  const today = todayInZone(now);
  const from = addDays(today, -30);
  const to = addDays(today, 540);
  const bookings = await bookingsInWindow(db, unit.propertyId, from, to);
  // Les blocages manuels (travaux, usage personnel) partent dans l'export au
  // même titre que les réservations : un canal externe qui ne les verrait pas
  // vendrait des nuits fermées (issue #74).
  const blocks = await manualBlocksInWindow(db, unit.propertyId, from, to);
  const links = await listLinks(db, unit.propertyId);
  const nowSql = sqlNow(now);
  const spans = busySpans(
    unit.id,
    [
      ...bookings.map((b) => ({
        unitId: b.unitId,
        checkin: b.checkin,
        checkout: b.checkout,
        status: b.status,
        holdExpiresAt: b.holdExpiresAt,
      })),
      ...blocksAsSpans(blocks),
    ],
    links,
    nowSql,
  );
  return mergeSpans(spans);
}

// ---------------------------------------------------------------------------
// Parse (import)
// ---------------------------------------------------------------------------

export interface IcsEvent {
  uid: string;
  dtstart: IsoDate;
  dtend: IsoDate;
  summary: string;
  /** DTEND donné en date entière (VALUE=DATE, exclusif), pas à l'heure. */
  allDay?: boolean;
}

/** Parse un calendrier iCal. Ne garde que les VEVENT complets (UID + dates).
 *  Les DTEND de type DATE sont exclusifs (RFC 5545) — même convention que
 *  notre checkout, aucun ajustement nécessaire. */
export function parseIcs(text: string): IcsEvent[] {
  // Dépliage : une ligne qui commence par espace/tab continue la précédente.
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.uid && current.dtstart && current.dtend && current.dtstart < current.dtend) {
        events.push({ uid: current.uid, dtstart: current.dtstart, dtend: current.dtend, summary: current.summary ?? "", allDay: current.allDay === true });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const rawName = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = rawName.split(";")[0]!.toUpperCase();
    if (name === "UID") current.uid = value.trim();
    if (name === "SUMMARY") current.summary = value.trim();
    if (name === "DTSTART") current.dtstart = parseIcsDate(value);
    if (name === "DTEND") {
      current.dtend = parseIcsDate(value);
      current.allDay = !/T\d{6}/.test(value.trim());
    }
  }
  return events;
}

/** Convention « jour de départ inclus » (agendas Google de papa, décision
 *  Julien 11/10/2026) : l'événement affiché du 22 au 26 (DTEND exclusif = 27)
 *  est un séjour du 22 au 26, départ le 26. On retire un jour au DTEND des
 *  événements « journée entière » ; un événement à l'heure donne déjà la bonne
 *  date. Un événement réduit à zéro nuit disparaît (pas un séjour). La
 *  plateforme, elle, reste à la norme partout (départ exclu). */
export function applyDepartureDayIncluded(events: IcsEvent[]): IcsEvent[] {
  const out: IcsEvent[] = [];
  for (const ev of events) {
    if (!ev.allDay) {
      out.push(ev);
      continue;
    }
    const dtend = addDays(ev.dtend, -1);
    if (dtend > ev.dtstart) out.push({ ...ev, dtend });
  }
  return out;
}

/** '20260810' → '2026-08-10' ; '20260810T140000Z' → la date de cet instant
    à Bruxelles (un '20261101T230000Z' Google est le 2 novembre à minuit chez
    nous, pas le 1er : lu en UTC, il chevauchait la réservation précédente —
    constaté le 10/10/2026 sur l'agenda Google de papa). Sans 'Z', l'heure
    est déjà locale : on garde la composante date. */
function parseIcsDate(value: string): IsoDate | undefined {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return undefined;
  if (m[7] === "Z") {
    const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    return todayInZone(utc);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// Synchronisation d'un flux entrant
// ---------------------------------------------------------------------------

/** Motifs d'annulation posés par l'import des agendas Google
 *  (src/services/agenda-import.ts) : la synchronisation ne rouvre pas ces
 *  réservations quand l'événement reste dans le flux. */
export const AGENDA_CANCEL_REASON = "agenda_annulee";
export const AGENDA_BLOCK_REASON = "agenda_blocage";
const STICKY_CANCEL_REASONS = new Set([AGENDA_CANCEL_REASON, AGENDA_BLOCK_REASON]);

export interface SyncResult {
  feedId: number;
  imported: number;
  updated: number;
  cancelled: number;
  /** Événements disparus du flux puis réapparus (annulation levée côté canal). */
  reactivated: number;
  conflicts: string[];
  /** Conflits d'un passage précédent qui ne se reproduisent plus (issue #72). */
  resolvedConflicts: number;
  error: string | null;
  /** VEVENT annoncés par le flux mais illisibles (date/UID manquants). */
  malformed: number;
  /** Flux vide alors que des séjours actifs en dépendent → rien n'a été annulé. */
  suspicious: boolean;
}

export async function syncFeed(
  db: D1Database,
  feed: FeedRow,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<SyncResult> {
  const result: SyncResult = {
    feedId: feed.id, imported: 0, updated: 0, cancelled: 0, reactivated: 0, conflicts: [], resolvedConflicts: 0, error: null,
    malformed: 0, suspicious: false,
  };
  const today = todayInZone(now);
  const nowSql = sqlNow(now);
  const scope = icalScope(feed.id);
  // Une détection non écrite interdit de refermer quoi que ce soit à ce
  // passage : sinon la panne qui empêche de noter le conflit l'efface.
  let registerOk = true;

  let events: IcsEvent[];
  try {
    const res = await fetcher(feed.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "gites-platform-ical-sync" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    events = parseIcs(body);
    if (feed.departureDayIncluded) events = applyDepartureDayIncluded(events);
    // Un VEVENT annoncé mais non retenu = date ou UID illisible : on le compte
    // au lieu de l'ignorer en silence (un flux à moitié cassé doit se voir).
    result.malformed = Math.max(0, (body.match(/BEGIN:VEVENT/g) ?? []).length - events.length);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await setFeedStatus(db, feed.id, `erreur : ${result.error}`, nowSql);
    return result;
  }

  // On ne considère que les événements pas encore terminés.
  const relevant = events.filter((ev) => ev.dtend > today);
  const existing = await listFeedBookings(db, feed.id);
  const byUid = new Map(existing.map((b) => [b.externalUid ?? "", b]));
  const seenUids = new Set<string>();

  // GARDE DE SANITÉ (audit ECC 2026-07-30, P0).
  // `res.ok` ne suffit pas : une URL Airbnb expirée, une redirection ou une
  // page de login répondent 200 avec un corps qui ne contient aucun VEVENT.
  // La boucle d'annulation plus bas libère TOUT ce qui manque au flux — donc
  // un flux vide annulait en masse des séjours confirmés et remettait les
  // dates en vente (double occupation le jour J), en affichant « ok ».
  const activeExisting = existing.filter((b) => b.checkin >= today);
  if (relevant.length === 0 && activeExisting.length > 0) {
    result.error = `flux vide ou illisible alors que ${activeExisting.length} réservation(s) active(s) en dépendent — aucune annulation appliquée`;
    result.suspicious = true;
    await setFeedStatus(db, feed.id, `⚠️ ${result.error}`, nowSql);
    await audit(db, "cron", "ical.sync.suspicious", `feed:${feed.id}`, {
      parsedEvents: events.length,
      malformed: result.malformed,
      activeBookings: activeExisting.length,
    });
    return result;
  }

  for (const ev of relevant) seenUids.add(`feed${feed.id}:${ev.uid}`);

  // Événements disparus du flux = annulés côté canal → on libère, mais
  // uniquement les séjours qui n'ont pas commencé (les séjours en cours ou
  // passés sont laissés tels quels). AVANT les créations : un créneau libéré
  // à ce passage doit pouvoir être repris au même passage.
  for (const b of existing) {
    if (!seenUids.has(b.externalUid ?? "") && b.checkin >= today) {
      await cancelBooking(db, b.id, "ical_removed", nowSql);
      result.cancelled += 1;
    }
  }

  // Les événements déjà connus d'abord (déplacements), les nouveaux ensuite :
  // l'ordre du flux n'est pas celui des dates. Sur l'agenda Google de papa
  // (10/10/2026), le séjour du 30/10 venait AVANT, dans le fichier, celui du
  // 02/11 qui le chevauchait encore d'une nuit (dates UTC d'avant #112) : la
  // création échouait « créneau déjà pris », puis le déplacement libérait le
  // créneau trop tard pour ce passage — et le cron n'en refait pas d'autre.
  const ordered = [
    ...relevant.filter((ev) => byUid.has(`feed${feed.id}:${ev.uid}`)),
    ...relevant.filter((ev) => !byUid.has(`feed${feed.id}:${ev.uid}`)),
  ];
  for (const ev of ordered) {
    const extUid = `feed${feed.id}:${ev.uid}`;
    const known = byUid.get(extUid);
    if (!known) {
      // Événement tenu par un blocage manuel (import des agendas Google :
      // famille, usage de papa) : ce n'est pas une vente, rien à créer. Un
      // blocage levé à la main reste une décision : le flux ne le rouvre pas.
      // Un blocage actif suit l'événement s'il a bougé.
      const block = await getManualBlockByExternalUid(db, extUid);
      if (block) {
        if (block.active && (block.checkin !== ev.dtstart || block.checkout !== ev.dtend)) {
          const moved = await moveManualBlockAtomic(db, block.id, block.unitId, ev.dtstart, ev.dtend, nowSql);
          if (moved) {
            result.updated += 1;
          } else {
            const label = `blocage « ${block.reason} » : déplacement ${ev.dtstart}→${ev.dtend} impossible (conflit)`;
            result.conflicts.push(label);
            registerOk = (await noteSyncConflict(db, {
              source: "ical", scope, kind: "move", unitId: block.unitId,
              checkin: ev.dtstart, checkout: ev.dtend, externalUid: extUid,
              channelLabel: feed.name, label,
            }, nowSql)) && registerOk;
          }
        }
        continue;
      }
      // L'événement est peut-être connu mais ANNULÉ (disparu du flux puis
      // réapparu) : listFeedBookings filtre les annulées, et une création
      // violerait l'unicité de external_uid — l'exception faisait échouer
      // TOUTE la relève du flux, à chaque passage (issue #18). On réactive
      // après revérification de disponibilité : le créneau a pu être revendu.
      const archived = await getBookingByExternalUid(db, extUid);
      // Annulation décidée à l'import de l'agenda (« annulé » écrit dans le
      // titre, ou événement devenu blocage) : le flux public ne dit que
      // « Busy » et continuerait de la publier ; on ne la rouvre pas.
      if (archived && STICKY_CANCEL_REASONS.has(archived.cancelReason ?? "")) continue;
      if (archived) {
        const back = await reactivateBookingAtomic(db, archived.id, archived.unitId, ev.dtstart, ev.dtend, nowSql);
        if (back) {
          result.reactivated += 1;
        } else {
          const label = `${archived.reference} : réactivation ${ev.dtstart}→${ev.dtend} impossible (créneau repris depuis l'annulation)`;
          result.conflicts.push(label);
          registerOk = (await noteSyncConflict(db, {
            source: "ical", scope, kind: "reactivate", unitId: archived.unitId,
            checkin: ev.dtstart, checkout: ev.dtend, externalUid: extUid,
            bookingReference: archived.reference, channelLabel: feed.name, label,
          }, nowSql)) && registerOk;
          await audit(db, "cron", "ical.reactivate.conflict", `booking:${archived.id}`, {
            feedId: feed.id, externalUid: extUid, reference: archived.reference,
            dtstart: ev.dtstart, dtend: ev.dtend,
          });
        }
        continue;
      }
      const created = await createBookingAtomic(db, {
        unitId: feed.unitId,
        checkin: ev.dtstart,
        checkout: ev.dtend,
        adults: 0,
        children: 0,
        status: "confirmed",
        source: "ical",
        channelLabel: feed.name,
        externalUid: extUid,
        internalNotes: ev.summary ? `iCal : ${ev.summary}` : null,
        now,
      });
      if (created.ok) {
        result.imported += 1;
      } else {
        const label = `${ev.dtstart}→${ev.dtend} (nouvel événement, créneau déjà pris)`;
        result.conflicts.push(label);
        registerOk = (await noteSyncConflict(db, {
          source: "ical", scope, kind: "import", unitId: feed.unitId,
          checkin: ev.dtstart, checkout: ev.dtend, externalUid: extUid,
          channelLabel: feed.name, label,
        }, nowSql)) && registerOk;
      }
    } else if (known.checkin !== ev.dtstart || known.checkout !== ev.dtend) {
      const moved = await updateBookingDatesAtomic(db, known.id, known.unitId, ev.dtstart, ev.dtend, nowSql);
      if (moved) {
        result.updated += 1;
      } else {
        const label = `${known.reference} : déplacement ${ev.dtstart}→${ev.dtend} impossible (conflit)`;
        result.conflicts.push(label);
        registerOk = (await noteSyncConflict(db, {
          source: "ical", scope, kind: "move", unitId: known.unitId,
          checkin: ev.dtstart, checkout: ev.dtend, externalUid: extUid,
          bookingReference: known.reference, channelLabel: feed.name, label,
        }, nowSql)) && registerOk;
      }
    }
  }

  // Le flux a été relu EN ENTIER (les deux sorties anticipées ci-dessus — erreur
  // réseau, flux vide suspect — n'arrivent pas ici) : tout conflit de ce flux
  // qui n'a pas été redétecté à ce passage a bel et bien disparu (issue #72).
  if (registerOk) result.resolvedConflicts = await closeUnseenSyncConflicts(db, scope, nowSql);

  const statusMsg =
    result.conflicts.length > 0
      ? `⚠️ ${result.conflicts.length} conflit(s) — ${result.conflicts[0] ?? ""}`
      : result.malformed > 0
        ? `⚠️ ${result.malformed} événement(s) illisible(s) dans le flux`
        : "ok";
  await setFeedStatus(db, feed.id, statusMsg, nowSql);
  if (result.imported || result.updated || result.cancelled || result.reactivated || result.conflicts.length) {
    await audit(db, "cron", "ical.sync", `feed:${feed.id}`, result);
  }
  return result;
}
