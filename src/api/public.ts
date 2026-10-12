// API publique — page de réservation. Aucune authentification, donc :
// validation stricte des entrées, aucune fuite d'information (une résa n'est
// consultable qu'avec sa référence ET l'email du client), et la disponibilité
// finale est re-garantie par l'INSERT atomique (jamais par la recherche).

import { apiError, json, readJson, Router } from "./router";
import { addDays, diffDays, isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { blockingSourceUnitIds, blocksAsSpans, isUnitFree } from "../core/availability";
import { rateCalendar, type UnitPricingInfo } from "../core/pricing";
import { suggestStays, type NightOption, type StaySuggestion } from "../core/stay-options";
import {
  audit,
  bookingsInWindow,
  cancelBooking,
  countDirectBookingPressure,
  createBookingAtomic,
  findPaymentBySession,
  getBooking,
  getBookingByReference,
  getProperty,
  getQuoteContext,
  getSettings,
  getThread,
  getUnit,
  getUnitByIcalToken,
  insertInboundMessage,
  listLinks,
  listOptionsAdmin,
  listProperties,
  listPromotions,
  listRateRules,
  listRateOverridesForProperty,
  listSeasons,
  listUnitPhotos,
  listUnits,
  manualBlocksInWindow,
  recordCgvAcceptance,
  getCgvAcceptance,
  upsertGuest,
  type BookingRow,
  type UnitPhotoRow,
  type UnitRow,
  listPayments,
} from "../db/repo";
import { pullBeds24Bookings, pushCalendars, triggerBeds24Push } from "../services/beds24-sync";
import {
  handlePaymentSuccess,
  MIN_CHECKOUT_CENTS,
  quoteFromContext,
  startPayment,
  voucherUrl,
  type PaymentStart,
  type QuoteBody,
} from "../services/booking-flow";
import { buildContactAckEmail, queueEmail, realContact, refSubject } from "../services/email";
import { buildConfirmationPdf, cgvVersionLabel, confirmationFileName, loadConfirmationPdfContext } from "../services/confirmation-pdf";
import { publicHealth } from "../services/health";
import { clearHoldCookie, readHoldReference, setHoldCookie } from "../services/hold-session";
import { buildIcs, exportSpansForUnit } from "../services/ical";
import { availabilityHorizon, NON_CUMUL_NOTE, publicPromotions, weekendAvailability } from "../services/offers";
import { logSearch } from "../services/search-log";
import { getSetting } from "../services/settings";
import {
  paymentElementEnabled,
  stripeConfigFromEnv,
  stripeEnabled,
  stripePublishableKey,
  verifyStripeSignature,
} from "../services/stripe";
import { anyStripeConfigured, propertyIdOfPayment, resolveStripeConfig } from "../services/stripe-config";
import { processStripeEvent } from "../services/stripe-webhook";
import { turnstileSiteKey, verifyTurnstile } from "../services/turnstile";
import { registerTaskShareRoutes } from "./tasks-public";

const MAX_NIGHTS = 60;
const MAX_ADVANCE_DAYS = 730; // réservation à 2 ans max

// --- anti-abus du formulaire de réservation (issue #6) ----------------------
// Le blocage de 30 min est posé AVANT tout paiement : sans plafond, un script
// qui boucle sur les combinaisons hébergement × dates gèle indéfiniment tout
// le calendrier de vente directe. Deux garde-fous, purement serveur (aucune
// dépendance externe, rien à configurer), appliqués par email ET par IP :
/** Options de paiement simultanées tolérées pour une même identité. */
export const MAX_ACTIVE_HOLDS = 3;
/** Réservations directes tolérées sur une heure glissante. */
export const MAX_BOOKINGS_PER_HOUR = 8;

// --- suggestions de dates valides (issue #66) -------------------------------
// Quand le séjour demandé est trop court (minimum de nuits) ou tombe un jour
// d'arrivée interdit, la recherche regarde AUTOUR des dates demandées pour
// proposer une plage réellement réservable. La fenêtre est volontairement
// modeste : une suggestion à deux mois de là n'est plus une suggestion.
const SUGGEST_DAYS_BEFORE = 7;
const SUGGEST_DAYS_AFTER = 45;
/** Nombre de plages proposées — « une ou deux », pas une liste à trier. */
const SUGGEST_MAX = 2;

/** Sessions de paiement tolérées sur UNE même option (issue #68).
 *
 *  Une reprise ne crée aucune réservation : elle échappe donc, par
 *  construction, aux deux plafonds de l'issue #6. Sans borne, un porteur de
 *  cookie valide pourrait boucler sur la reprise et faire ouvrir autant de
 *  sessions Stripe. Dix tentatives couvrent très large un vrai client (carte
 *  refusée, retour arrière, changement de navigateur). */
const MAX_HOLD_CHECKOUTS = 10;

interface StayParams {
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
}

/** Valide dates + occupants ; retourne un message d'erreur ou les valeurs. */
function parseStay(raw: { checkin?: unknown; checkout?: unknown; adults?: unknown; children?: unknown }, today: IsoDate):
  | { ok: true; stay: StayParams }
  | { ok: false; message: string } {
  const checkin = String(raw.checkin ?? "");
  const checkout = String(raw.checkout ?? "");
  if (!isIsoDate(checkin) || !isIsoDate(checkout)) return { ok: false, message: "dates invalides (format AAAA-MM-JJ)" };
  if (checkin >= checkout) return { ok: false, message: "le départ doit suivre l'arrivée" };
  if (checkin < today) return { ok: false, message: "l'arrivée ne peut pas être dans le passé" };
  const nights = diffDays(checkin, checkout);
  if (nights > MAX_NIGHTS) return { ok: false, message: `séjour trop long (max ${MAX_NIGHTS} nuits)` };
  if (diffDays(today, checkin) > MAX_ADVANCE_DAYS) return { ok: false, message: "réservation trop lointaine (max 2 ans)" };
  const adults = Math.floor(Number(raw.adults ?? 0));
  const children = Math.floor(Number(raw.children ?? 0));
  if (!Number.isFinite(adults) || adults < 1 || adults > 30) return { ok: false, message: "nombre d'adultes invalide" };
  if (!Number.isFinite(children) || children < 0 || children > 30) return { ok: false, message: "nombre d'enfants invalide" };
  return { ok: true, stay: { checkin, checkout, adults, children } };
}

/** Comparaison de secret à temps constant (même principe que la vérification
 *  de signature Stripe, qui l'appliquait déjà). */
function safeEqualKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isEmailish(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/** Forme publique d'un démarrage de paiement (issue #26).
 *
 *  `checkoutUrl` est conservé tel quel — c'est le contrat que connaissent le
 *  tunnel, le voucher et les tests : en mode intégré il vaut simplement `null`,
 *  et le front bascule alors sur `payment.clientSecret`. Un navigateur resté
 *  sur une ancienne version du JS voit `checkoutUrl: null` et affiche son
 *  message d'erreur, il ne part pas sur une page vide. */
function publicPayment(start: PaymentStart) {
  return {
    checkoutUrl: start.url,
    payment: {
      mode: start.mode,
      clientSecret: start.clientSecret,
      returnUrl: start.returnUrl,
      amountCents: start.amountCents,
      kind: start.kind,
      // Clé PUBLIABLE du compte Stripe de la propriété (jamais la clé secrète).
      publishableKey: start.publishableKey,
    },
  };
}

interface CreateBookingBody extends QuoteBody {
  paymentMode?: "deposit" | "full";
  guest?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    address?: string;
    country?: string;
  };
  notes?: string;
  cgvAccepted?: boolean;
  marketingOptIn?: boolean;
  /** Langue du tunnel : "fr" (défaut) ou "nl". */
  lang?: string;
  /** Jeton du widget Turnstile (issue #6). Absent tant que la fonctionnalité
   *  n'est pas configurée — il n'est alors pas non plus vérifié. */
  turnstileToken?: string;
}

/** Version courte des CGV acceptées : numéro de version lu dans le texte
 *  (« v3.1+ », depuis la 3.1), puis sha256 hex tronqué + longueur du texte.
 *  Le hash prouve QUEL texte était affiché au moment de l'acceptation, le
 *  numéro le dit en clair (document de confirmation, fiche réservation). */
async function cgvVersion(text: string): Promise<string> {
  if (!text.trim()) return "v0-empty";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const label = cgvVersionLabel(text);
  return `${label ? `v${label}+` : ""}sha256:${hex.slice(0, 16)}-len${text.length}`;
}

/** Réservation encore en cours de CE visiteur, d'après son cookie signé.
 *
 *  Trois conditions, toutes nécessaires (issue #68) : la signature doit être
 *  valide, la réservation doit être une option de vente directe encore vivante,
 *  et — quand un domaine est précisé — appartenir à ce domaine. Tout écart
 *  renvoie null : le visiteur redevient un inconnu, jamais le propriétaire du
 *  hold de quelqu'un d'autre. */
async function ownPendingHold(
  env: Env,
  req: Request,
  db: D1Database,
  propertyId: number | null,
  now: string,
): Promise<BookingRow | null> {
  const reference = await readHoldReference(env, req);
  if (!reference) return null;
  const booking = await getBookingByReference(db, reference);
  if (!booking) return null;
  if (booking.status !== "pending" || booking.source !== "direct") return null;
  if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) return null;
  if (propertyId != null && booking.propertyId !== propertyId) return null;
  return booking;
}

/** Coordonnée de contact telle qu'elle peut être montrée au public.
 *  Les seeds portent des valeurs `TODO_…` tant que l'adresse réelle n'est pas
 *  tranchée (issue #4) : elles ne doivent jamais sortir du serveur — ni dans le
 *  tunnel, ni sur le voucher, ni sur les pages légales (issue #9), qui affichent
 *  alors leur repli (« via le formulaire de contact du site »). */
export function publicContact(value: string | null | undefined): string | null {
  return realContact(value);
}

/** Galerie publique d'un hébergement (issue #32).
 *
 *  Le client reçoit le chemin du JPEG et les largeurs WebP disponibles, et
 *  reconstruit `<base>-<largeur>.webp` par convention — c'est exactement ce que
 *  produit `scripts/optimize-images.mjs`, donc rien à stocker de plus.
 *
 *  `alt` et `caption` sortent BRUTS. Ce sont des données, pas du HTML : c'est au
 *  rendu de les échapper (`esc()` côté tunnel, nœuds texte côté galerie). Les
 *  échapper ici les casserait deux fois le jour où un texte contient « & ». */
function publicPhoto(p: UnitPhotoRow): Record<string, unknown> {
  return {
    path: p.path,
    alt: p.alt,
    caption: p.caption,
    webpWidths: p.webpWidths,
    width: p.width,
    height: p.height,
  };
}

/** Photo principale d'un hébergement : la PREMIÈRE de sa galerie quand il en a
 *  une, sinon `units.photo_url`. La dérivation se fait à la lecture et non par
 *  une écriture dans `units` — réordonner la galerie depuis le back-office
 *  change donc la photo principale sans migration ni tâche de fond. */
function mainPhotoUrl(unit: UnitRow, photos: UnitPhotoRow[] | undefined): string | null {
  return photos?.[0]?.path ?? unit.photoUrl;
}

/** Regroupe des photos par hébergement, en conservant l'ordre d'affichage. */
function photosByUnit(rows: UnitPhotoRow[]): Map<number, UnitPhotoRow[]> {
  const out = new Map<number, UnitPhotoRow[]>();
  for (const r of rows) {
    const list = out.get(r.unitId);
    if (list) list.push(r);
    else out.set(r.unitId, [r]);
  }
  return out;
}

export function registerPublicRoutes(router: Router): void {
  // Lien de partage du ménage (GET /t/<jeton>), sans connexion.
  registerTaskShareRoutes(router);

  // --- liste des domaines (landing multi-biens) -------------------------------
  router.get("/api/public/properties", async (_req, env) => {
    const properties = await listProperties(env.DB);
    const out = [];
    for (const p of properties) {
      const units = (await listUnits(env.DB, p.id)).filter((u) => u.active);
      // La vignette du domaine suit la galerie : première photo du premier
      // hébergement qui en a une, sinon l'ancienne `units.photo_url`.
      const gal = photosByUnit(await listUnitPhotos(env.DB, units.map((u) => u.id)));
      out.push({
        slug: p.slug,
        name: p.name,
        address: p.address,
        photoUrl: units.map((u) => mainPhotoUrl(u, gal.get(u.id))).find((v) => v) ?? null,
        unitsCount: units.filter((u) => !u.isComposite).length,
        capacityMax: Math.max(0, ...units.map((u) => u.capacityMax)),
      });
    }
    return json({ properties: out });
  });

  // --- fiche domaine (pour construire la page de réservation) ---------------
  router.get("/api/public/properties/:slug", async (_req, env, p) => {
    const property = await getProperty(env.DB, p.slug ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");
    const [units, settings, options] = await Promise.all([
      listUnits(env.DB, property.id),
      getSettings(env.DB, property.id),
      listOptionsAdmin(env.DB, property.id),
    ]);
    // Une seule requête pour toute la galerie du domaine : le tunnel affiche
    // les vignettes de chaque hébergement sans aller-retour supplémentaire.
    const gal = photosByUnit(await listUnitPhotos(env.DB, units.map((u) => u.id)));
    return json({
      property: {
        slug: property.slug,
        name: property.name,
        address: property.address,
        commune: property.commune,
        contactEmail: publicContact(property.contactEmail),
        contactPhone: publicContact(property.contactPhone),
      },
      units: units
        .filter((u) => u.active)
        .map((u) => ({
          id: u.id,
          slug: u.slug,
          name: u.name,
          description: u.description,
          capacityBase: u.capacityBase,
          capacityMax: u.capacityMax,
          isComposite: u.isComposite,
          cleaningFeeCents: u.cleaningFeeCents,
          photoUrl: mainPhotoUrl(u, gal.get(u.id)),
          photos: (gal.get(u.id) ?? []).map(publicPhoto),
          // Pourcentage d'arrhes EFFECTIF de l'hébergement (issue #75) : le
          // tunnel l'annonce avant même d'avoir un devis, et le repli sur le
          // domaine est résolu ici plutôt que dans le navigateur.
          depositPct: u.depositPct ?? settings.depositPct,
        })),
      options: options.filter((o) => o.active),
      settings: {
        checkinTime: settings.checkinTime,
        checkoutTime: settings.checkoutTime,
        depositPct: settings.depositPct,
        balanceDueDays: settings.balanceDueDays,
        cautionCents: settings.cautionCents,
        allowDeposit: settings.allowDeposit,
        allowFullPayment: settings.allowFullPayment,
        holdMinutes: settings.holdMinutes,
      },
      cgvText: settings.cgvText,
    });
  });

  // --- galerie d'un hébergement (pages de gîtes, issue #32) ------------------
  //
  // Endpoint dédié plutôt que la fiche complète du domaine : une page de gîte
  // n'a besoin ni des tarifs, ni des options, ni du texte des CGV. Les pages
  // servent déjà la galerie en HTML — cet appel ne fait que rejouer l'ordre et
  // l'éditorial du back-office par-dessus.
  router.get("/api/public/photos", async (_req, env, _p, url) => {
    const property = await getProperty(env.DB, url.searchParams.get("property") ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");
    const slug = (url.searchParams.get("unit") ?? "").trim();
    const unit = (await listUnits(env.DB, property.id)).find((u) => u.slug === slug && u.active);
    if (!unit) return apiError(404, "hébergement inconnu");
    const photos = await listUnitPhotos(env.DB, [unit.id]);
    return json({ unit: unit.slug, photos: photos.map(publicPhoto) });
  });

  // --- recherche de disponibilité -------------------------------------------
  router.get("/api/public/availability", async (req, env, _p, url, execCtx) => {
    const db = env.DB;
    const today = todayInZone();
    const parsed = parseStay(
      {
        checkin: url.searchParams.get("checkin"),
        checkout: url.searchParams.get("checkout"),
        adults: url.searchParams.get("adults") ?? "2",
        children: url.searchParams.get("children") ?? "0",
      },
      today,
    );
    if (!parsed.ok) return apiError(400, parsed.message);
    const { checkin, checkout, adults, children } = parsed.stay;
    const nights = diffDays(checkin, checkout);

    const property = await getProperty(db, url.searchParams.get("property") ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");

    // Fenêtre élargie : les suggestions (issue #66) ont besoin de voir ce qu'il
    // y a AUTOUR du séjour demandé, et le même chargement sert aux deux usages.
    // Elle est bornée par l'horizon de réservation : une plage proposée doit
    // pouvoir être réservée telle quelle, sinon le clic rouvre l'impasse.
    const horizon = addDays(today, MAX_ADVANCE_DAYS);
    const suggestFrom = addDays(checkin, -SUGGEST_DAYS_BEFORE) > today ? addDays(checkin, -SUGGEST_DAYS_BEFORE) : today;
    const wideTo = addDays(checkin, Math.max(SUGGEST_DAYS_AFTER, nights + SUGGEST_DAYS_BEFORE));
    const suggestTo = wideTo > horizon ? horizon : wideTo;

    const [units, links, bookings, blocks] = await Promise.all([
      listUnits(db, property.id),
      listLinks(db, property.id),
      bookingsInWindow(db, property.id, suggestFrom, suggestTo),
      manualBlocksInWindow(db, property.id, suggestFrom, suggestTo),
    ]);
    // Photo principale des cartes de résultat : la première de la galerie
    // (issue #32). Les vignettes complètes, elles, viennent de la fiche du
    // domaine déjà chargée par le tunnel — inutile de les répéter ici.
    const gal = photosByUnit(await listUnitPhotos(db, units.map((u) => u.id)));
    const now = sqlNow();

    // Réservation en cours de CE visiteur (issue #68) : son propre blocage ne
    // doit pas lui interdire ses propres dates. Le cookie est signé — une
    // référence devinée ne donne rien.
    const own = await ownPendingHold(env, req, db, property.id, now);

    // Les blocages manuels (travaux, usage personnel) occupent le stock comme
    // une réservation : le tunnel public ne doit jamais proposer ces nuits.
    const spans = [
      ...bookings
        .filter((b) => b.id !== own?.id)
        .map((b) => ({
          unitId: b.unitId,
          checkin: b.checkin,
          checkout: b.checkout,
          status: b.status,
          holdExpiresAt: b.holdExpiresAt,
        })),
      ...blocksAsSpans(blocks),
    ];
    const persons = adults + children;

    const out = [];
    for (const u of units.filter((x) => x.active)) {
      const available = isUnitFree(u.id, checkin, checkout, spans, links, now);
      const fitsCapacity = persons <= u.capacityMax;
      let quote: Record<string, unknown> | null = null;
      let suggestions: (StaySuggestion & { totalCents: number })[] = [];
      if (fitsCapacity) {
        const ctx = await getQuoteContext(db, u.id, { from: suggestFrom, toExclusive: suggestTo });
        if (ctx) {
          const q = available
            ? quoteFromContext(ctx, { unitId: u.id, checkin, checkout, adults, children }, today)
            : null;
          if (q) {
            quote = {
              ok: q.ok,
              errors: q.errors,
              nights: q.nights,
              minNights: q.minNights,
              // La règle des jours d'arrivée était invisible : le tunnel doit
              // pouvoir la DIRE, pas seulement refuser (issue #66).
              checkinDays: q.checkinDays,
              totalCents: q.totalCents,
              depositCents: q.depositCents,
              depositPct: q.depositPct,
              // Remise déjà appliquée par le moteur : sans ces deux champs, la
              // carte de résultat affichait un prix remisé SANS le dire, et la
              // remise ne se découvrait qu'au devis (issue #35).
              discountCents: q.discountCents,
              autoDiscountApplied: q.autoDiscountApplied,
              // La carte annonçait « ménage et taxes compris » quelle que soit
              // la commune : sans ce champ, elle ne peut pas dire la vérité
              // quand la taxe de séjour vaut 0 (issue #47-3).
              taxCents: q.taxCents,
            };
          }
          // Rien de réservable à ces dates → on propose ce qui l'est. C'est ce
          // qui remplace le « indisponible » sans explication (issue #66).
          if (!q || !q.ok) {
            const days: NightOption[] = rateCalendar(
              ctx.pricingUnit,
              suggestFrom,
              suggestTo,
              ctx.seasons,
              ctx.rateRules,
              ctx.rateOverrides,
            ).map((r) => ({
              date: r.date,
              available: r.date >= today && isUnitFree(u.id, r.date, addDays(r.date, 1), spans, links, now),
              minNights: r.minNights,
              checkinDays: r.checkinDays,
            }));
            suggestions = suggestStays(days, { checkin, nights }, SUGGEST_MAX)
              .map((sug) => {
                const sq = quoteFromContext(
                  ctx,
                  { unitId: u.id, checkin: sug.checkin, checkout: sug.checkout, adults, children },
                  today,
                );
                return { ...sug, totalCents: sq.ok ? sq.totalCents : -1 };
              })
              // Une suggestion qui ne passerait pas parseStay au clic (séjour
              // au-delà du plafond de nuits) n'est pas une suggestion.
              .filter((sug) => sug.totalCents >= 0 && sug.nights <= MAX_NIGHTS && sug.checkin <= horizon);
          }
        }
      }
      out.push({
        unitId: u.id,
        slug: u.slug,
        name: u.name,
        description: u.description,
        capacityBase: u.capacityBase,
        capacityMax: u.capacityMax,
        isComposite: u.isComposite,
        photoUrl: mainPhotoUrl(u, gal.get(u.id)),
        cleaningFeeCents: u.cleaningFeeCents,
        available,
        // Pourquoi cette unité n'est pas réservable : les unités LIÉES dont une
        // occupation recouvre le séjour. Sans ce champ, le tunnel ne pouvait
        // dire que « déjà réservé » — le visiteur ne savait pas laquelle des
        // deux maisons faisait tomber le Domaine entier (issue #45). Vide
        // quand l'unité est libre, ou quand c'est sa propre résa qui occupe.
        blockedByUnitIds: available ? [] : blockingSourceUnitIds(u.id, checkin, checkout, spans, links, now),
        fitsCapacity,
        quote,
        suggestions,
      });
    }
    // Journal des recherches (issue #36) : ce que les clients cherchent, et
    // surtout ce qu'ils ne trouvent pas. Aucune donnée identifiante — dates,
    // occupants, résultat. Écriture hors du chemin de réponse quand c'est
    // possible, et jamais bloquante.
    await logSearch(db, execCtx, {
      propertyId: property.id,
      unitId: null, // recherche sur tout le domaine
      stage: "search",
      checkin,
      checkout,
      adults,
      children,
      results: out.filter((u) => u.available && u.fitsCapacity && (u.quote as { ok?: boolean } | null)?.ok === true).length,
    });
    return json({
      property: property.slug,
      checkin,
      checkout,
      adults,
      children,
      units: out,
      // Reprise en cours : le tunnel s'en sert pour rouvrir la bonne étape.
      ownHold: own
        ? { reference: own.reference, unitId: own.unitId, checkin: own.checkin, checkout: own.checkout, holdExpiresAt: own.holdExpiresAt, now }
        : null,
    });
  });

  // --- calendrier public : disponibilité + prix par nuit, par bien -----------
  //     (modèle elloha : le client voit les jours libres et le tarif affiché)
  router.get("/api/public/calendar", async (_req, env, _p, url) => {
    const db = env.DB;
    const property = await getProperty(db, url.searchParams.get("property") ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");
    const monthParam = url.searchParams.get("month") ?? "";
    const today = todayInZone();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : today.slice(0, 7);
    const from = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const to = m === 12 ? `${(y ?? 0) + 1}-01-01` : `${y}-${String((m ?? 0) + 1).padStart(2, "0")}-01`;

    // Les surcharges par jour entrent ici aussi : sans elles, le calendrier
    // public afficherait le prix de saison tandis que le devis facturerait la
    // surcharge — un écart visible du client, entre l'annonce et le paiement.
    const [units, links, seasons, rules, overrides, rows, blocks] = await Promise.all([
      listUnits(db, property.id),
      listLinks(db, property.id),
      listSeasons(db, property.id),
      listRateRules(db, property.id),
      listRateOverridesForProperty(db, property.id, from, to),
      bookingsInWindow(db, property.id, from, to),
      manualBlocksInWindow(db, property.id, from, to),
    ]);
    const now = sqlNow();
    const spans = [
      ...rows.map((b) => ({
        unitId: b.unitId, checkin: b.checkin, checkout: b.checkout,
        status: b.status, holdExpiresAt: b.holdExpiresAt,
      })),
      ...blocksAsSpans(blocks),
    ];
    const active = units.filter((u) => u.active);
    const physicalIds = new Set(active.filter((u) => !u.isComposite).map((u) => u.id));

    const toPricingUnit = (u: UnitRow): UnitPricingInfo => ({
      id: u.id,
      name: u.name,
      compositePricing: u.isComposite ? u.compositePricing : "own",
      cleaningFeeCents: u.cleaningFeeCents,
      depositPct: u.depositPct,
      components: u.isComposite
        ? links
            .filter((l) => l.unitId === u.id && physicalIds.has(l.blocksUnitId))
            .map((l) => {
              const c = active.find((x) => x.id === l.blocksUnitId);
              return { id: l.blocksUnitId, name: c?.name ?? "", cleaningFeeCents: c?.cleaningFeeCents ?? 0 };
            })
        : [],
    });

    const out = active.map((u) => {
      const rates = rateCalendar(toPricingUnit(u), from, to, seasons, rules, overrides);
      return {
        unitId: u.id,
        name: u.name,
        isComposite: u.isComposite,
        days: rates.map((r) => ({
          date: r.date,
          past: r.date < today,
          available: r.date >= today && isUnitFree(u.id, r.date, addDays(r.date, 1), spans, links, now),
          priceCents: r.priceCents,
          minNights: r.minNights,
          // Jours d'arrivée imposés — invisibles jusqu'ici, donc vécus comme
          // un refus arbitraire une fois les dates choisies (issue #66).
          checkinDays: r.checkinDays,
        })),
      };
    });
    return json({ property: property.slug, month, from, today, units: out });
  });

  // --- offres visibles : remises actives + disponibilité factuelle (#35) -----
  //     Les remises existaient en base et ne se découvraient qu'au devis, donc
  //     trop tard pour jouer leur rôle. L'information de disponibilité est
  //     CALCULÉE à chaque appel sur les vraies réservations : elle se vérifie à
  //     la main contre le calendrier public, et ne dit jamais rien de plus que
  //     ce que ce calendrier montre.
  router.get("/api/public/offers", async (_req, env, _p, url) => {
    const db = env.DB;
    const property = await getProperty(db, url.searchParams.get("property") ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");
    const today = todayInZone();
    const horizon = availabilityHorizon(today);

    const [promotions, units, links, bookings, blocks] = await Promise.all([
      listPromotions(db, property.id),
      listUnits(db, property.id),
      listLinks(db, property.id),
      bookingsInWindow(db, property.id, today, horizon),
      manualBlocksInWindow(db, property.id, today, horizon),
    ]);

    const offers = publicPromotions(promotions, today);
    const availability = weekendAvailability({
      today,
      unitIds: units.filter((u) => u.active).map((u) => u.id),
      links,
      bookings: [
        ...bookings.map((b) => ({
          unitId: b.unitId,
          checkin: b.checkin,
          checkout: b.checkout,
          status: b.status,
          holdExpiresAt: b.holdExpiresAt,
        })),
        ...blocksAsSpans(blocks),
      ],
      now: sqlNow(),
    });

    return json({
      property: property.slug,
      today,
      promotions: offers,
      // Le non-cumul n'est une information utile que s'il y a de quoi cumuler.
      nonCumulNote: offers.length > 1 ? NON_CUMUL_NOTE : null,
      availability,
    });
  });

  // --- devis détaillé --------------------------------------------------------
  router.post("/api/public/quote", async (req, env, _p, _url, execCtx) => {
    const body = await readJson<CreateBookingBody>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const today = todayInZone();
    const parsed = parseStay(body, today);
    if (!parsed.ok) return apiError(400, parsed.message);

    const ctx = await getQuoteContext(env.DB, Number(body.unitId));
    if (!ctx || !ctx.unit.active || !ctx.property.active) return apiError(404, "hébergement inconnu");
    const persons = parsed.stay.adults + parsed.stay.children;
    if (persons > ctx.unit.capacityMax) {
      return apiError(400, `capacité dépassée (max ${ctx.unit.capacityMax} personnes)`);
    }
    const quote = quoteFromContext(ctx, { ...body, ...parsed.stay }, today);
    // Deuxième barreau de l'entonnoir : un devis affiché est un pas de plus
    // qu'une recherche. Un devis non réservable (minimum de nuits, jour
    // d'arrivée) compte comme infructueux — c'est bien ce que le client a vécu.
    await logSearch(env.DB, execCtx, {
      propertyId: ctx.property.id,
      unitId: ctx.unit.id,
      stage: "quote",
      checkin: parsed.stay.checkin,
      checkout: parsed.stay.checkout,
      adults: parsed.stay.adults,
      children: parsed.stay.children,
      results: quote.ok ? 1 : 0,
    });
    return json({
      unit: { id: ctx.unit.id, name: ctx.unit.name },
      quote,
      cautionCents: ctx.settings.cautionCents,
    });
  });

  // --- création de réservation (hold + paiement) -----------------------------
  router.post("/api/public/bookings", async (req, env, _p, _url, execCtx) => {
    const db = env.DB;
    const body = await readJson<CreateBookingBody>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const today = todayInZone();
    const parsed = parseStay(body, today);
    if (!parsed.ok) return apiError(400, parsed.message);
    const stay = parsed.stay;

    // client
    const guest = body.guest ?? {};
    const lastName = String(guest.lastName ?? "").trim();
    const email = String(guest.email ?? "").trim();
    if (lastName.length < 2) return apiError(400, "nom du client requis");
    if (!isEmailish(email)) return apiError(400, "email invalide");
    if (body.cgvAccepted !== true) return apiError(400, "l'acceptation des conditions générales est requise");

    // --- anti-robot Turnstile (issue #6, second volet) ----------------------
    // AVANT toute écriture ET avant la reprise d'un hold : un script qui rejoue
    // la requête ne doit pouvoir déclencher ni création, ni nouvelle session de
    // paiement. Sans clés configurées, verifyTurnstile() répond ok sans appel
    // réseau — le parcours est alors strictement celui d'aujourd'hui.
    // Le jeton n'est jamais journalisé : seuls les codes d'erreur de Cloudflare
    // sont tracés, ils n'ont aucune valeur rejouable.
    const captcha = await verifyTurnstile(env, body.turnstileToken, req.headers.get("cf-connecting-ip"));
    if (!captcha.ok) {
      await audit(db, "public", "booking.captcha_refused", null, {
        code: captcha.code,
        codes: captcha.codes,
        ip: req.headers.get("cf-connecting-ip"),
      });
      return apiError(captcha.status, captcha.message, { code: captcha.code });
    }

    // --- reprise d'une réservation en cours (issue #68) ---------------------
    // Un retour arrière depuis la page de paiement laissait le créneau gelé
    // 30 minutes : le MÊME client qui recommençait se voyait refuser ses
    // propres dates. On regarde donc d'abord ce que ce visiteur tient déjà.
    //   · dates + hébergement + client + devis identiques → on REPREND le hold
    //     (aucune ligne créée, donc aucun impact sur le plafond anti-abus) ;
    //   · quoi que ce soit de différent → on LIBÈRE avant de recréer, sinon le
    //     client se bloquerait lui-même sur ses nouvelles dates.
    // Le hold n'est jamais prolongé : le décompte reste celui posé au départ,
    // et le tunnel affiche le temps réellement restant.
    const own = await ownPendingHold(env, req, db, null, sqlNow());
    if (own) {
      const sameStay =
        own.unitId === Number(body.unitId) && own.checkin === stay.checkin && own.checkout === stay.checkout;
      const resumeCtx = sameStay ? await getQuoteContext(db, own.unitId) : null;
      if (resumeCtx) {
        const q = quoteFromContext(resumeCtx, { ...body, ...stay }, today);
        const wantsFullNow = body.paymentMode === "full";
        const fullNow = wantsFullNow || !resumeCtx.settings.allowDeposit || q.balanceDueDate === null;
        const dueNow = fullNow ? q.totalCents : q.depositCents;
        const sameGuest = (own.guestEmail ?? "").toLowerCase() === email.toLowerCase();
        if (q.ok && sameGuest && own.quoteJson === JSON.stringify(q) && own.depositCents === dueNow) {
          const attempts = await listPayments(db, { bookingId: own.id });
          if (attempts.length >= MAX_HOLD_CHECKOUTS) {
            await audit(db, "public", "booking.rate_limited", `booking:${own.id}`, {
              reason: "resume_burst", reference: own.reference, attempts: attempts.length,
            });
            return apiError(
              429,
              "Trop de tentatives de paiement sur cette réservation. Reprenez-la depuis le lien reçu par email, ou contactez-nous : nous la finalisons pour vous.",
              { code: "too_many_resumes" },
            );
          }
          // Les tentatives de paiement précédentes sont soldées par
          // `startPayment` → `voidPendingSessions`, un peu plus bas : c'est LUI
          // qui ferme aussi la tentative chez Stripe et qui refuse d'en ouvrir
          // une seconde quand la première est déjà partie chez la banque du
          // client. La boucle qui marquait ces lignes `failed` ici faisait
          // exactement l'inverse : elle vidait la liste des « pending » avant
          // le contrôle, donc la garde ne voyait plus rien à protéger
          // (contre-review Gemini 2026-08-30).
          await audit(db, "public", "booking.hold_resumed", `booking:${own.id}`, {
            reference: own.reference, unitId: own.unitId, checkin: stay.checkin, checkout: stay.checkout,
          });
          const resumed = await startPayment(db, env, own, fullNow ? "full" : "deposit", dueNow, "public");
          return json(
            {
              reference: own.reference,
              ...publicPayment(resumed),
              amountDueCents: dueNow,
              holdMinutes: resumeCtx.settings.holdMinutes,
              holdExpiresAt: own.holdExpiresAt,
              now: sqlNow(),
              resumed: true,
            },
            200,
            await setHoldCookie(env, own.reference),
          );
        }
      }
      await cancelBooking(db, own.id, "hold_replaced");
      await audit(db, "public", "booking.hold_released", `booking:${own.id}`, {
        reference: own.reference, reason: sameStay ? "devis_modifie" : "sejour_modifie",
      });
    }

    // Anti-abus AVANT toute écriture : ni client créé, ni créneau gelé pour un
    // appelant qui a déjà saturé son quota. Le refus est journalisé — sans
    // trace, une attaque de gel de calendrier resterait invisible.
    // (Turnstile, le second volet de l'issue #6, est vérifié plus haut : il
    //  arrête le script qui varie ses emails et ses IP, que ces plafonds-ci
    //  ne verraient pas.)
    const ip = req.headers.get("cf-connecting-ip");
    const pressure = await countDirectBookingPressure(db, { email, ip });
    if (pressure.activeHolds >= MAX_ACTIVE_HOLDS) {
      await audit(db, "public", "booking.rate_limited", null, { reason: "active_holds", email, ip, ...pressure });
      return apiError(
        429,
        `Vous avez déjà ${pressure.activeHolds} réservations en attente de paiement. Finalisez-en une, ou attendez l'expiration du blocage (30 minutes), avant d'en démarrer une nouvelle.`,
        { code: "too_many_holds" },
      );
    }
    if (pressure.lastHour >= MAX_BOOKINGS_PER_HOUR) {
      await audit(db, "public", "booking.rate_limited", null, { reason: "hourly_burst", email, ip, ...pressure });
      return apiError(
        429,
        "Trop de réservations lancées depuis cette connexion sur la dernière heure. Réessayez dans quelques minutes, ou contactez-nous directement : nous réserverons pour vous.",
        { code: "too_many_bookings" },
      );
    }

    const ctx = await getQuoteContext(db, Number(body.unitId));
    if (!ctx || !ctx.unit.active || !ctx.property.active) return apiError(404, "hébergement inconnu");
    if (stay.adults + stay.children > ctx.unit.capacityMax) {
      return apiError(400, `capacité dépassée (max ${ctx.unit.capacityMax} personnes)`);
    }

    const quote = quoteFromContext(ctx, { ...body, ...stay }, today);
    if (body.promoCode && quote.warnings.includes("promo_invalid")) {
      return apiError(400, "code promo invalide ou expiré");
    }
    if (!quote.ok) {
      return apiError(409, "séjour impossible à ces conditions", { details: quote.errors, minNights: quote.minNights });
    }

    // acompte ou total
    const wantsFull = body.paymentMode === "full";
    const full = wantsFull || !ctx.settings.allowDeposit || quote.balanceDueDate === null;
    const amountDue = full ? quote.totalCents : quote.depositCents;
    if (amountDue < 50) return apiError(400, "montant trop faible pour un paiement en ligne");

    const guestId = await upsertGuest(db, {
      email,
      firstName: String(guest.firstName ?? "").trim() || null,
      lastName,
      phone: String(guest.phone ?? "").trim() || null,
      address: String(guest.address ?? "").trim() || null,
      country: String(guest.country ?? "").trim() || null,
      // Langue du tunnel (lot 3) : les mails et le voucher suivront.
      lang: body.lang === "nl" ? "nl" : "fr",
      marketingOptIn: body.marketingOptIn === true,
    });

    const created = await createBookingAtomic(db, {
      unitId: ctx.unit.id,
      checkin: stay.checkin,
      checkout: stay.checkout,
      adults: stay.adults,
      children: stay.children,
      status: "pending",
      holdMinutes: ctx.settings.holdMinutes,
      source: "direct",
      guestId,
      totalCents: quote.totalCents,
      depositCents: amountDue,
      balanceDueDate: full ? null : quote.balanceDueDate,
      quoteJson: JSON.stringify(quote),
      optionsJson: JSON.stringify(quote.lines.filter((l) => l.kind === "option")),
      promoCode: quote.promoApplied,
      guestNotes: String(body.notes ?? "").trim() || null,
    });
    if (!created.ok) {
      return apiError(409, "cet hébergement vient d'être réservé sur ces dates", { code: "no_longer_available" });
    }
    // preuve d'acceptation des CGV : version (hash serveur du texte affiché),
    // horodatage serveur et IP — la case front seule ne prouverait rien.
    // Langue de CETTE réservation (lot 3) : ses mails et son voucher la suivront.
    await db.prepare("UPDATE bookings SET lang = ?1 WHERE id = ?2").bind(body.lang === "nl" ? "nl" : "fr", created.id).run();
    await recordCgvAcceptance(db, created.id, {
      version: await cgvVersion(ctx.settings.cgvText),
      ip: req.headers.get("cf-connecting-ip"),
    });
    await audit(db, "public", "booking.create", `booking:${created.id}`, {
      reference: created.reference,
      unitId: ctx.unit.id,
      checkin: stay.checkin,
      checkout: stay.checkout,
      amountDue,
      full,
    });

    triggerBeds24Push(db, env, execCtx, ctx.property.id);
    const booking = (await getBooking(db, created.id)) as BookingRow;
    const start = await startPayment(db, env, booking, full ? "full" : "deposit", amountDue, "public");
    return json(
      {
        reference: created.reference,
        ...publicPayment(start),
        amountDueCents: amountDue,
        holdMinutes: ctx.settings.holdMinutes,
        // Fin de blocage ET heure serveur : le tunnel décompte sur l'écart des
        // deux, jamais sur l'horloge du visiteur (issue #16).
        holdExpiresAt: booking.holdExpiresAt,
        now: sqlNow(),
      },
      201,
      // Cookie signé : c'est lui qui permettra de reconnaître ce visiteur et de
      // lui rendre ses propres dates s'il revient en arrière (issue #68).
      await setHoldCookie(env, created.reference),
    );
  });

  // --- réservation en cours de ce visiteur (issue #68) -----------------------
  //     Appelé au chargement du tunnel : s'il existe une option encore vivante
  //     posée depuis ce navigateur, le tunnel rouvre l'étape où le client s'est
  //     arrêté avec le devis EXACT qui a été bloqué — au lieu de lui présenter
  //     ses propres dates comme indisponibles.
  router.get("/api/public/hold", async (req, env, _p, url) => {
    const db = env.DB;
    const now = sqlNow();
    const reference = await readHoldReference(env, req);
    if (!reference) return json({ hold: null });
    const booking = await ownPendingHold(env, req, db, null, now);
    // Cookie valide mais réservation confirmée, annulée ou expirée : on nettoie,
    // sinon le tunnel interrogerait une session morte à chaque chargement.
    if (!booking) return json({ hold: null }, 200, clearHoldCookie(env));

    const property = booking.propertyId != null ? await getProperty(db, booking.propertyId) : null;
    const wanted = url.searchParams.get("property");
    if (wanted && property && property.slug !== wanted) return json({ hold: null });

    const unit = await getUnit(db, booking.unitId);
    let quote: unknown = null;
    try {
      quote = booking.quoteJson ? JSON.parse(booking.quoteJson) : null;
    } catch {
      quote = null;
    }
    return json({
      hold: {
        reference: booking.reference,
        property: property?.slug ?? null,
        unitId: booking.unitId,
        unitSlug: unit?.slug ?? null,
        unitName: booking.unitName ?? null,
        checkin: booking.checkin,
        checkout: booking.checkout,
        adults: booking.adults,
        children: booking.children,
        amountDueCents: booking.depositCents,
        holdExpiresAt: booking.holdExpiresAt,
        now,
        quote,
      },
    });
  });

  // --- consultation voucher (référence + email requis) -----------------------
  router.get("/api/public/bookings/:reference", async (_req, env, p, url) => {
    const db = env.DB;
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    const booking = await getBookingByReference(db, p.reference ?? "");
    if (!booking || !email || (booking.guestEmail ?? "").toLowerCase() !== email) {
      return apiError(404, "réservation introuvable");
    }
    const property = booking.propertyId != null ? await getProperty(db, booking.propertyId) : null;
    const settings = booking.propertyId != null ? await getSettings(db, booking.propertyId) : null;
    // Option ouverte par le back-office : les CGV ne sont pas encore acceptées,
    // la page voucher demande l'acceptation avant le paiement des arrhes.
    const cgvAccepted = (await getCgvAcceptance(db, booking.id)).acceptedAt != null;
    let quoteLines: unknown = null;
    // Pourcentage d'arrhes CONTRACTUEL : celui figé dans le devis au moment de
    // la réservation (issue #75), pas la valeur courante de l'hébergement — le
    // voucher est la pièce du contrat conclu, il ne suit pas les retouches de
    // tarification faites après coup.
    let depositPct: number | null = null;
    try {
      const q = booking.quoteJson ? (JSON.parse(booking.quoteJson) as { lines: unknown; depositPct?: number }) : null;
      quoteLines = q?.lines ?? null;
      depositPct = typeof q?.depositPct === "number" ? q.depositPct : null;
    } catch {
      quoteLines = null;
    }
    return json({
      // Heure SERVEUR : le voucher compare l'expiration de l'option à cette
      // heure-là, jamais à l'horloge du poste, qui peut dériver (issue #47-4).
      now: sqlNow(),
      booking: {
        reference: booking.reference,
        status: booking.status,
        unitName: booking.unitName,
        propertyName: property?.name ?? "",
        checkin: booking.checkin,
        checkout: booking.checkout,
        adults: booking.adults,
        children: booking.children,
        totalCents: booking.totalCents,
        paidCents: booking.paidCents,
        balanceCents: Math.max(0, booking.totalCents - booking.paidCents),
        // Le solde est borné à 0 pour l'affichage ; le trop-perçu se dit à
        // part, sinon un double paiement se lisait « soldé » comme si tout
        // allait bien (contre-review 2026-08-28).
        overpaidCents: Math.max(0, booking.paidCents - booking.totalCents),
        balanceDueDate: booking.balanceDueDate,
        holdExpiresAt: booking.status === "pending" ? booking.holdExpiresAt : null,
        quoteLines,
        depositPct,
      },
      stay: {
        checkinTime: settings?.checkinTime ?? "16:00",
        checkoutTime: settings?.checkoutTime ?? "10:00",
        cautionCents: settings?.cautionCents ?? 0,
      },
      cgvText: settings?.cgvText ?? "",
      cgvAccepted,
      // Adresse du gîte : elle n'était nulle part sur le voucher, alors que
      // c'est l'information qu'on cherche la veille du départ (issue #47-7).
      contact: {
        email: publicContact(property?.contactEmail),
        phone: publicContact(property?.contactPhone),
        address: property?.address ?? null,
        commune: property?.commune ?? null,
      },
    });
  });

  // --- webhook Beds24 : notification temps réel d'une résa canal --------------
  //     Beds24 appelle cette URL (configurée chez eux avec la clé secrète) dès
  //     qu'une réservation arrive/change. On ne fait pas confiance au payload :
  //     la notification est un SIGNAL, la vérité vient d'un pull immédiat.
  router.post("/api/webhooks/beds24", async (req, env, _p, url, execCtx) => {
    // Un webhook rejeté ne laissait aucune trace : une clé mal collée chez
    // Beds24 ou une rotation oubliée coupait le temps réel en silence, et
    // seul le filet de 15 min tournait encore (audit ECC 2026-07-30).
    const key = ((await getSetting(env.DB, "beds24_webhook_key")) ?? env.BEDS24_WEBHOOK_KEY ?? "").trim() || null;
    const given = url.searchParams.get("key") ?? "";
    if (!key || !safeEqualKey(given, key)) {
      await audit(env.DB, "webhook", "beds24.webhook.error", null, {
        reason: key ? "clé invalide" : "BEDS24_WEBHOOK_KEY non configurée",
      });
      return apiError(401, "clé invalide");
    }
    const db = env.DB;
    const work = (async () => {
      const properties = await listProperties(db);
      for (const prop of properties) {
        if (prop.beds24PropertyId == null) continue;
        try {
          await pullBeds24Bookings(db, env, prop.id, prop.beds24PropertyId);
          await pushCalendars(db, env, prop.id);
        } catch (e) {
          await audit(db, "webhook", "beds24.pull.error", `property:${prop.id}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    if (execCtx) execCtx.waitUntil(work);
    else await work;
    return json({ received: true });
  });

  // --- webhook Stripe ---------------------------------------------------------
  // Une route par propriété (un compte Stripe par entité) — cf. services/stripe-webhook.ts.
  // La signature est vérifiée avec le secret de CETTE propriété (repli : variable
  // d'environnement). L'ancienne route sans identifiant ne sert que le repli env.
  const stripeWebhook = async (req: Request, env: Env, propertyId: number | null): Promise<Response> => {
    const cfg =
      propertyId == null ? stripeConfigFromEnv(env) : await resolveStripeConfig(env.DB, env, propertyId);
    if (propertyId != null && !(await getProperty(env.DB, propertyId))) return apiError(404, "propriété inconnue");
    if (!stripeEnabled(cfg)) return apiError(400, "stripe non configuré");
    if (!cfg.webhookSecret) return apiError(500, "secret du webhook Stripe manquant");
    const payload = await req.text();
    const valid = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), cfg.webhookSecret);
    if (!valid) return apiError(400, "signature invalide");

    let event: { type?: string; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      return apiError(400, "JSON invalide");
    }
    await processStripeEvent(env.DB, env, cfg, propertyId, event);
    return json({ received: true });
  };
  router.post("/api/webhooks/stripe", (req, env) => stripeWebhook(req, env, null));
  router.post("/api/webhooks/stripe/:propertyId", (req, env, p) => {
    const id = Number(p.propertyId);
    if (!Number.isInteger(id) || id < 1) return Promise.resolve(apiError(404, "propriété inconnue"));
    return stripeWebhook(req, env, id);
  });

  /** Configuration publique du paiement (issue #26).
   *
   *  Le tunnel ne charge `js.stripe.com` QUE si cet endpoint annonce une clé
   *  publique : sans clé, aucune requête ne part vers Stripe et le simulateur
   *  local reste seul à l'écran. La clé publiable est faite pour être publique
   *  (elle ne permet ni de lire ni de créer quoi que ce soit côté compte) ; la
   *  clé secrète, elle, ne sort jamais du Worker. */
  router.get("/api/public/payment-config", async (_req, env, _p, url) => {
    // `?property=<id|slug>` : clé publiable du compte de CETTE propriété. Sans
    // paramètre : repli sur l'environnement. (Le tunnel reçoit de toute façon la
    // clé avec le paiement lui-même — `payment.publishableKey` —, ce point reste
    // pour les anciennes pages.)
    const wanted = url.searchParams.get("property");
    let cfg = stripeConfigFromEnv(env);
    if (wanted) {
      const prop = await getProperty(env.DB, /^\d+$/.test(wanted) ? Number(wanted) : wanted);
      if (prop) cfg = await resolveStripeConfig(env.DB, env, prop.id);
    }
    const publishableKey = paymentElementEnabled(cfg) ? stripePublishableKey(cfg) : null;
    return publishableKey
      ? json({ enabled: true, ui: "element", publishableKey, locale: "fr" })
      : json({ enabled: false });
  });

  // --- simulateur de paiement — MODE STUB UNIQUEMENT (pas de clé Stripe) -----
  router.get("/api/public/dev-pay/info", async (_req, env, _p, url) => {
    const session = url.searchParams.get("session") ?? "";
    const payment = await findPaymentBySession(env.DB, session);
    if (!payment) return apiError(404, "session inconnue");
    // Le simulateur n'existe que pour une propriété SANS compte Stripe.
    if (stripeEnabled(await resolveStripeConfig(env.DB, env, await propertyIdOfPayment(env.DB, payment.id)))) {
      return apiError(404, "indisponible");
    }
    const booking = await getBooking(env.DB, payment.bookingId);
    return json({
      session,
      reference: booking?.reference ?? "",
      unitName: booking?.unitName ?? "",
      kind: payment.kind,
      amountCents: payment.amountCents,
      status: payment.status,
      holdExpiresAt: booking?.status === "pending" ? booking.holdExpiresAt : null,
      now: sqlNow(),
    });
  });

  router.post("/api/public/dev-pay/confirm", async (req, env) => {
    const body = await readJson<{ session?: string }>(req);
    const session = String(body?.session ?? "");
    if (!session.startsWith("stub_")) return apiError(400, "session invalide");
    const stubbed = await findPaymentBySession(env.DB, session);
    if (stubbed && stripeEnabled(await resolveStripeConfig(env.DB, env, await propertyIdOfPayment(env.DB, stubbed.id)))) {
      return apiError(404, "indisponible");
    }
    // Le `kind` se lit AVANT le traitement : après, un rejeu tomberait sur la
    // sortie idempotente et on ne saurait plus vers quelle page renvoyer.
    const before = await findPaymentBySession(env.DB, session);
    const result = await handlePaymentSuccess(env.DB, env, session, "pi_stub");
    if (!result.handled) return apiError(404, "session inconnue");
    const booking = result.bookingId != null ? await getBooking(env.DB, result.bookingId) : null;
    const emailParam = booking?.guestEmail ? `&email=${encodeURIComponent(booking.guestEmail)}` : "";
    // Un solde payé ne « confirme » rien : le client revient sur son voucher,
    // qui affiche le nouveau solde (miroir des URLs de retour Stripe).
    const redirect =
      before?.kind === "balance" && booking
        ? voucherUrl(env, booking)
        : `${env.PUBLIC_BASE_URL}/book/merci.html?ref=${encodeURIComponent(result.reference ?? "")}${emailParam}`;
    return json({ ok: true, reference: result.reference ?? "", redirect });
  });

  // --- messages : les échanges clients passent par la plateforme --------------

  /** Question AVANT réservation (formulaire de la page publique). */
  router.post("/api/public/contact", async (req, env) => {
    const db = env.DB;
    const body = await readJson<{ property?: string; name?: string; email?: string; message?: string; website?: string; lang?: string }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    if (String(body.website ?? "").trim() !== "") return json({ ok: true }); // pot de miel anti-bot
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const message = String(body.message ?? "").trim();
    if (name.length < 2) return apiError(400, "nom requis");
    if (!isEmailish(email)) return apiError(400, "email invalide");
    if (message.length < 5 || message.length > 4000) return apiError(400, "message trop court ou trop long");
    const property = await getProperty(db, body.property ?? "");
    if (!property || !property.active) return apiError(404, "domaine inconnu");
    const guest = await db.prepare("SELECT id FROM guests WHERE lower(email) = ?1").bind(email).first<{ id: number }>();
    const id = await insertInboundMessage(db, {
      propertyId: property.id,
      channel: "form",
      fromEmail: email,
      fromName: name,
      toEmail: property.contactEmail,
      subject: `Question — ${property.name}`,
      bodyText: message,
      guestId: guest?.id ?? null,
    });
    if (id === null) return apiError(500, "message non enregistré");
    // Référence de la question, du même gabarit que celle d'une réservation :
    // elle va dans l'objet, et la relève de la boîte y rattache la réponse.
    const reference = `QU-${todayInZone().slice(0, 4)}-${String(id).padStart(4, "0")}`;
    await db.prepare("UPDATE messages SET subject = ?1 WHERE id = ?2").bind(refSubject(reference, `Question de ${name} — ${property.name}`), id).run();
    await audit(db, "public", "message.contact", `message:${id}`, { property: property.slug, from: email, reference });
    const ack = await sendContactAck(db, env, { email, reference, property, name, message, lang: body.lang === "nl" ? "nl" : "fr" });
    return json({ ok: true, reference, ackSent: ack, deliveredTo: publicContact(property.contactEmail) }, 201);
  });

  /** Accusé de réception par e-mail, journalisé comme les autres (`contact_ack`).
   *  Garde-fou : l'adresse saisie n'est pas vérifiée, le formulaire ne doit pas
   *  servir à arroser quelqu'un de mails — au-delà de 3 messages par heure et
   *  par adresse, le message est gardé mais l'accusé ne repart plus. */
  async function sendContactAck(
    db: D1Database,
    env: Env,
    a: { email: string; reference: string; property: { id: number; name: string }; name: string; message: string; lang: "fr" | "nl"; bookingId?: number | null },
  ): Promise<boolean> {
    try {
      const recent = await db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND channel = 'form' AND lower(from_email) = ?1 AND received_at >= datetime('now', '-1 hour')")
        .bind(a.email.toLowerCase())
        .first<{ n: number }>();
      if ((recent?.n ?? 0) > 3) return false;
      const mail = buildContactAckEmail({ reference: a.reference, propertyName: a.property.name, guestName: a.name, message: a.message, nl: a.lang === "nl" });
      await queueEmail(db, env, { bookingId: a.bookingId ?? null, to: a.email, subject: mail.subject, bodyText: mail.bodyText, kind: "contact_ack" });
      return true;
    } catch (e) {
      await audit(db, "public", "contact_ack.error", a.reference, { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Charge une résa par référence + email — mutualisé messages/voucher. */
  async function authedBooking(db: D1Database, reference: string, email: string): Promise<BookingRow | null> {
    const booking = await getBookingByReference(db, reference);
    if (!booking || !email || (booking.guestEmail ?? "").toLowerCase() !== email.toLowerCase()) return null;
    return booking;
  }

  const publicMessage = (m: { direction: string; channel: string; bodyText: string; fromName: string | null; receivedAt: string }) => ({
    direction: m.direction,
    channel: m.channel,
    body: m.bodyText,
    fromName: m.fromName,
    at: m.receivedAt,
  });

  /** Paiement en libre-service depuis le voucher. Deux cas, un seul endpoint :
   *
   *  - résa `pending` : reprise d'un paiement interrompu (retour depuis un
   *    abandon) — nouvelle session de checkout tant que le hold court, sinon le
   *    propre hold du client bloquerait toute nouvelle tentative ;
   *  - résa `confirmed` avec un solde ouvert : paiement du SOLDE (issue #67),
   *    disponible à tout moment et pas seulement à l'échéance — un client qui
   *    veut solder en avance ne doit pas avoir à écrire au propriétaire.
   *
   *  L'idempotence est celle de l'acompte, inchangée : `handlePaymentSuccess`
   *  sort par le haut sur un paiement déjà `succeeded`, et l'index UNIQUE
   *  partiel `idx_payments_session` interdit deux paiements sur une session.
   *  Un webhook rejoué ne peut donc pas créditer deux fois. Contre le risque
   *  voisin — DEUX sessions distinctes pour le même montant, toutes deux
   *  payées — `startCheckout` ferme chez Stripe celles qui traînent avant d'en
   *  ouvrir une nouvelle. */
  router.post("/api/public/bookings/:reference/pay", async (req, env, p) => {
    const db = env.DB;
    const body = await readJson<{ email?: string; cgvAccepted?: boolean }>(req);
    const booking = await authedBooking(db, p.reference ?? "", String(body?.email ?? "").trim());
    if (!booking) return apiError(404, "réservation introuvable");

    const balance = booking.totalCents - booking.paidCents;
    if (booking.status === "confirmed") {
      if (balance <= 0) return apiError(400, "cette réservation est intégralement réglée");
      // Plancher Stripe : une session de moins de 0,50 € est refusée à la
      // création. Le reliquat se règle alors avec le propriétaire.
      if (balance < MIN_CHECKOUT_CENTS) return apiError(400, "solde trop faible pour un paiement en ligne");
      const start = await startPayment(db, env, booking, "balance", balance, "public");
      return json({ ...publicPayment(start), amountCents: balance, kind: "balance", now: sqlNow() });
    }

    if (booking.status !== "pending") return apiError(400, "cette réservation n'est plus active");
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= sqlNow()) {
      return apiError(410, "l'option a expiré — le créneau est de nouveau ouvert, relancez une réservation");
    }
    // Option ouverte par le back-office : le client n'a pas encore accepté les
    // CGV (le tunnel public le fait à la création). La réservation est conclue
    // par cette acceptation et le paiement des arrhes : version, heure et IP sont
    // enregistrées ici, comme dans le tunnel, et la case seule ne suffit pas.
    if ((await getCgvAcceptance(db, booking.id)).acceptedAt == null) {
      if (body?.cgvAccepted !== true) {
        return apiError(400, "acceptation des conditions générales requise", { code: "cgv_required" });
      }
      const settings = booking.propertyId != null ? await getSettings(db, booking.propertyId) : null;
      await recordCgvAcceptance(db, booking.id, {
        version: await cgvVersion(settings?.cgvText ?? ""),
        ip: req.headers.get("cf-connecting-ip"),
      });
    }
    const kind = booking.balanceDueDate == null ? "full" : "deposit";
    const start = await startPayment(db, env, booking, kind, booking.depositCents, "public");
    return json({
      ...publicPayment(start),
      amountCents: booking.depositCents,
      kind,
      holdExpiresAt: booking.holdExpiresAt,
      now: sqlNow(),
    });
  });

  /** « Confirmation de réservation et conditions générales » en PDF, pour le
   *  client : même contrôle que sa page de réservation (référence + email), et
   *  seulement une fois la réservation confirmée (avant, ni le prix ni les
   *  dates ne sont définitifs). `contrat.pdf` est l'ancien nom, gardé en alias
   *  pour les liens déjà envoyés : même réponse. */
  const confirmationPdf: Parameters<typeof router.get>[1] = async (_req, env, p, url) => {
    const email = (url.searchParams.get("email") ?? "").trim();
    const booking = await authedBooking(env.DB, p.reference ?? "", email);
    if (!booking || booking.status !== "confirmed") return apiError(404, "confirmation introuvable");
    const ctx = await loadConfirmationPdfContext(env.DB, booking.id);
    if (!ctx) return apiError(404, "confirmation introuvable");
    return new Response(buildConfirmationPdf(ctx), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${confirmationFileName(booking.reference)}"`,
        "cache-control": "private, no-store",
      },
    });
  };
  router.get("/api/public/bookings/:reference/confirmation.pdf", confirmationPdf);
  router.get("/api/public/bookings/:reference/contrat.pdf", confirmationPdf);

  /** Fil de conversation du client (page voucher). */
  router.get("/api/public/bookings/:reference/messages", async (_req, env, p, url) => {
    const email = (url.searchParams.get("email") ?? "").trim();
    const booking = await authedBooking(env.DB, p.reference ?? "", email);
    if (!booking) return apiError(404, "réservation introuvable");
    const thread = await getThread(env.DB, { bookingId: booking.id, guestId: booking.guestId });
    return json({ messages: thread.map(publicMessage) });
  });

  /** Nouveau message du client depuis son voucher — aucun email nécessaire. */
  router.post("/api/public/bookings/:reference/messages", async (req, env, p) => {
    const db = env.DB;
    const body = await readJson<{ email?: string; message?: string }>(req);
    const email = String(body?.email ?? "").trim();
    const booking = await authedBooking(db, p.reference ?? "", email);
    if (!booking) return apiError(404, "réservation introuvable");
    const message = String(body?.message ?? "").trim();
    if (message.length < 2 || message.length > 4000) return apiError(400, "message trop court ou trop long");
    await insertInboundMessage(db, {
      propertyId: booking.propertyId ?? 1,
      channel: "form",
      fromEmail: booking.guestEmail ?? email,
      fromName: booking.guestName ?? null,
      subject: `Votre réservation ${booking.reference}`,
      bodyText: message,
      bookingId: booking.id,
      guestId: booking.guestId,
    });
    await audit(db, "public", "message.booking", `booking:${booking.id}`);
    const property = booking.propertyId != null ? await getProperty(db, booking.propertyId) : null;
    const ackSent = booking.guestEmail
      ? await sendContactAck(db, env, {
          email: booking.guestEmail,
          reference: booking.reference,
          property: { id: property?.id ?? booking.propertyId ?? 1, name: property?.name ?? "" },
          name: booking.guestName ?? "",
          message,
          lang: booking.guestLang === "nl" ? "nl" : "fr",
          bookingId: booking.id,
        })
      : false;
    const thread = await getThread(db, { bookingId: booking.id, guestId: booking.guestId });
    return json({ ok: true, ackSent, reference: booking.reference, deliveredTo: publicContact(property?.contactEmail), messages: thread.map(publicMessage) }, 201);
  });

  // petite aide au front public : date du jour (Bruxelles) + mode démo
  router.get("/api/public/today", async (_req, env) =>
    json({
      today: todayInZone(),
      maxAdvanceDays: MAX_ADVANCE_DAYS,
      demo: !(await anyStripeConfigured(env.DB, env)),
      // Clé PUBLIQUE du widget anti-robot, ou null quand la fonctionnalité est
      // éteinte (issue #6) : le tunnel ne charge alors AUCUN script tiers.
      turnstileSiteKey: turnstileSiteKey(env),
    }));

  // Contrôle de santé pour une sonde EXTERNE (issue #21) : deux champs, une
  // seule lecture en base, aucune donnée client. 503 si la base est illisible,
  // pour qu'une sonde qui ne regarde que le code HTTP alerte quand même.
  router.get("/api/public/health", async (_req, env) => {
    const health = await publicHealth(env.DB);
    return json(health, health.ok ? 200 : 503);
  });

  // --- export iCal par unité : /ical/<token>.ics (token secret) ---------------
  router.get("/ical/:token", async (_req, env, p) => {
    const raw = p.token ?? "";
    const token = raw.endsWith(".ics") ? raw.slice(0, -4) : raw;
    const unit = await getUnitByIcalToken(env.DB, token);
    if (!unit) return apiError(404, "calendrier inconnu");
    const property = await getProperty(env.DB, unit.propertyId);
    const now = new Date();
    const spans = await exportSpansForUnit(env.DB, unit, now);
    const ics = buildIcs(unit.name, property?.name ?? "", spans, sqlNow(now));
    return new Response(ics, {
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" },
    });
  });
}
