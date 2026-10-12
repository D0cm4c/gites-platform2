// « Confirmation de réservation et conditions générales » en PDF (FR / NL),
// joint au mail de confirmation et servi par
// /api/admin/bookings/:id/confirmation.pdf et
// /api/public/bookings/:ref/confirmation.pdf (`contrat.pdf` reste un alias des
// deux routes, pour les liens déjà envoyés).
//
// Décision de Julien du 12/10/2026 : ce document n'est plus un « contrat ». Les
// conditions générales et la trace de leur acceptation (version, date, heure,
// IP) suffisent. Page 1 : le récapitulatif de la réservation et le rappel de
// sa conclusion (acceptation des CGV + paiement des arrhes). Ensuite, en
// annexe, le texte intégral des CGV en base (`settings.cgv_text`).
//
// RÈGLE : le document ne crée AUCUNE règle. Les chiffres viennent de la
// réservation (devis figé, arrhes, échéance du solde) ; les règles de paiement
// et d'annulation sont celles des CGV en base. Le néerlandais traduit les
// libellés ; les CGV n'existent qu'en français et font foi (CGV_NL_NOTE).
//
// Pour changer le texte : docs/confirmation-pdf.md.

import type { BookingRow, GuestRow, PropertyRow, PropertySettings } from "../db/repo";
import { getBooking, getCgvAcceptance, getGuest, getProperty, getSettings } from "../db/repo";
import { PdfDocument, type TableOptions } from "../core/pdf";
import { nlText } from "../core/public-i18n";
import { CGV_NL_NOTE, formatDateFr, isNl, money, parseQuote, postalAddress, realContact } from "./email";
import { contractualArrhes } from "./annulation";

export interface ConfirmationPdfContext {
  booking: BookingRow;
  property: PropertyRow;
  settings: PropertySettings;
  guest: GuestRow | null;
  acceptance: { version: string | null; acceptedAt: string | null; ip: string | null };
  /** Date d'émission du document (maintenant par défaut ; injectable pour les tests). */
  issuedAt?: Date;
}

/** Nom du fichier joint : Confirmation-<référence>.pdf, référence assainie. */
export function confirmationFileName(reference: string): string {
  return `Confirmation-${reference.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf`;
}

/** Charge tout ce qu'il faut au document ; null si la réservation (ou son domaine) n'existe pas. */
export async function loadConfirmationPdfContext(db: D1Database, bookingId: number): Promise<ConfirmationPdfContext | null> {
  const booking = await getBooking(db, bookingId);
  if (!booking || booking.propertyId == null) return null;
  const property = await getProperty(db, booking.propertyId);
  if (!property) return null;
  const [settings, guest, acceptance] = await Promise.all([
    getSettings(db, booking.propertyId),
    booking.guestId != null ? getGuest(db, booking.guestId) : Promise.resolve(null),
    getCgvAcceptance(db, booking.id),
  ]);
  return { booking, property, settings, guest, acceptance };
}

// --- extraits des CGV ---------------------------------------------------------------

/** Bloc « Article n — … » des CGV (titre compris), ou null. */
export function cgvArticle(cgv: string, n: number): string | null {
  const lines = cgv.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^Article ${n} [—–-]`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^Article \d+ [—–-]/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").trim();
}

/** « 3.1 » dans « Version 3.1 — 12 octobre 2026… », ou null. */
export function cgvVersionLabel(cgv: string): string | null {
  return /^Version\s+([0-9]+(?:\.[0-9]+)*)/m.exec(cgv)?.[1] ?? null;
}

/** « 3.1 » dans la version ENREGISTRÉE à l'acceptation (« v3.1+sha256:… »), ou null
 *  (acceptations d'avant la 3.1 : hash seul). */
export function acceptedVersionLabel(stored: string | null): string | null {
  return stored ? (/^v([0-9]+(?:\.[0-9]+)*)\+/.exec(stored)?.[1] ?? null) : null;
}

/** Phrase « L'exploitant est … » de l'article 1, ou null. */
function cgvExploitant(cgv: string): string | null {
  const art = cgvArticle(cgv, 1);
  const m = art ? /L['’]exploitant est [^\n]*?\.(?=\s|$)/.exec(art) : null;
  return m ? m[0] : null;
}

// --- dates -------------------------------------------------------------------------

const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const JOURS_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** « samedi 12 septembre 2026 » depuis AAAA-MM-JJ. */
function longDate(iso: string, nl: boolean): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${(nl ? JOURS_NL : JOURS_FR)[dow]} ${d}${!nl && d === 1 ? "er" : ""} ${(nl ? MOIS_NL : MOIS_FR)[m - 1]} ${y}`;
}

/** Date et heure de Bruxelles depuis un horodatage SQL UTC (« AAAA-MM-JJ HH:MM:SS »). */
function acceptanceStamp(sql: string): { date: string; time: string } | null {
  const d = new Date(`${sql.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("day")}/${get("month")}/${get("year")}`, time: `${get("hour")}:${get("minute")}` };
}

// --- textes -------------------------------------------------------------------------

interface Words {
  title: string;
  ref: string;
  madeOn: (date: string) => string;
  parties: string;
  operator: string;
  operatorCgv: string;
  client: string;
  unit: string;
  stay: string;
  arrival: string;
  departure: string;
  fromTime: (t: string) => string;
  beforeTime: (t: string) => string;
  nights: (n: number) => string;
  guests: string;
  guestsValue: (a: number, c: number) => string;
  price: string;
  priceHeader: [string, string];
  total: string;
  payment: string;
  fullAtBooking: (amount: string) => string;
  arrhesPart: (amount: string, pct: number | null) => string;
  deposit: (amount: string, pct: number | null) => string;
  balance: (amount: string, date: string) => string;
  paid: (amount: string, date: string) => string;
  caution: (amount: string) => string;
  cancelRule: string;
  conclusion: string;
  cgvNl: string | null;
  concludedOn: (version: string | null, date: string, time: string, ip: string | null) => string;
  concludedNoTrace: (version: string | null) => string;
  privacy: string;
  annex: string;
  footer: (ref: string, property: string) => string;
  pageLabel: string;
  subject: string;
}

const FR: Words = {
  title: "CONFIRMATION DE RÉSERVATION",
  ref: "Référence de réservation",
  madeOn: (d) => `Réservation du ${d}`,
  parties: "1. Exploitant et client",
  operator: "L'exploitant",
  operatorCgv: "Selon l'article 1 des conditions générales",
  client: "Le client",
  unit: "2. L'hébergement",
  stay: "3. Le séjour",
  arrival: "Arrivée",
  departure: "Départ",
  fromTime: (t) => `à partir de ${t}`,
  beforeTime: (t) => `avant ${t}`,
  nights: (n) => `${n} nuit${n > 1 ? "s" : ""}`,
  guests: "Occupants",
  guestsValue: (a, c) => `${a + c} personne${a + c > 1 ? "s" : ""}${c > 0 ? ` (dont ${c} enfant${c > 1 ? "s" : ""})` : ""}`,
  price: "4. Le prix",
  priceHeader: ["Désignation", "Montant"],
  total: "Prix total du séjour",
  payment: "5. Paiement",
  fullAtBooking: (a) => `La totalité du prix, soit ${a}, est payable à la réservation.`,
  arrhesPart: (a, p) => `Dont arrhes : ${a}${p != null ? ` (${p} % du prix total)` : ""}, au sens des articles 4 et 5 des conditions générales.`,
  deposit: (a, p) => `Arrhes payées à la réservation : ${a}${p != null ? ` (${p} % du prix total)` : ""}.`,
  balance: (a, d) => `Solde : ${a}, à payer au plus tard le ${d}.`,
  paid: (a, d) => `Montant réglé au ${d} : ${a}.`,
  caution: (a) => `Une caution de ${a} est demandée avant l'arrivée (empreinte de carte ou dépôt) et restituée après l'état des lieux.`,
  cancelRule: "Annulation : article 5 des conditions générales ci-après.",
  conclusion: "6. Conclusion de la réservation",
  cgvNl: null,
  concludedOn: (v, d, t, ip) => `Réservation conclue par l'acceptation des conditions générales${v ? ` v${v}` : ""} le ${d} à ${t}${ip ? ` depuis l'adresse IP ${ip}` : ""} et le paiement des arrhes.`,
  concludedNoTrace: (v) => `Réservation conclue par l'acceptation des conditions générales${v ? ` v${v}` : ""} et le paiement des arrhes.`,
  privacy: "Les données du client servent uniquement à la gestion de sa réservation et de son séjour.",
  annex: "ANNEXE — CONDITIONS GÉNÉRALES DE LOCATION",
  footer: (r, p) => `Confirmation de réservation ${r} — ${p}`,
  pageLabel: "Page",
  subject: "Confirmation de réservation et conditions générales",
};

const NL: Words = {
  title: "BEVESTIGING VAN RESERVERING",
  ref: "Reserveringsreferentie",
  madeOn: (d) => `Reservering van ${d}`,
  parties: "1. Uitbater en klant",
  operator: "De uitbater",
  operatorCgv: "Volgens artikel 1 van de algemene voorwaarden",
  client: "De klant",
  unit: "2. De accommodatie",
  stay: "3. Het verblijf",
  arrival: "Aankomst",
  departure: "Vertrek",
  fromTime: (t) => `vanaf ${t}`,
  beforeTime: (t) => `voor ${t}`,
  nights: (n) => `${n} ${n > 1 ? "nachten" : "nacht"}`,
  guests: "Gasten",
  guestsValue: (a, c) => `${a + c} ${a + c > 1 ? "personen" : "persoon"}${c > 0 ? ` (waarvan ${c} ${c > 1 ? "kinderen" : "kind"})` : ""}`,
  price: "4. De prijs",
  priceHeader: ["Omschrijving", "Bedrag"],
  total: "Totale prijs van het verblijf",
  payment: "5. Betaling",
  fullAtBooking: (a) => `De volledige prijs, namelijk ${a}, is betaalbaar bij de reservering.`,
  arrhesPart: (a, p) => `Waarvan voorschot: ${a}${p != null ? ` (${p} % van de totale prijs)` : ""}, in de zin van de artikelen 4 en 5 van de algemene voorwaarden.`,
  deposit: (a, p) => `Bij de reservering betaald voorschot: ${a}${p != null ? ` (${p} % van de totale prijs)` : ""}.`,
  balance: (a, d) => `Saldo: ${a}, te betalen uiterlijk op ${d}.`,
  paid: (a, d) => `Betaald bedrag op ${d}: ${a}.`,
  caution: (a) => `Een waarborg van ${a} wordt gevraagd voor de aankomst (kaartafdruk of storting) en na de plaatsbeschrijving terugbetaald.`,
  cancelRule: "Annulering: artikel 5 van de algemene voorwaarden hierna (in het Frans).",
  conclusion: "6. Totstandkoming van de reservering",
  cgvNl: CGV_NL_NOTE,
  concludedOn: (v, d, t, ip) => `Reservering tot stand gekomen door de aanvaarding van de algemene voorwaarden${v ? ` v${v}` : ""} op ${d} om ${t}${ip ? ` vanaf IP-adres ${ip}` : ""} en de betaling van het voorschot.`,
  concludedNoTrace: (v) => `Reservering tot stand gekomen door de aanvaarding van de algemene voorwaarden${v ? ` v${v}` : ""} en de betaling van het voorschot.`,
  privacy: "De gegevens van de klant dienen uitsluitend voor het beheer van zijn reservering en zijn verblijf.",
  annex: "BIJLAGE — ALGEMENE VERHUURVOORWAARDEN (FRANS)",
  footer: (r, p) => `Bevestiging van reservering ${r} — ${p}`,
  pageLabel: "Pagina",
  subject: "Bevestiging van reservering en algemene voorwaarden",
};

// --- le document ---------------------------------------------------------------------

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export function buildConfirmationPdf(ctx: ConfirmationPdfContext): Uint8Array {
  const { booking: b, property, settings, guest } = ctx;
  const nl = isNl(b);
  const w = nl ? NL : FR;
  const m = (cents: number) => money(cents, nl);
  const quote = parseQuote(b);
  const issued = ctx.issuedAt ?? new Date();
  const issuedIso = issued.toISOString().slice(0, 10);
  const bookedIso = b.createdAt.slice(0, 10);
  const cgv = settings.cgvText || "";
  const propertyName = clean(property.name);
  const cols = (): TableOptions => ({ columns: [{ width: 28, bold: true }, { width: 72 }], size: 9.5 });

  const doc = new PdfDocument({
    title: `${w.subject} ${b.reference}`,
    author: propertyName,
    subject: w.subject,
    date: issued,
    footer: w.footer(b.reference, propertyName),
    pageLabel: w.pageLabel,
  });

  // En-tête
  doc.paragraph(propertyName, { size: 10, bold: true, color: [0.12, 0.27, 0.2], after: 2 });
  doc.heading(w.title, 1);
  doc.paragraph(`${w.ref} : ${b.reference}`, { size: 10.5, bold: true, after: 1 });
  doc.paragraph(w.madeOn(formatDateFr(bookedIso)), { size: 9.5, color: [0.4, 0.4, 0.4], after: 6 });
  doc.rule();

  // 1. Exploitant et client
  doc.heading(w.parties);
  const operatorLines = [
    propertyName,
    clean(postalAddress(property)),
    [clean(realContact(property.contactEmail)), clean(realContact(property.contactPhone))].filter(Boolean).join(" · "),
  ].filter(Boolean);
  const exploitant = cgvExploitant(cgv);
  const guestName = clean(b.guestName) || clean(guest ? `${guest.firstName ?? ""} ${guest.lastName}` : "");
  const guestAddress = [clean(guest?.address), clean(guest?.country)].filter(Boolean).join(", ");
  doc.table(
    [
      [w.operator, [...operatorLines, ...(exploitant ? [`${w.operatorCgv} : ${exploitant}`] : [])].join("\n")],
      [w.client, [guestName, guestAddress, [clean(b.guestEmail), clean(guest?.phone)].filter(Boolean).join(" · ")].filter(Boolean).join("\n")],
    ],
    cols(),
  );

  // 2. Hébergement
  doc.heading(w.unit);
  doc.paragraph(`${clean(b.unitName)} — ${propertyName}`, { bold: true, after: 1 });
  const where = clean(postalAddress(property));
  if (where) doc.paragraph(where, { after: 4 });

  // 3. Séjour
  doc.heading(w.stay);
  const nights = quote?.nights ?? Math.max(1, Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 86_400_000));
  doc.table(
    [
      [w.arrival, `${longDate(b.checkin, nl)}, ${w.fromTime(settings.checkinTime)}`],
      [w.departure, `${longDate(b.checkout, nl)}, ${w.beforeTime(settings.checkoutTime)}`],
      ["", w.nights(nights)],
      [w.guests, w.guestsValue(b.adults, b.children)],
    ],
    cols(),
  );

  // 4. Prix
  doc.heading(w.price);
  const priceRows: string[][] = quote
    ? quote.lines.map((l) => [clean(nl ? nlText(l.publicLabel ?? l.label) : (l.publicLabel ?? l.label)), m(l.amountCents)])
    : [];
  priceRows.push([w.total, m(quote?.totalCents ?? b.totalCents)]);
  doc.table(priceRows, { header: [...w.priceHeader], columns: [{ width: 78 }, { width: 22, align: "right" }], size: 9.5, totalRow: true });

  // 5. Paiement
  doc.heading(w.payment);
  if (b.balanceDueDate == null) {
    doc.paragraph(w.fullAtBooking(m(b.totalCents)), { after: 2 });
    // Prix payé d'avance : la part d'arrhes reste celle du devis (CGV 4.3), c'est
    // elle qui reste acquise si le client annule. Le même calcul que l'annulation.
    const arrhes = contractualArrhes(b);
    if (quote && arrhes > 0 && arrhes < b.totalCents) doc.paragraph(w.arrhesPart(m(arrhes), quote.depositPct), { after: 2 });
  } else {
    const pct = quote ? quote.depositPct : b.totalCents > 0 ? Math.round((b.depositCents / b.totalCents) * 100) : null;
    doc.paragraph(w.deposit(m(b.depositCents), pct), { after: 2 });
    doc.paragraph(w.balance(m(Math.max(0, b.totalCents - b.depositCents)), formatDateFr(b.balanceDueDate)), { after: 2 });
  }
  doc.paragraph(w.paid(m(b.paidCents), formatDateFr(issuedIso)), { after: 2 });
  if (settings.cautionCents > 0) doc.paragraph(w.caution(m(settings.cautionCents)), { after: 2 });
  doc.paragraph(w.cancelRule, { after: 6 });

  // 6. Conclusion : acceptation des CGV (version, date, heure, IP) + paiement des arrhes
  doc.heading(w.conclusion);
  // La version est celle ENREGISTRÉE à l'acceptation quand elle la porte ; à défaut
  // (acceptation d'avant la 3.1), celle du texte en base.
  const version = acceptedVersionLabel(ctx.acceptance.version) ?? cgvVersionLabel(cgv);
  const stamp = ctx.acceptance.acceptedAt ? acceptanceStamp(ctx.acceptance.acceptedAt) : null;
  doc.paragraph(stamp ? w.concludedOn(version, stamp.date, stamp.time, clean(ctx.acceptance.ip) || null) : w.concludedNoTrace(version), { after: 3 });
  if (w.cgvNl) doc.paragraph(w.cgvNl, { size: 9, bold: true, after: 3 });
  doc.paragraph(w.privacy, { after: 3 });

  // Annexe : CGV intégrales
  doc.newPage();
  doc.heading(w.annex, 2);
  if (!cgv.trim()) {
    doc.paragraph("(CGV à compléter)", { after: 4 });
  } else {
    for (const block of cgv.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
      const text = block.trim();
      if (!text) continue;
      if (/^(Article \d+ [—–-]|Comment ça se passe)/.test(text)) {
        const [head, ...rest] = text.split("\n");
        doc.heading(head!, 3);
        if (rest.join("").trim()) doc.paragraph(rest.join("\n").trim(), { size: 8.8, after: 3 });
      } else if (/^CONDITIONS GÉNÉRALES/.test(text)) continue; // le titre de l'annexe le remplace
      else doc.paragraph(text, { size: 8.8, after: 3 });
    }
  }
  return doc.build();
}
