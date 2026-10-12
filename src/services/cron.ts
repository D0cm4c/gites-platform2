// Tâches planifiées (cron */15 min) :
//  1. expiration des holds périmés (filet de sécurité — la dispo n'en dépend pas)
//  2. import des flux iCal actifs
//  3. rappels de solde à l'échéance (une seule fois par résa, mode stub par défaut)
//  4. push Beds24 des calendriers mappés (dispo + prix — inactif sans token),
//     puis relève des messages des canaux (services/beds24-messages.ts)
//     et de la boîte de contact des gîtes (services/mailbox.ts, IMAP, Node seulement)
//
// Plus trois ménages : sessions admin périmées, sessions de paiement restées
// « en attente » au-delà de leur durée de vie (issue #69), et purge du
// registre des personnes hébergées au-delà de sa durée de conservation
// (issue #84, vérifiée une fois par jour).

import { sqlNow, todayInZone } from "../core/dates";
import {
  audit,
  expireStaleHolds,
  expireStalePaymentSessions,
  getProperty,
  hasEmailOfKind,
  listBookings,
  listFeeds,
  listProperties,
} from "../db/repo";
import { beds24Configured } from "./beds24";
import { purgeExpiredSessions } from "./admin-auth";
import { pullChannelMessages } from "./beds24-messages";
import { pullMailbox } from "./mailbox";
import { pullBeds24Bookings, pushCalendars } from "./beds24-sync";
import { runDailyDigest } from "./digest";
import { runGuestRegisterPurge } from "./guest-register";
import { voucherUrl } from "./booking-flow";
import { buildBalanceReminderEmail, queueEmail } from "./email";
import { CRON_HEARTBEAT_KEY } from "./health";
import { syncFeed } from "./ical";
import { runDailyReconcile } from "./reconcile";
import { runAbandonedReminders } from "./relance";
import { setSetting } from "./settings";

/** Durée de vie d'une session de checkout (`stripe.ts` pose expires_at à +30
 *  min, aligné sur le hold), plus une marge d'horloge : au-delà, une session
 *  encore « en attente » est morte. */
export const PAYMENT_SESSION_TTL_MINUTES = 35;

export async function runScheduled(env: Env, now: Date = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  const db = env.DB;
  const nowSql = sqlNow(now);

  // 0. Battement de cœur, EN TÊTE et pas en fin de traitement : il atteste que
  //    le cron s'est déclenché, pas qu'il est allé au bout. Un import iCal qui
  //    échoue doit rester un incident visible dans le journal, pas se déguiser
  //    en « le traitement planifié ne tourne plus » (issue #21).
  //    Écrit dans app_settings et NON dans audit_log : le cron y verse déjà
  //    ~96 lignes par jour, ce qui noie les vraies anomalies.
  try {
    await setSetting(db, CRON_HEARTBEAT_KEY, nowSql);
  } catch (e) {
    await audit(db, "cron", "heartbeat.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 1. Holds périmés — enveloppé comme les autres étapes : une panne ici
  //    (verrou D1, erreur SQL) interrompait tout le cron, donc les flux iCal,
  //    les rappels de solde et le push Beds24, sans la moindre trace.
  try {
    const expired = await expireStaleHolds(db, nowSql);
    if (expired > 0) {
      await audit(db, "cron", "holds.expired", undefined, { count: expired });
    }
  } catch (e) {
    await audit(db, "cron", "holds.expire.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 1 bis. Sessions de PAIEMENT abandonnées (issue #69). Le webhook
  //    `checkout.session.expired` couvre déjà le cas nominal, mais il n'existe
  //    pas en mode stub et peut se perdre : sans ce filet, chaque tunnel
  //    abandonné laissait une ligne « en attente » à vie dans la vue Paiements.
  //    Le journal est écrit par paiement (entité `booking:<id>`) pour que la
  //    fiche réservation en garde la trace, comme le fait le webhook.
  try {
    const stale = await expireStalePaymentSessions(
      db,
      sqlNow(new Date(now.getTime() - PAYMENT_SESSION_TTL_MINUTES * 60_000)),
    );
    for (const p of stale) {
      await audit(db, "cron", "payment.expired", `booking:${p.bookingId}`, { payment: p.id, amountCents: p.amountCents });
    }
  } catch (e) {
    await audit(db, "cron", "payment.expire.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 1 ter. Sessions du back-office expirées — simple ménage.
  try {
    await purgeExpiredSessions(db);
  } catch (e) {
    await audit(db, "cron", "sessions.purge.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 2. Flux iCal
  const feeds = await listFeeds(db, true);
  for (const feed of feeds) {
    try {
      await syncFeed(db, feed, fetcher, now);
    } catch (e) {
      await audit(db, "cron", "ical.sync.error", `feed:${feed.id}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3. Rappels de solde : résas confirmées, solde impayé, échéance atteinte,
  //    arrivée pas encore passée — un seul rappel par réservation.
  const today = todayInZone(now);
  const confirmed = await listBookings(db, { status: "confirmed", from: today, limit: 500 });
  for (const b of confirmed) {
    const balance = b.totalCents - b.paidCents;
    if (balance <= 0 || !b.balanceDueDate || b.balanceDueDate > today) continue;
    if (!b.guestEmail) continue;
    if (await hasEmailOfKind(db, b.id, "balance_reminder")) continue;
    const property = await getProperty(db, b.propertyId ?? -1);
    if (!property) continue;
    // Depuis l'issue #67, le solde se règle en libre-service sur le voucher :
    // le rappel y renvoie au lieu de promettre un lien « sur demande ».
    const email = buildBalanceReminderEmail(b, property, voucherUrl(env, b));
    await queueEmail(db, env, {
      bookingId: b.id,
      to: b.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      kind: "balance_reminder",
    });
    await audit(db, "cron", "email.balance_reminder", `booking:${b.id}`);
  }

  // 3 bis. Relance des réservations abandonnées (issue #37) — uniquement les
  //    clients ayant explicitement consenti, une seule fois par séjour, et
  //    seulement si le créneau est encore libre. Sous try/catch : une relance
  //    commerciale ne doit jamais empêcher le reste du traitement planifié.
  try {
    const relances = await runAbandonedReminders(env, now);
    if (relances.sent > 0) {
      await audit(db, "cron", "abandon.reminders", undefined, relances);
    }
  } catch (e) {
    await audit(db, "cron", "abandon.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 4. Beds24 (inactif sans BEDS24_REFRESH_TOKEN) : d'abord rapatrier les résas
  //    des canaux (pull), PUIS pousser les calendriers à jour (push) — l'état
  //    poussé intègre ainsi les résas qui viennent d'arriver.
  if (await beds24Configured(env)) {
    const properties = await listProperties(db);
    for (const p of properties) {
      if (p.beds24PropertyId == null) continue;
      try {
        await pullBeds24Bookings(db, env, p.id, p.beds24PropertyId, now);
      } catch (e) {
        await audit(db, "cron", "beds24.pull.error", `property:${p.id}`, { error: e instanceof Error ? e.message : String(e) });
      }
      try {
        const { pushed } = await pushCalendars(db, env, p.id);
        await audit(db, "cron", "beds24.push", `property:${p.id}`, { rooms: pushed.length });
      } catch (e) {
        await audit(db, "cron", "beds24.push.error", `property:${p.id}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Messages des canaux (Airbnb, Booking…) : UNE relève par passage, pour tout
    // le compte, APRÈS le pull des réservations — un message d'une résa qui
    // vient d'arriver trouve ainsi sa réservation. L'échec est déjà journalisé.
    try {
      await pullChannelMessages(env, now);
    } catch {
      /* beds24.messages.error au journal */
    }
  }

  // 4 bis (messagerie). Boîte de contact des gîtes (IMAP) : les mails reviennent dans
  //    Messages avec leur origine. Sans IMAP_USER, ou sur Workers (pas de socket), la
  //    relève se saute d'elle-même ; elle ne lève jamais (échec = journal + état).
  try {
    await pullMailbox(env, now);
  } catch (e) {
    await audit(db, "cron", "mailbox.imap.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 4 bis. Rapatriement COMPLET des canaux externes, une fois par jour au tick
  //    du matin (issue #19) : le pull incrémental ci-dessus ne voit ni les
  //    modifications antérieures à son curseur, ni ce qui a disparu de la
  //    source. La fonction se saute toute seule hors créneau et hors jour.
  try {
    await runDailyReconcile(env, now);
  } catch (e) {
    await audit(db, "cron", "beds24.reconcile.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 4 ter. Registre des personnes hébergées : purge au-delà de la durée de
  //    conservation (issue #84). Vérifié UNE FOIS PAR JOUR — le cron passe 96
  //    fois, un DELETE quotidien tient le délai à la journée près. Le journal
  //    ne porte QUE des compteurs : jamais un nom, une nationalité ni un
  //    numéro de pièce ne doit se retrouver dans `audit_log`.
  try {
    const purge = await runGuestRegisterPurge(db, now);
    if (purge.ran && purge.deleted > 0) {
      await audit(db, "cron", "guest_register.purge", undefined, { lignes: purge.deleted, avant: purge.cutoff });
    }
  } catch (e) {
    await audit(db, "cron", "guest_register.purge.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 5. Résumé quotidien au propriétaire (7 h, fuseau de Bruxelles). En DERNIER
  //    et sous try/catch : le résumé décrit l'état du système, il ne doit pas
  //    pouvoir empêcher le système de fonctionner. Il se saute tout seul hors
  //    du créneau et ne part qu'une fois par jour.
  try {
    await runDailyDigest(env, now);
  } catch (e) {
    await audit(db, "cron", "digest.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }
}
