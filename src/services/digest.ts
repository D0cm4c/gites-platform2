// Résumé quotidien par e-mail au propriétaire (issue #27).
//
// L'exploitant n'est pas technicien et ne lira jamais un journal. Huit types
// d'incidents peuvent aujourd'hui survenir sans que personne ne l'apprenne —
// un paiement encaissé sans réservation confirmée, un voucher jamais parti,
// une synchronisation figée. Ce résumé transforme « on découvre trois semaines
// après » en « on découvre le lendemain matin ».
//
// Règle de rédaction du message : il doit se lire à voix haute par quelqu'un
// qui ne connaît pas le système. Pas de référence de table, pas d'anglais, pas
// de code d'erreur. « Le calendrier Airbnb ne répond plus », pas
// « ical.sync.error feed:3 ».
//
// L'envoi passe par queueEmail : tant que EMAILS_ENABLED vaut "false", le
// message est journalisé dans email_log sans partir. C'est voulu — le résumé
// se développe et se vérifie dès maintenant, il produira son effet le jour où
// les e-mails réels seront activés.

import { addDays, todayInZone } from "../core/dates";
import {
  audit,
  bookingsInWindow,
  countNewMessages,
  healthSignals,
  listBookings,
  listFeeds,
  listPayments,
  listProperties,
  type BookingRow,
} from "../db/repo";
import { formatDateFr, formatEur, queueEmail } from "./email";
import { countRecentImprovements } from "./improvements";
import { getSetting, setSetting } from "./settings";

/** Destinataires du résumé, séparés par des virgules. Aucune adresse n'est
 *  écrite en dur : sans cette clé, le résumé ne part pas (et le dit). */
export const DIGEST_RECIPIENTS_KEY = "digest_recipients";
/** Dernière date (Bruxelles) pour laquelle le résumé est parti — le garde-fou
 *  anti-doublon, le cron passant quatre fois pendant l'heure d'envoi. */
export const DIGEST_LAST_SENT_KEY = "digest_last_sent";
/** Heure d'envoi, fuseau de Bruxelles : le résumé doit être lu au petit
 *  déjeuner, avant la première arrivée de la journée. */
export const DIGEST_HOUR = 7;

export type DigestOutcome =
  | "hors-creneau"
  | "deja-envoye"
  | "sans-destinataire"
  | "envoye";

/** Heure locale à Bruxelles — la logique métier du projet vit dans ce fuseau. */
export function hourInBrussels(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(now),
  );
}

interface PropertyDigest {
  name: string;
  arrivals: BookingRow[];
  departures: BookingRow[];
  arrivalsTomorrow: BookingRow[];
  departuresTomorrow: BookingRow[];
  newBookings: BookingRow[];
  cancellations: BookingRow[];
  paymentsCents: number;
  paymentsCount: number;
  overdue: BookingRow[];
  dueSoon: BookingRow[];
  watch: string[];
}

export interface DigestData {
  today: string;
  properties: PropertyDigest[];
  /** Signaux transverses : ils ne dépendent pas d'un domaine en particulier. */
  brokenFeeds: string[];
  unreadMessages: number;
  /** Remarques d'amélioration des testeurs reçues dans les dernières 24 h. */
  newImprovements: number;
  /** Vrai si absolument rien ne mérite l'attention du propriétaire. */
  quiet: boolean;
}

function personCount(b: BookingRow): string {
  const n = b.adults + b.children;
  return `${n} personne${n > 1 ? "s" : ""}`;
}

function who(b: BookingRow): string {
  return b.guestName?.trim() ? b.guestName.trim() : "voyageur sans nom renseigné";
}

/** Rassemble tout ce que le propriétaire doit savoir ce matin. */
export async function collectDigest(db: D1Database, now: Date = new Date()): Promise<DigestData> {
  const today = todayInZone(now);
  const tomorrow = addDays(today, 1);
  // Fenêtre « dernières 24 h » plutôt que « depuis minuit » : à 7 h du matin,
  // « aujourd'hui » serait presque toujours vide et masquerait la soirée de la
  // veille, qui est justement le moment où les réservations tombent.
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

  const properties = await listProperties(db);
  const digests: PropertyDigest[] = [];

  for (const property of properties) {
    // Mouvements : toutes les résas non annulées qui touchent aujourd'hui ou
    // demain. La fenêtre démarre HIER, et ce n'est pas une marge de confort :
    // les nuitées forment l'intervalle semi-ouvert [arrivée, départ), donc un
    // séjour qui se termine ce matin n'occupe aucune nuit aujourd'hui et sort
    // d'une fenêtre commençant à `today`. Sans ce décalage, les départs du jour
    // — la moitié du travail de la journée — n'apparaissaient jamais.
    const window = await bookingsInWindow(db, property.id, addDays(today, -1), addDays(today, 2));
    // Historique récent : le volume réel est de quelques dizaines de résas par
    // an et par domaine, 500 couvre donc largement les dernières 24 h.
    const recent = await listBookings(db, { propertyId: property.id, limit: 500 });
    const payments = await listPayments(db, { propertyId: property.id });

    const confirmedOrPending = window.filter((b) => b.status !== "cancelled");
    const arrivals = confirmedOrPending.filter((b) => b.checkin === today);
    const departures = confirmedOrPending.filter((b) => b.checkout === today);
    const arrivalsTomorrow = confirmedOrPending.filter((b) => b.checkin === tomorrow);
    const departuresTomorrow = confirmedOrPending.filter((b) => b.checkout === tomorrow);

    const newBookings = recent.filter((b) => b.createdAt >= since && b.status !== "cancelled");
    const cancellations = recent.filter((b) => b.cancelledAt != null && b.cancelledAt >= since);

    const cashed = payments.filter((p) => p.status === "succeeded" && (p.receivedAt ?? p.createdAt) >= since);

    const withBalance = recent.filter((b) => b.status === "confirmed" && b.totalCents - b.paidCents > 0 && b.balanceDueDate);
    const overdue = withBalance.filter((b) => b.balanceDueDate! < today);
    const dueSoon = withBalance.filter((b) => b.balanceDueDate! >= today && b.balanceDueDate! <= addDays(today, 7));

    // « À regarder » : reprise exacte des signaux de la carte Santé, traduits
    // en phrases compréhensibles sans connaître le système.
    const watch: string[] = [];
    const health = await healthSignals(db, property.id, now);
    for (const p of health.orphanPayments) {
      watch.push(
        `Un paiement de ${formatEur(p.amountCents)} a été encaissé pour la réservation ${p.reference}, mais ce séjour n'est pas confirmé. Le client a payé et n'a pas sa réservation — à traiter en priorité.`,
      );
    }
    for (const e of health.failedEmails) {
      watch.push(`Un e-mail n'a pas pu être envoyé à ${e.toEmail}. Le destinataire ne l'a jamais reçu.`);
    }
    if (health.beds24StaleHours != null && health.beds24StaleHours > 2) {
      watch.push(
        `Les calendriers des sites de réservation (Airbnb, Booking…) ne se sont pas mis à jour depuis ${Math.round(health.beds24StaleHours)} heures. Risque de double réservation tant que ce n'est pas rétabli.`,
      );
    }
    if (health.recentErrors.length > 0) {
      watch.push(
        `${health.recentErrors.length} incident${health.recentErrors.length > 1 ? "s" : ""} technique${health.recentErrors.length > 1 ? "s" : ""} dans les dernières 24 heures — le détail est dans le back-office, page « Journal ».`,
      );
    }

    digests.push({
      name: property.name,
      arrivals,
      departures,
      arrivalsTomorrow,
      departuresTomorrow,
      newBookings,
      cancellations,
      paymentsCents: cashed.reduce((s, p) => s + p.amountCents, 0),
      paymentsCount: cashed.length,
      overdue,
      dueSoon,
      watch,
    });
  }

  const feeds = await listFeeds(db);
  const brokenFeeds = feeds
    .filter((f) => f.lastStatus && f.lastStatus !== "ok")
    .map((f) => `Le calendrier « ${f.name} » ne se met plus à jour${f.unitName ? ` (${f.unitName})` : ""}.`);

  let unreadMessages = 0;
  try {
    unreadMessages = await countNewMessages(db);
  } catch {
    unreadMessages = 0; // table absente sur une base pas encore migrée
  }

  const newImprovements = await countRecentImprovements(db, since);

  const quiet =
    brokenFeeds.length === 0 &&
    unreadMessages === 0 &&
    newImprovements === 0 &&
    digests.every(
      (d) =>
        d.arrivals.length === 0 &&
        d.departures.length === 0 &&
        d.arrivalsTomorrow.length === 0 &&
        d.departuresTomorrow.length === 0 &&
        d.newBookings.length === 0 &&
        d.cancellations.length === 0 &&
        d.paymentsCount === 0 &&
        d.overdue.length === 0 &&
        d.dueSoon.length === 0 &&
        d.watch.length === 0,
    );

  return { today, properties: digests, brokenFeeds, unreadMessages, newImprovements, quiet };
}

/** Met en forme le résumé. Texte brut : il doit rester lisible sur un
 *  téléphone, dans n'importe quel client de messagerie. */
export function renderDigest(data: DigestData): { subject: string; bodyText: string } {
  const lines: string[] = [`Bonjour,`, ``, `Voici le point du ${formatDateFr(data.today)}.`];

  for (const p of data.properties) {
    const bloc: string[] = [];

    if (p.arrivals.length > 0) {
      bloc.push(`Arrivées aujourd'hui :`);
      for (const b of p.arrivals) {
        bloc.push(`  - ${who(b)}, ${b.unitName ?? ""}, ${personCount(b)}, jusqu'au ${formatDateFr(b.checkout)} (réservation ${b.reference})`);
      }
    }
    if (p.departures.length > 0) {
      bloc.push(`Départs aujourd'hui :`);
      for (const b of p.departures) bloc.push(`  - ${who(b)}, ${b.unitName ?? ""} (réservation ${b.reference})`);
    }
    if (p.arrivalsTomorrow.length > 0) {
      bloc.push(`Arrivées demain :`);
      for (const b of p.arrivalsTomorrow) {
        bloc.push(`  - ${who(b)}, ${b.unitName ?? ""}, ${personCount(b)} (réservation ${b.reference})`);
      }
    }
    if (p.departuresTomorrow.length > 0) {
      bloc.push(`Départs demain :`);
      for (const b of p.departuresTomorrow) bloc.push(`  - ${who(b)}, ${b.unitName ?? ""} (réservation ${b.reference})`);
    }
    if (p.newBookings.length > 0) {
      bloc.push(`Nouvelles réservations (dernières 24 h) :`);
      for (const b of p.newBookings) {
        bloc.push(
          `  - ${who(b)}, ${b.unitName ?? ""}, du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)}, ${formatEur(b.totalCents)} (réservation ${b.reference})`,
        );
      }
    }
    if (p.cancellations.length > 0) {
      bloc.push(`Annulations (dernières 24 h) :`);
      for (const b of p.cancellations) {
        bloc.push(`  - ${who(b)}, ${b.unitName ?? ""}, du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)} (réservation ${b.reference})`);
      }
    }
    if (p.paymentsCount > 0) {
      bloc.push(
        `Encaissements (dernières 24 h) : ${formatEur(p.paymentsCents)} en ${p.paymentsCount} paiement${p.paymentsCount > 1 ? "s" : ""}.`,
      );
    }
    if (p.overdue.length > 0) {
      bloc.push(`Soldes en retard :`);
      for (const b of p.overdue) {
        bloc.push(
          `  - ${who(b)} doit encore ${formatEur(b.totalCents - b.paidCents)}, attendu pour le ${formatDateFr(b.balanceDueDate!)} (réservation ${b.reference})`,
        );
      }
    }
    if (p.dueSoon.length > 0) {
      bloc.push(`Soldes à régler dans les 7 jours :`);
      for (const b of p.dueSoon) {
        bloc.push(
          `  - ${who(b)} : ${formatEur(b.totalCents - b.paidCents)} pour le ${formatDateFr(b.balanceDueDate!)} (réservation ${b.reference})`,
        );
      }
    }

    if (bloc.length > 0) {
      lines.push(``, `--- ${p.name} ---`, ``, ...bloc);
    }
  }

  if ((data.newImprovements ?? 0) > 0) {
    lines.push(``, `${data.newImprovements} nouvelle${data.newImprovements > 1 ? "s" : ""} remarque${data.newImprovements > 1 ? "s" : ""} d'amélioration (dernières 24 h) : à lire dans Réglages, Améliorations.`);
  }

  const watch = [...data.properties.flatMap((p) => p.watch), ...data.brokenFeeds];
  if (data.unreadMessages > 0) {
    watch.push(
      `${data.unreadMessages} message${data.unreadMessages > 1 ? "s" : ""} de client${data.unreadMessages > 1 ? "s" : ""} en attente de réponse.`,
    );
  }

  lines.push(``, `--- À regarder ---`, ``);
  if (watch.length === 0) {
    lines.push(`Rien à signaler : tout fonctionne normalement.`);
  } else {
    for (const w of watch) lines.push(`  - ${w}`);
  }

  if (data.quiet) {
    lines.push(``, `Journée calme : aucune arrivée, aucun départ, aucune nouvelle réservation.`);
  }

  lines.push(``, `Bonne journée,`, `Votre plateforme de réservation`);

  const urgent = watch.length > 0 ? " — points à regarder" : "";
  return {
    subject: `Résumé du ${formatDateFr(data.today)}${urgent}`,
    bodyText: lines.join("\n"),
  };
}

/**
 * Branche quotidienne du traitement planifié. Ne fait rien hors du créneau du
 * matin, et jamais deux fois le même jour.
 *
 * Choix assumé sur le résumé vide : il part quand même, avec sa ligne « Rien à
 * signaler ». Un résumé qu'on ne reçoit pas est indiscernable d'une plateforme
 * tombée — c'est précisément la panne que cette issue cherche à rendre visible.
 * Recevoir chaque matin trois lignes qui disent que tout va bien est le prix de
 * cette certitude.
 */
export async function runDailyDigest(env: Env, now: Date = new Date()): Promise<DigestOutcome> {
  const db = env.DB;
  if (hourInBrussels(now) !== DIGEST_HOUR) return "hors-creneau";

  const today = todayInZone(now);
  if ((await getSetting(db, DIGEST_LAST_SENT_KEY)) === today) return "deja-envoye";

  const raw = (await getSetting(db, DIGEST_RECIPIENTS_KEY)) ?? "";
  const recipients = raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.includes("@"));
  if (recipients.length === 0) {
    // Une seule trace par jour, pas une par passage du cron : la marque
    // « envoyé » est posée quand même, sinon le journal se remplit de quatre
    // lignes identiques chaque matin.
    await setSetting(db, DIGEST_LAST_SENT_KEY, today);
    await audit(db, "cron", "digest.sans_destinataire", undefined, {
      aide: `Renseigner la clé ${DIGEST_RECIPIENTS_KEY} dans les réglages de l'application`,
    });
    return "sans-destinataire";
  }

  const data = await collectDigest(db, now);
  const { subject, bodyText } = renderDigest(data);

  for (const to of recipients) {
    await queueEmail(db, env, { to, subject, bodyText, kind: "daily_digest" });
  }
  // Marqué APRÈS l'envoi : si la composition échoue, le prochain passage du
  // cron (15 min plus tard) retentera au lieu d'avaler le résumé du jour.
  await setSetting(db, DIGEST_LAST_SENT_KEY, today);
  await audit(db, "cron", "digest.envoye", undefined, { destinataires: recipients.length });
  return "envoye";
}
