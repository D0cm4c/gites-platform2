// Mail de confirmation de réservation (FR / NL), avec le PDF « Confirmation de
// réservation et conditions générales » en pièce jointe. Il REMPLACE l'ancien « voucher » par mail (décision Julien du
// 11/10/2026) : un seul message part à la confirmation, avec
//   - une version HTML (tableaux, bouton vers la page de la réservation) et la
//     version texte, qui reste celle du journal d'e-mails ;
//   - le PDF de confirmation (src/services/confirmation-pdf.ts), qui porte les
//     conditions générales en annexe : le mail ne les recopie plus.
// La page « voucher » du site (public/book/voucher.html) reste la consultation
// en ligne ; seul le MAIL ne s'appelle plus ainsi.
//
// Toute donnée venant du client ou de la base passe par esc() dans le HTML, et
// par oneLine() dans le texte (pas de saut de ligne glissé dans un nom).

import type { BookingRow, PropertyRow, PropertySettings } from "../db/repo";
import { nlText } from "../core/public-i18n";
import { CGV_NL_NOTE, formatDateFr, isNl, money, parseQuote, postalAddress, realContact } from "./email";

export interface ConfirmationContext {
  booking: BookingRow;
  property: PropertyRow;
  settings: PropertySettings;
  /** Page de la réservation (référence + email), cf. voucherUrl(). */
  voucherUrl: string;
  /** Nom du PDF joint, pour le dire dans le mail. */
  attachmentName: string;
}

export interface ConfirmationMail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/** Échappement HTML : texte et valeurs d'attribut (guillemets compris). */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Une valeur de saisie ramenée à une ligne (retours à la ligne et espaces multiples écrasés). */
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

interface Words {
  lang: "fr" | "nl";
  hello: (name: string) => string;
  confirmed: string;
  attached: (file: string) => string;
  preheader: (checkin: string, checkout: string) => string;
  title: string;
  recap: string;
  reference: string;
  unit: string;
  arrival: string;
  departure: string;
  guests: (adults: number, children: number) => string;
  guestsLabel: string;
  priceTitle: string;
  total: string;
  alreadyPaid: string;
  balance: string;
  balanceDue: (date: string) => string;
  settled: string;
  button: string;
  buttonHint: string;
  know: string;
  fromTime: (time: string) => string;
  beforeTime: (time: string) => string;
  kArrival: (time: string, date: string) => string;
  kDeparture: (time: string, date: string) => string;
  kAddress: string;
  kContact: string;
  kBalance: (amount: string, date: string | null) => string;
  kCaution: (amount: string) => string;
  kDocument: (file: string) => string;
  kCancel: string;
  kLanguage: string | null;
  closing: string;
  subject: (ref: string, name: string) => string;
}

const FR: Words = {
  lang: "fr",
  hello: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
  confirmed: "Votre réservation est confirmée — merci de votre confiance !",
  attached: (f) => `Vous trouverez en pièce jointe la confirmation de votre réservation et les conditions générales (${f}). Conservez ce document.`,
  preheader: (a, d) => `Votre séjour du ${a} au ${d} est confirmé. La confirmation et les conditions générales sont en pièce jointe.`,
  title: "Confirmation de réservation",
  recap: "Votre séjour",
  reference: "Référence",
  unit: "Hébergement",
  arrival: "Arrivée",
  departure: "Départ",
  guestsLabel: "Voyageurs",
  guests: (a, c) => `${a + c} personne${a + c > 1 ? "s" : ""}${c > 0 ? ` (dont ${c} enfant${c > 1 ? "s" : ""})` : ""}`,
  priceTitle: "Détail du prix",
  total: "Total",
  alreadyPaid: "Déjà payé",
  balance: "Solde restant",
  balanceDue: (d) => `à régler pour le ${d}`,
  settled: "Votre séjour est intégralement réglé.",
  button: "Voir ma réservation",
  buttonHint: "Retrouvez votre réservation, payez votre solde et écrivez-nous depuis cette page :",
  know: "Ce que vous devez savoir",
  fromTime: (t) => `à partir de ${t}`,
  beforeTime: (t) => `avant ${t}`,
  kArrival: (t, d) => `Arrivée le ${d}, à partir de ${t}.`,
  kDeparture: (t, d) => `Départ le ${d}, avant ${t}.`,
  kAddress: "Adresse",
  kContact: "Une question ? Répondez simplement à ce message, ou contactez-nous",
  kBalance: (a, d) => `Le solde de ${a} est à régler${d ? ` au plus tard le ${d}` : ""}, en ligne depuis la page de votre réservation.`,
  kCaution: (a) => `Caution de ${a} : empreinte ou dépôt demandé avant l'arrivée, restitué après l'état des lieux.`,
  kDocument: (f) => `Votre réservation est conclue par l'acceptation des conditions générales et le paiement des arrhes. Rien à signer : le document joint (${f}) en garde la trace.`,
  kCancel: "Annulation : article 5 des conditions générales, jointes à ce message. Un e-mail rappelant votre référence suffit pour nous joindre.",
  kLanguage: null,
  closing: "À très bientôt,",
  subject: (r, p) => `[${r}] Votre réservation est confirmée — ${p}`,
};

const NL: Words = {
  lang: "nl",
  hello: (n) => (n ? `Beste ${n},` : "Beste,"),
  confirmed: "Uw reservering is bevestigd — dank u wel voor uw vertrouwen!",
  attached: (f) => `In bijlage vindt u de bevestiging van uw reservering en de algemene voorwaarden (${f}). Bewaar dit document goed.`,
  preheader: (a, d) => `Uw verblijf van ${a} tot ${d} is bevestigd. De bevestiging en de algemene voorwaarden zitten als bijlage bij dit bericht.`,
  title: "Bevestiging van reservering",
  recap: "Uw verblijf",
  reference: "Referentie",
  unit: "Accommodatie",
  arrival: "Aankomst",
  departure: "Vertrek",
  guestsLabel: "Gasten",
  guests: (a, c) => `${a + c} ${a + c > 1 ? "personen" : "persoon"}${c > 0 ? ` (waarvan ${c} ${c > 1 ? "kinderen" : "kind"})` : ""}`,
  priceTitle: "Prijsdetail",
  total: "Totaal",
  alreadyPaid: "Al betaald",
  balance: "Resterend saldo",
  balanceDue: (d) => `te betalen tegen ${d}`,
  settled: "Uw verblijf is volledig betaald.",
  button: "Mijn reservering bekijken",
  buttonHint: "Op deze pagina vindt u uw reservering terug, betaalt u uw saldo en kunt u ons schrijven:",
  know: "Goed om te weten",
  fromTime: (t) => `vanaf ${t}`,
  beforeTime: (t) => `voor ${t}`,
  kArrival: (t, d) => `Aankomst op ${d}, vanaf ${t}.`,
  kDeparture: (t, d) => `Vertrek op ${d}, voor ${t}.`,
  kAddress: "Adres",
  kContact: "Een vraag? Antwoord gewoon op dit bericht, of neem contact met ons op",
  kBalance: (a, d) => `Het saldo van ${a} moet betaald worden${d ? ` uiterlijk op ${d}` : ""}, online via de pagina van uw reservering.`,
  kCaution: (a) => `Waarborg van ${a}: kaartafdruk of storting gevraagd voor aankomst, terugbetaald na de plaatsbeschrijving.`,
  kDocument: (f) => `Uw reservering komt tot stand door de aanvaarding van de algemene voorwaarden en de betaling van het voorschot. U hoeft niets te ondertekenen: het bijgevoegde document (${f}) bewaart er het spoor van.`,
  kCancel: "Annulering: artikel 5 van de algemene voorwaarden, als bijlage bij dit bericht. Een e-mail met uw referentie volstaat om ons te bereiken.",
  kLanguage: CGV_NL_NOTE,
  closing: "Tot binnenkort,",
  subject: (r, p) => `[${r}] Uw reservering is bevestigd — ${p}`,
};

/** Rangée d'un tableau de la version HTML. */
function row(label: string, value: string, opts: { bold?: boolean; strong?: boolean } = {}): string {
  const w = opts.bold ? "font-weight:bold;" : "";
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #eceae4;color:#5b5b55;font-size:14px;${w}">${esc(label)}</td><td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid #eceae4;font-size:14px;color:#1c1c19;${w}">${value}</td></tr>`;
}

function section(title: string, inner: string): string {
  return `<h2 style="margin:26px 0 6px;font:bold 15px Georgia,'Times New Roman',serif;color:#1f4533;letter-spacing:.2px">${esc(title)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${inner}</table>`;
}

export function buildConfirmationEmail(ctx: ConfirmationContext): ConfirmationMail {
  const { booking: b, property, settings } = ctx;
  const nl = isNl(b);
  const w = nl ? NL : FR;
  const quote = parseQuote(b);
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const name = oneLine(b.guestName);
  const unit = oneLine(b.unitName);
  const propertyName = oneLine(property.name);
  const m = (cents: number) => money(cents, nl);
  const label = (l: { label: string; publicLabel?: string }) => oneLine(nl ? nlText(l.publicLabel ?? l.label) : (l.publicLabel ?? l.label));
  const checkin = formatDateFr(b.checkin);
  const checkout = formatDateFr(b.checkout);
  const due = b.balanceDueDate ? formatDateFr(b.balanceDueDate) : null;
  const address = oneLine(postalAddress(property));
  const contact = [oneLine(realContact(property.contactEmail)), oneLine(realContact(property.contactPhone))].filter(Boolean);

  // --- texte ---------------------------------------------------------------------
  const t: string[] = [
    w.hello(name),
    ``,
    w.confirmed,
    w.attached(ctx.attachmentName),
    ``,
    w.recap.toUpperCase(),
    `${w.reference} : ${b.reference}`,
    `${w.unit} : ${unit} — ${propertyName}`,
    `${w.arrival} : ${checkin} — ${w.fromTime(settings.checkinTime)}`,
    `${w.departure} : ${checkout} — ${w.beforeTime(settings.checkoutTime)}`,
    `${w.guestsLabel} : ${w.guests(b.adults, b.children)}`,
    ``,
    w.priceTitle.toUpperCase(),
  ];
  if (quote) {
    for (const l of quote.lines) t.push(`  ${label(l).padEnd(52)} ${m(l.amountCents).padStart(12)}`);
    t.push(`  ${w.total.toUpperCase().padEnd(52)} ${m(quote.totalCents).padStart(12)}`);
  } else {
    t.push(`${w.total} : ${m(b.totalCents)}`);
  }
  t.push(``, `${w.alreadyPaid} : ${m(b.paidCents)}`);
  t.push(balance > 0 ? `${w.balance} : ${m(balance)}${due ? ` — ${w.balanceDue(due)}` : ""}` : w.settled);
  t.push(``, `${ctx.voucherUrl.length ? w.buttonHint : ""}`, ctx.voucherUrl, ``, w.know.toUpperCase());
  t.push(`- ${w.kArrival(settings.checkinTime, checkin)}`, `- ${w.kDeparture(settings.checkoutTime, checkout)}`);
  if (address) t.push(`- ${w.kAddress} : ${address}`);
  if (contact.length) t.push(`- ${w.kContact} : ${contact.join(" · ")}`);
  if (balance > 0) t.push(`- ${w.kBalance(m(balance), due)}`);
  if (settings.cautionCents > 0) t.push(`- ${w.kCaution(m(settings.cautionCents))}`);
  t.push(`- ${w.kDocument(ctx.attachmentName)}`, `- ${w.kCancel}`);
  if (w.kLanguage) t.push(`- ${w.kLanguage}`);
  t.push(``, w.closing, propertyName, ...contact);

  // --- HTML ----------------------------------------------------------------------
  const recapRows = [
    row(w.reference, `<span style="font-family:Menlo,Consolas,monospace">${esc(b.reference)}</span>`),
    row(w.unit, esc(unit)),
    row(w.arrival, `${esc(checkin)}<br><span style="color:#5b5b55;font-size:12px">${esc(w.fromTime(settings.checkinTime))}</span>`),
    row(w.departure, `${esc(checkout)}<br><span style="color:#5b5b55;font-size:12px">${esc(w.beforeTime(settings.checkoutTime))}</span>`),
    row(w.guestsLabel, esc(w.guests(b.adults, b.children))),
  ].join("");

  const priceRows: string[] = [];
  if (quote) {
    for (const l of quote.lines) priceRows.push(row(label(l), esc(m(l.amountCents))));
    priceRows.push(row(w.total, esc(m(quote.totalCents)), { bold: true }));
  } else {
    priceRows.push(row(w.total, esc(m(b.totalCents)), { bold: true }));
  }
  priceRows.push(row(w.alreadyPaid, esc(m(b.paidCents))));
  priceRows.push(
    balance > 0
      ? row(w.balance, `${esc(m(balance))}${due ? `<br><span style="color:#5b5b55;font-size:12px">${esc(w.balanceDue(due))}</span>` : ""}`, { bold: true })
      : row(w.settled, ""),
  );

  const know: string[] = [w.kArrival(settings.checkinTime, checkin), w.kDeparture(settings.checkoutTime, checkout)];
  if (address) know.push(`${w.kAddress} : ${address}`);
  if (contact.length) know.push(`${w.kContact} : ${contact.join(" · ")}`);
  if (balance > 0) know.push(w.kBalance(m(balance), due));
  if (settings.cautionCents > 0) know.push(w.kCaution(m(settings.cautionCents)));
  know.push(w.kDocument(ctx.attachmentName), w.kCancel);
  if (w.kLanguage) know.push(w.kLanguage);

  const bodyHtml = `<!doctype html>
<html lang="${w.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.subject(b.reference, propertyName))}</title></head>
<body style="margin:0;padding:0;background:#f3f1ec">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f1ec">${esc(w.preheader(checkin, checkout))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#1c1c19">
<tr><td style="background:#1f4533;padding:26px 28px"><div style="font:bold 22px Georgia,'Times New Roman',serif;color:#ffffff">${esc(propertyName)}</div><div style="margin-top:4px;font-size:13px;color:#cfe0d6;letter-spacing:.6px;text-transform:uppercase">${esc(w.title)}</div></td></tr>
<tr><td style="padding:26px 28px 8px">
<p style="margin:0 0 10px;font-size:16px;line-height:1.5">${esc(w.hello(name))}</p>
<p style="margin:0 0 10px;font-size:15px;line-height:1.5"><b>${esc(w.confirmed)}</b></p>
<p style="margin:0;font-size:14px;line-height:1.5;color:#3d3d38">${esc(w.attached(ctx.attachmentName))}</p>
${section(w.recap, recapRows)}
${section(w.priceTitle, priceRows.join(""))}
<p style="margin:24px 0 10px;font-size:14px;line-height:1.5;color:#3d3d38">${esc(w.buttonHint)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#1f4533;border-radius:6px"><a href="${esc(ctx.voucherUrl)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">${esc(w.button)}</a></td></tr></table>
<h2 style="margin:28px 0 8px;font:bold 15px Georgia,'Times New Roman',serif;color:#1f4533;letter-spacing:.2px">${esc(w.know)}</h2>
<ul style="margin:0;padding:0 0 0 18px;font-size:14px;line-height:1.55;color:#2b2b27">${know.map((k) => `<li style="margin:0 0 6px">${esc(k)}</li>`).join("")}</ul>
<p style="margin:26px 0 2px;font-size:14px">${esc(w.closing)}</p>
<p style="margin:0 0 4px;font-size:14px;font-weight:bold">${esc(propertyName)}</p>
<p style="margin:0 0 24px;font-size:13px;color:#5b5b55">${contact.map(esc).join(" · ")}</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  return { subject: w.subject(b.reference, propertyName), bodyText: t.join("\n"), bodyHtml };
}
