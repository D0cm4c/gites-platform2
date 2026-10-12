// Emails transactionnels — MODE STUB PAR DÉFAUT.
// Chaque email est journalisé dans email_log. Il n'est réellement envoyé que si
// EMAILS_ENABLED=true ET qu'un transport est configuré — c'est-à-dire jamais
// sans décision explicite de Julien. Deux transports, un seul à la fois :
//   - SMTP (site Node chez Infomaniak, la production depuis le 10/10/2026) :
//     SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM posés ; le client SMTP vit
//     dans node/smtp.mjs (node:net/node:tls), injecté en env.SMTP_SEND ;
//   - Resend (Cloudflare Workers, inchangé) : RESEND_API_KEY.
// SMTP prime quand les deux sont configurés.

import type { BookingRow, PropertyRow, PropertySettings } from "../db/repo";
import type { Quote, QuoteLine } from "../core/pricing";
import { nlText } from "../core/public-i18n";

/** Le client écrit en néerlandais (guests.lang = 'nl', choisi dans le tunnel). */
export function isNl(b: BookingRow): boolean {
  return b.guestLang === "nl";
}

/** Montant à la belge : « 1 234,56 € » en français, « € 1.234,56 » en néerlandais. */
export function money(cents: number, nl: boolean): string {
  if (!nl) return formatEur(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€ ${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(abs % 100).padStart(2, "0")}`;
}

/** Les conditions générales n'existent qu'en français (décision du lot 3). */
export const CGV_NL_NOTE = "De algemene voorwaarden bestaan alleen in het Frans. De Franse versie is rechtsgeldend.";

/** Coordonnée réelle d'un domaine : les « TODO_… » de la graine ne sortent jamais
 *  (issue #4), ni sur le site, ni dans un mail ou un document. null = à taire. */
export function realContact(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" || /^TODO_/i.test(v) ? null : v;
}

/** Adresse postale d'un domaine sur une ligne, sans répéter la commune si l'adresse la contient déjà. */
export function postalAddress(p: { address: string | null; commune: string | null }): string {
  const address = (p.address ?? "").replace(/\s+/g, " ").trim();
  const commune = (p.commune ?? "").replace(/\s+/g, " ").trim();
  if (!commune || address.toLowerCase().includes(commune.toLowerCase())) return address || commune;
  return address ? `${address}, ${commune}` : commune;
}

export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const cts = String(abs % 100).padStart(2, "0");
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${eurosStr},${cts} €`;
}

export function formatDateFr(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Objet d'un mail lié à une réservation : la référence EN TÊTE, entre crochets,
 *  jamais le nom du client (décision de Julien, 12/10/2026). Le client la
 *  retrouve d'un coup d'œil, et la relève de la boîte rattache sa réponse à la
 *  bonne réservation (inbound-email.ts lit la référence dans l'objet). */
export function refSubject(reference: string, text: string): string {
  return `[${reference}] ${text}`.replace(/[\r\n]+/g, " ");
}

export interface EmailToQueue {
  bookingId?: number | null;
  to: string;
  subject: string;
  bodyText: string;
  kind: string; // 'confirmation' | 'payment_link' | 'balance_reminder' | …
  /** Réponse à un mail : garde le fil chez le destinataire (Gmail, Outlook). */
  inReplyTo?: string | null;
  references?: string | null;
  /** Version HTML du message (multipart/alternative) ; le texte reste la référence du journal. */
  bodyHtml?: string;
  /** Pièces jointes (le PDF de la confirmation). */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** Base64 d'un tableau d'octets, par tranches (Workers comme Node, sans Buffer). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Pièces jointes telles que le journal les garde : nom et taille, jamais le contenu. */
function attachmentsLog(list: EmailAttachment[] | undefined): string | null {
  if (!list || list.length === 0) return null;
  return JSON.stringify(list.map((a) => ({ filename: a.filename, bytes: a.content.length })));
}

/** Le transport réellement employé si l'envoi est actif, ou null (stub). */
export function emailTransport(env: Env): "smtp" | "resend" | null {
  if (env.EMAILS_ENABLED !== "true") return null;
  const smtp = [env.SMTP_HOST, env.SMTP_USER, env.SMTP_PASSWORD, env.MAIL_FROM].every((v) => (v ?? "").trim() !== "");
  if (smtp && env.SMTP_SEND) return "smtp";
  if (env.RESEND_API_KEY) return "resend";
  return null;
}

export async function queueEmail(db: D1Database, env: Env, e: EmailToQueue): Promise<"stub" | "sent" | "failed"> {
  return (await queueEmailDetailed(db, env, e)).status;
}

/** Comme queueEmail, avec l'identifiant du fournisseur (le Message-ID SMTP, en <…>). */
export async function queueEmailDetailed(
  db: D1Database,
  env: Env,
  e: EmailToQueue,
): Promise<{ status: "stub" | "sent" | "failed"; providerId: string | null }> {
  let status: "stub" | "sent" | "failed" = "stub";
  let providerId: string | null = null;
  // Sans le détail de l'échec, un voucher jamais parti était indiscernable
  // d'un envoi désactivé — et personne ne le voyait (audit ECC 2026-07-30).
  let errorDetail: string | null = null;
  const transport = emailTransport(env);

  if (transport === "smtp" && env.SMTP_SEND) {
    try {
      providerId = (await env.SMTP_SEND({ to: e.to, subject: e.subject, text: e.bodyText, html: e.bodyHtml, attachments: e.attachments, inReplyTo: e.inReplyTo, references: e.references })).id;
      status = "sent";
    } catch (err) {
      status = "failed";
      errorDetail = err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
    }
  } else if (transport === "resend") {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.RESEND_FROM ?? "reservation@example.com",
          to: [e.to],
          subject: e.subject,
          text: e.bodyText,
          ...(e.inReplyTo ? { headers: { "In-Reply-To": e.inReplyTo, References: e.references || e.inReplyTo } } : {}),
          ...(e.bodyHtml ? { html: e.bodyHtml } : {}),
          ...(e.attachments?.length
            ? { attachments: e.attachments.map((a) => ({ filename: a.filename, content: toBase64(a.content) })) }
            : {}),
        }),
      });
      if (res.ok) {
        status = "sent";
        providerId = ((await res.json()) as { id?: string }).id ?? null;
      } else {
        status = "failed";
        errorDetail = `HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 400)}`.trim();
      }
    } catch (err) {
      status = "failed";
      errorDetail = err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
    }
  }

  await db
    .prepare(
      "INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status, provider_id, error_detail, attachments) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(e.bookingId ?? null, e.to, e.subject, e.bodyText, e.kind, status, providerId, errorDetail, attachmentsLog(e.attachments))
    .run();
  return { status, providerId };
}

function quoteLinesText(lines: QuoteLine[], nl = false): string {
  return lines.map((l) => `  ${(nl ? nlText(l.label) : l.label).padEnd(52)} ${money(l.amountCents, nl).padStart(12)}`).join("\n");
}

/** Lien de paiement (solde ou autre) à envoyer au client. */
export function buildPaymentLinkEmail(
  b: BookingRow,
  property: PropertyRow,
  label: string,
  amountCents: number,
  payUrl: string,
  opts: { holdUntil?: string | null } = {},
): { subject: string; bodyText: string } {
  if (isNl(b)) return buildPaymentLinkEmailNl(b, property, label, amountCents, payUrl, opts);
  return {
    subject: refSubject(b.reference, `${label} : lien de paiement — ${property.name}`),
    bodyText: [
      `Bonjour,`,
      ``,
      `Voici votre lien de paiement sécurisé pour la réservation ${b.reference} (${b.unitName ?? ""}, du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)}) :`,
      ``,
      `${label} : ${formatEur(amountCents)}`,
      payUrl,
      ``,
      `Ce lien ouvre la page de votre réservation : vous y acceptez les conditions générales, réglez les arrhes en ligne (carte bancaire, via Stripe), puis recevez votre confirmation avec les conditions générales.`,
      ...(opts.holdUntil ? [`Vos dates sont gardées jusqu'au ${formatDateFr(opts.holdUntil.slice(0, 10))}.`] : []),
      ``,
      `À bientôt,`,
      `${property.name}`,
    ].join("\n"),
  };
}

/** Reçu de paiement (issue #37, volet b) — émis à chaque encaissement, arrhes
 *  comme solde.
 *
 *  Distinct du voucher, et pas redondant avec lui : le voucher est le document
 *  de la réservation (conditions générales comprises), envoyé une
 *  seule fois à la confirmation. Le reçu est un justificatif comptable, émis
 *  autant de fois qu'il y a d'encaissements — c'est le document qu'un client
 *  cherche quand il veut prouver ce qu'il a payé, et quand.
 *
 *  Les montants viennent de la réservation APRÈS enregistrement du paiement :
 *  `paidCents` inclut donc l'encaissement décrit ici. */
export function buildPaymentReceiptEmail(
  b: BookingRow,
  property: PropertyRow,
  payment: { kind: string; amountCents: number; receivedAt?: string | null },
): { subject: string; bodyText: string } {
  if (isNl(b)) return buildPaymentReceiptEmailNl(b, property, payment);
  let quote: Quote | null = null;
  if (b.quoteJson) {
    try {
      quote = JSON.parse(b.quoteJson) as Quote;
    } catch {
      quote = null; // le reçu part sans le détail : les montants suffisent à justifier
    }
  }
  const label =
    payment.kind === "deposit" ? "Arrhes" : payment.kind === "balance" ? "Solde" : payment.kind === "full" ? "Paiement intégral" : "Paiement";
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const persons = b.adults + b.children;

  const parts: string[] = [
    `Bonjour,`,
    ``,
    `Nous accusons réception de votre paiement. Ce message vaut justificatif.`,
    ``,
    `Référence : ${b.reference}`,
    `Hébergement : ${b.unitName ?? ""} — ${property.name}`,
    `Séjour : du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)} — ${persons} personne${persons > 1 ? "s" : ""}`,
  ];
  if (payment.receivedAt) parts.push(`Payé le : ${payment.receivedAt}`);
  parts.push(``, `${label} encaissé${payment.kind === "deposit" ? "es" : ""} : ${formatEur(payment.amountCents)}`);

  if (quote) {
    parts.push(``, `Détail du séjour :`, quoteLinesText(quote.lines), `  ${"TOTAL".padEnd(52)} ${formatEur(quote.totalCents).padStart(12)}`);
  } else {
    parts.push(``, `Total du séjour : ${formatEur(b.totalCents)}`);
  }

  parts.push(``, `Total déjà réglé : ${formatEur(b.paidCents)}`);
  if (balance > 0) {
    parts.push(
      `Solde restant : ${formatEur(balance)}${b.balanceDueDate ? ` — à régler pour le ${formatDateFr(b.balanceDueDate)}` : ""}`,
    );
  } else {
    parts.push(`Solde restant : aucun — votre séjour est intégralement réglé.`);
  }
  parts.push(``, `À bientôt,`, `${property.name}`, property.contactEmail ? `${property.contactEmail}` : ``);

  return {
    subject: refSubject(b.reference, `Reçu de paiement ${formatEur(payment.amountCents)} — ${property.name}`),
    bodyText: parts.join("\n"),
  };
}

/** Rappel de solde — automatique (cron, à l'échéance) ou déclenché à la main
 *  depuis la fiche réservation du back-office (issue #69).
 *
 *  `payUrl` est l'URL du VOUCHER, pas celle d'une session de paiement : une
 *  session Stripe expire (30 min à 24 h), un rappel se lit parfois le
 *  surlendemain. Le voucher, lui, ne périme jamais et porte le bouton
 *  « Payer le solde » (issue #67), qui ouvre une session fraîche au clic. */
export function buildBalanceReminderEmail(
  b: BookingRow,
  property: PropertyRow,
  payUrl?: string | null,
): { subject: string; bodyText: string } {
  if (isNl(b)) return buildBalanceReminderEmailNl(b, property, payUrl);
  const balance = b.totalCents - b.paidCents;
  const closing = payUrl
    ? [`Vous pouvez le régler en ligne, en quelques clics :`, ``, payUrl]
    : [`Nous pouvons vous renvoyer un lien de paiement sur simple demande.`];
  return {
    subject: refSubject(b.reference, `Rappel : solde de votre séjour — ${property.name}`),
    bodyText: [
      `Bonjour,`,
      ``,
      `Petit rappel : le solde de votre réservation ${b.reference} (${b.unitName ?? ""}, arrivée le ${formatDateFr(b.checkin)}) reste à régler.`,
      ``,
      `Solde : ${formatEur(balance)}${b.balanceDueDate ? ` — échéance le ${formatDateFr(b.balanceDueDate)}` : ""}`,
      ``,
      ...closing,
      ``,
      `À bientôt,`,
      `${property.name}`,
    ].join("\n"),
  };
}

// --- néerlandais (lot 3, #34) -------------------------------------------------------
// Mêmes mails, pour un client qui a réservé en néerlandais. Les montants et la
// structure sont ceux du français ; les conditions générales restent en
// français, précédées de la mention que la version française fait foi.

export function parseQuote(b: BookingRow): Quote | null {
  if (!b.quoteJson) return null;
  try {
    return JSON.parse(b.quoteJson) as Quote;
  } catch {
    return null;
  }
}

const personen = (n: number) => `${n} ${n > 1 ? "personen" : "persoon"}`;

function buildPaymentLinkEmailNl(b: BookingRow, property: PropertyRow, label: string, amountCents: number, payUrl: string, opts: { holdUntil?: string | null }): { subject: string; bodyText: string } {
  const l = nlText(label);
  return {
    subject: refSubject(b.reference, `${l}: betaallink — ${property.name}`),
    bodyText: [
      `Beste,`,
      ``,
      `Hier is uw beveiligde betaallink voor reservering ${b.reference} (${b.unitName ?? ""}, van ${formatDateFr(b.checkin)} tot ${formatDateFr(b.checkout)}):`,
      ``,
      `${l}: ${money(amountCents, true)}`,
      payUrl,
      ``,
      `Deze link opent de pagina van uw reservering: u aanvaardt er de algemene voorwaarden, betaalt het voorschot online (bankkaart, via Stripe) en ontvangt daarna uw bevestiging met de algemene voorwaarden.`,
      ...(opts.holdUntil ? [`Uw data worden bewaard tot ${formatDateFr(opts.holdUntil.slice(0, 10))}.`] : []),
      ``,
      `Tot binnenkort,`,
      `${property.name}`,
    ].join("\n"),
  };
}

function buildPaymentReceiptEmailNl(b: BookingRow, property: PropertyRow, payment: { kind: string; amountCents: number; receivedAt?: string | null }): { subject: string; bodyText: string } {
  const quote = parseQuote(b);
  const label = payment.kind === "deposit" ? "Voorschot" : payment.kind === "balance" ? "Saldo" : payment.kind === "full" ? "Volledige betaling" : "Betaling";
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const persons = b.adults + b.children;
  const parts: string[] = [
    `Beste,`,
    ``,
    `Wij bevestigen de ontvangst van uw betaling. Dit bericht geldt als bewijs van betaling.`,
    ``,
    `Referentie: ${b.reference}`,
    `Accommodatie: ${b.unitName ?? ""} — ${property.name}`,
    `Verblijf: van ${formatDateFr(b.checkin)} tot ${formatDateFr(b.checkout)} — ${personen(persons)}`,
  ];
  if (payment.receivedAt) parts.push(`Betaald op: ${payment.receivedAt}`);
  parts.push(``, `${label} ontvangen: ${money(payment.amountCents, true)}`);
  if (quote) {
    parts.push(``, `Detail van het verblijf:`, quoteLinesText(quote.lines, true), `  ${"TOTAAL".padEnd(52)} ${money(quote.totalCents, true).padStart(12)}`);
  } else {
    parts.push(``, `Totaal van het verblijf: ${money(b.totalCents, true)}`);
  }
  parts.push(``, `Totaal al betaald: ${money(b.paidCents, true)}`);
  if (balance > 0) {
    parts.push(`Resterend saldo: ${money(balance, true)}${b.balanceDueDate ? ` — te betalen tegen ${formatDateFr(b.balanceDueDate)}` : ""}`);
  } else {
    parts.push(`Resterend saldo: geen — uw verblijf is volledig betaald.`);
  }
  parts.push(``, `Tot binnenkort,`, `${property.name}`, property.contactEmail ? `${property.contactEmail}` : ``);
  return { subject: refSubject(b.reference, `Betalingsbewijs ${money(payment.amountCents, true)} — ${property.name}`), bodyText: parts.join("\n") };
}

function buildBalanceReminderEmailNl(b: BookingRow, property: PropertyRow, payUrl?: string | null): { subject: string; bodyText: string } {
  const balance = b.totalCents - b.paidCents;
  const closing = payUrl ? [`U kunt het in enkele klikken online betalen:`, ``, payUrl] : [`Op eenvoudig verzoek sturen wij u opnieuw een betaallink.`];
  return {
    subject: refSubject(b.reference, `Herinnering: saldo van uw verblijf — ${property.name}`),
    bodyText: [
      `Beste,`,
      ``,
      `Een kleine herinnering: het saldo van uw reservering ${b.reference} (${b.unitName ?? ""}, aankomst op ${formatDateFr(b.checkin)}) moet nog betaald worden.`,
      ``,
      `Saldo: ${money(balance, true)}${b.balanceDueDate ? ` — vervaldag ${formatDateFr(b.balanceDueDate)}` : ""}`,
      ``,
      ...closing,
      ``,
      `Tot binnenkort,`,
      `${property.name}`,
    ].join("\n"),
  };
}

/** Mail « Annulation de votre réservation » (CGV v3.1, article 5) : ce qui
 *  reste acquis à l'exploitant, ce qui est remboursé, sur le moyen de paiement
 *  utilisé, sous 14 jours ; quand l'exploitant annule (hors force majeure),
 *  l'indemnité égale aux arrhes (5.3), virée à la main : on demande l'IBAN.
 *  Pas de PDF. Les montants sont ceux du plan ; rien au-delà des CGV. */
export function buildCancellationEmail(
  b: BookingRow,
  property: PropertyRow,
  plan: { par: "locataire" | "proprietaire"; keptCents: number; refundCents: number; indemnityCents?: number; forceMajeure?: boolean; sejourEntame?: boolean },
): { subject: string; bodyText: string } {
  const nl = isNl(b);
  const m = (c: number) => money(c, nl);
  const stay = nl
    ? `Verblijf: van ${formatDateFr(b.checkin)} tot ${formatDateFr(b.checkout)}`
    : `Séjour : du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)}`;
  const contact = property.contactEmail ? [property.contactEmail] : [];
  const byClient = plan.par === "locataire";
  const indemnity = !byClient && !plan.forceMajeure ? Math.max(0, plan.indemnityCents ?? 0) : 0;
  if (nl) {
    const lines = [
      `Beste,`,
      ``,
      byClient ? `Uw reservering ${b.reference} is geannuleerd op uw verzoek.` : `Wij moeten uw reservering ${b.reference} helaas annuleren.`,
      ``,
      `Accommodatie: ${b.unitName ?? ""} — ${property.name}`,
      stay,
      ``,
    ];
    if (plan.forceMajeure) lines.push(`Overmacht (artikel 5.4 van de algemene voorwaarden): alles wat u betaalde, voorschot inbegrepen, wordt aan u terugbetaald.`);
    else if (byClient && plan.sejourEntame) lines.push(`Volgens artikel 5.5 van de algemene voorwaarden wordt de prijs van het verblijf${plan.keptCents > 0 ? ` (${m(plan.keptCents)})` : ""} niet terugbetaald.`);
    else if (byClient) lines.push(`Volgens artikel 5.2 van de algemene voorwaarden blijft het voorschot${plan.keptCents > 0 ? ` (${m(plan.keptCents)})` : ""} verworven door de uitbater.`);
    else lines.push(`Volgens artikel 5.3 van de algemene voorwaarden wordt alles wat u betaalde, voorschot inbegrepen, aan u terugbetaald${indemnity > 0 ? `, en ontvangt u daarnaast een vergoeding gelijk aan het voorschot` : ""}.`);
    lines.push(
      plan.refundCents > 0
        ? `Terugbetaling: ${m(plan.refundCents)}, op het gebruikte betaalmiddel, binnen 14 dagen.`
        : byClient ? `Er is niets terug te betalen.` : `U had nog niets betaald.`,
    );
    if (indemnity > 0) lines.push(`Daarnaast storten wij u een vergoeding gelijk aan het voorschot, ${m(indemnity)}. Antwoord op dit bericht met uw IBAN.`);
    lines.push(``, `Tot ziens,`, `${property.name}`, ...contact);
    return { subject: refSubject(b.reference, `Annulering van uw reservering — ${property.name}`), bodyText: lines.join("\n") };
  }
  const lines = [
    `Bonjour,`,
    ``,
    byClient ? `Votre réservation ${b.reference} est annulée à votre demande.` : `Nous sommes au regret d'annuler votre réservation ${b.reference}.`,
    ``,
    `Hébergement : ${b.unitName ?? ""} — ${property.name}`,
    stay,
    ``,
  ];
  if (plan.forceMajeure) lines.push(`Force majeure (article 5.4 des conditions générales) : tout ce que vous avez payé, arrhes comprises, vous est remboursé.`);
  else if (byClient && plan.sejourEntame) lines.push(`Selon l'article 5.5 des conditions générales, le prix du séjour${plan.keptCents > 0 ? ` (${m(plan.keptCents)})` : ""} n'est pas remboursé.`);
  else if (byClient) lines.push(`Selon l'article 5.2 des conditions générales, les arrhes${plan.keptCents > 0 ? ` (${m(plan.keptCents)})` : ""} restent acquises à l'exploitant.`);
  else lines.push(`Selon l'article 5.3 des conditions générales, tout ce que vous avez payé, arrhes comprises, vous est remboursé${indemnity > 0 ? `, et vous recevez en outre une indemnité égale aux arrhes` : ""}.`);
  lines.push(
    plan.refundCents > 0
      ? `Remboursement : ${m(plan.refundCents)}, sur le moyen de paiement utilisé, sous 14 jours.`
      : byClient ? `Il n'y a rien à vous rembourser.` : `Vous n'aviez encore rien payé.`,
  );
  if (indemnity > 0) lines.push(`Une indemnité de ${m(indemnity)}, égale aux arrhes, vous sera virée en outre. Indiquez-nous votre IBAN en réponse à ce message.`);
  lines.push(``, `Cordialement,`, `${property.name}`, ...contact);
  return { subject: refSubject(b.reference, `Annulation de votre réservation — ${property.name}`), bodyText: lines.join("\n") };
}

/** Accusé de réception d'un message envoyé par le formulaire de contact (site
 *  ou page de réservation, ou fil du voucher). Texte seul, sans HTML : le
 *  message du client y est repris tel quel, un texte brut ne peut rien exécuter.
 *  `reference` est celle de la réservation, ou « QU-AAAA-NNNN » pour une
 *  question posée avant de réserver. */
export function buildContactAckEmail(opts: {
  reference: string;
  propertyName: string;
  guestName: string | null;
  message: string;
  nl?: boolean;
  receivedAt?: string;
}): { subject: string; bodyText: string } {
  const name = (opts.guestName ?? "").replace(/[\r\n]+/g, " ").trim();
  const quoted = opts.message.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  if (opts.nl) {
    return {
      subject: refSubject(opts.reference, `Wij hebben uw bericht ontvangen — ${opts.propertyName}`),
      bodyText: [
        name ? `Beste ${name},` : `Beste,`,
        ``,
        `Wij hebben uw bericht goed ontvangen. Het ligt bij het team van ${opts.propertyName}; u krijgt het antwoord per e-mail, op dit adres.`,
        `Uw referentie: ${opts.reference}`,
        ``,
        `Uw bericht:`,
        quoted,
        ``,
        `Wilt u iets toevoegen? Antwoord gewoon op dit bericht.`,
        ``,
        `Tot binnenkort,`,
        opts.propertyName,
      ].join("\n"),
    };
  }
  return {
    subject: refSubject(opts.reference, `Nous avons bien reçu votre message — ${opts.propertyName}`),
    bodyText: [
      name ? `Bonjour ${name},` : `Bonjour,`,
      ``,
      `Votre message nous est bien parvenu. Il est entre les mains de l'équipe de ${opts.propertyName} ; la réponse vous arrivera par e-mail, à cette adresse.`,
      `Votre référence : ${opts.reference}`,
      ``,
      `Votre message :`,
      quoted,
      ``,
      `Quelque chose à ajouter ? Répondez simplement à cet e-mail.`,
      ``,
      `À bientôt,`,
      opts.propertyName,
    ].join("\n"),
  };
}
