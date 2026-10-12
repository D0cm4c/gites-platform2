// API back-office. Protection : Cloudflare Access en production (décision de
// déploiement de Julien) + jeton optionnel ADMIN_TOKEN en défense en profondeur
// (si configuré, exigé en header Authorization: Bearer …).

import { apiError, json, readJson, Router, type Handler } from "./router";
import { addDays, dayOfWeek, diffDays, isIsoDate, rangesOverlap, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { blockingUnitIds, blocksAsSpans, isActiveBooking, isUnitFree } from "../core/availability";
import { rateCalendar, type RateOverride, type UnitPricingInfo } from "../core/pricing";
import { detectDrift, type DriftSignal } from "../core/drift";
import { imageSize } from "../core/image-size";
import { ipDeniedResponse, isIpDenied } from "../core/ip-allow";
import {
  GUEST_ID_TYPES,
  GUEST_ID_TYPE_FR,
  GUEST_REGISTER_RETENTION_YEARS,
  MAX_GUEST_ENTRIES_PER_REQUEST,
  MAX_REGISTER_EXPORT_DAYS,
  parseGuestEntry,
  type GuestRegisterEntry,
} from "../core/guest-register";
import {
  CHANNEL_MARKUP_MAX_PCT,
  CHANNEL_MARKUPS_KEY,
  CHANNEL_PRICE_FORMULA,
  checkBounds,
  checkPrice,
  normalizeChannelMarkups,
  parseChannelMarkups,
  parsePushChannel,
  pushedPriceCents,
  pushMarkupPct,
  PUSH_CHANNEL_KEY,
  suggestForChannels,
  type ChannelMarkup,
  type ChannelSuggestion,
  type PriceBounds,
} from "../core/price-guardrails";
import {
  computeFunnel,
  computeLeadTime,
  computeYearStats,
  summarizeSearches,
  type LeadTimeBooking,
  type StatsBooking,
} from "../core/stats";
import {
  addPayment,
  audit,
  bookingsForGuest,
  bookingsInWindow,
  cancelBooking,
  collectDriftInput,
  confirmBookingAtomic,
  healthSignals,
  createBookingAtomic,
  createFeed,
  createOption,
  createPromotion,
  createRateRule,
  createSeason,
  deleteFeed,
  deleteOption,
  deletePromotion,
  deleteRateRule,
  deleteSeason,
  getBooking,
  getFeed,
  getGuest,
  getProperty,
  hasEmailOfKinds,
  getQuoteContext,
  getRateRule,
  insertGuestEntry,
  listGuestRegister,
  listGuestRegisterBetween,
  getUnit,
  getSettings,
  listAudit,
  listAuditByAction,
  listSyncConflicts,
  getSyncConflict,
  setSyncConflictStatus,
  listBeds24Bookings,
  listBookings,
  listAuditByEntity,
  listEmailLog,
  listFeeds,
  listGuests,
  listLinks,
  blockingBookings,
  blockingManualBlocks,
  createManualBlockAtomic,
  getManualBlock,
  manualBlocksInWindow,
  releaseManualBlock,
  listOptionsAdmin,
  listPayments,
  listPromotions,
  listProperties,
  listRateRules,
  listRateOverrides,
  listRateOverridesForProperty,
  setRateOverrides,
  deleteRateOverrides,
  listSeasons,
  listUnitPhotos,
  listUnits,
  updateBookingNotes,
  updateBookingStayAtomic,
  updateChecklistItem,
  updateFeed,
  updateGuest,
  updateOption,
  updateProperty,
  updatePromotion,
  updateRateRule,
  countNewMessages,
  createUnit,
  createUnitPhoto,
  getMessage,
  getThread,
  insertOutboundMessage,
  listChecklist,
  listMessages,
  markMessage,
  setMutualLinks,
  updateUnitPhotos,
  updateSeason,
  updateSettings,
  updateUnit,
  upsertGuest,
  type BookingRow,
  type OptionInput,
  type PromotionInput,
  type RateRuleInput,
} from "../db/repo";
import { Beds24Error, beds24Configured, beds24Setup, beds24Status, beds24WritesAllowed, resetBeds24TokenCache } from "../services/beds24";
import { derivedLines, parsePriceLinking, PRICE_LINKING_KEY } from "../core/channel-promotions";
import {
  createSession, deleteSession, deleteUserSessions, generatePassword, hashPassword, sessionUser, verifyPassword,
} from "../services/admin-auth";
import { getSetting, setSetting } from "../services/settings";
import { pullBeds24Bookings, pushCalendars, triggerBeds24Push, triggerBeds24PushAll } from "../services/beds24-sync";
import { beds24Liaison, buildPropertyPlan, createBeds24Property, CreationRefusee } from "../services/beds24-propriete";
import {
  MIN_CHECKOUT_CENTS,
  quoteFromContext,
  sendConfirmation,
  startCheckout,
  stripeConfigForBooking,
  voucherUrl,
  type QuoteBody,
} from "../services/booking-flow";
import { dropPreparedRefunds, executeRefunds, planCancellation, prepareRefunds, replayRefund } from "../services/annulation";
import { buildBalanceReminderEmail, buildCancellationEmail, buildPaymentLinkEmail, queueEmail, queueEmailDetailed } from "../services/email";
import { buildConfirmationPdf, confirmationFileName, loadConfirmationPdfContext } from "../services/confirmation-pdf";
import { importElloha } from "../services/elloha-import";
import { importAgendaGoogle, MAX_AGENDA_EVENTS } from "../services/agenda-import";
import { replyOnChannel } from "../services/beds24-messages";
import { exportSql } from "../services/export-db";
import { tarStream } from "../core/tar";
import {
  createServiceKey, listServiceKeys, resolveServiceKey, revokeServiceKey, validServiceKeyName,
} from "../services/service-keys";
import { extractMessageIds, processInboundEmail, type ParsedEmail } from "../services/inbound-email";
import { getMailboxState, mailboxConfigured, ownAddresses, pullMailbox, NO_SOCKET_MESSAGE } from "../services/mailbox";
import { syncFeed } from "../services/ical";
import { countDirectBookings, countSearchStages, listSearchLog } from "../services/search-log";
import { registerLot2AdminRoutes } from "./admin-lot2";
import { registerImprovementRoutes } from "./admin-ameliorations";
import { PriceLinkingError, registerLot3AdminRoutes, sendPriceLinking } from "./admin-lot3";
import { registerStripeAdminRoutes } from "./admin-stripe";

// --- garde d'authentification -------------------------------------------------

/** Comparaison à temps constant — évite de fuiter le jeton octet par octet. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Garde FAIL-CLOSED (audit ECC 2026-07-30, finding critique n°1).
 *
 *  La version précédente ne vérifiait RIEN quand ADMIN_TOKEN était absent —
 *  or c'est la valeur par défaut de .dev.vars.example. Un oubli de règle
 *  Cloudflare Access (posée sur /admin mais pas sur /api/admin/*, ou contournée
 *  par le sous-domaine workers.dev) exposait alors tout le fichier clients,
 *  les écritures, et la clé du webhook Beds24 en clair.
 *
 *  Désormais : jeton valide, OU en-tête Cloudflare Access (l'utilisateur a déjà
 *  été authentifié en amont). Sinon, refus. */
/** ADMIN_TOKEN = comptes du back-office : liste `identifiant:motdepasse` séparée
 *  par des virgules (« julien:…,matthieu:…,papa:… ») — un accès par personne,
 *  révocable un par un en republiant le secret sans la paire concernée.
 *  L'ancien format à jeton unique sans identifiant reste accepté tel quel. */
function parseAdminEntries(raw: string): Array<{ user: string; password: string }> {
  return raw
    .split(",")
    .map((part) => {
      const idx = part.indexOf(":");
      return {
        user: idx > 0 ? part.slice(0, idx).trim() : "",
        password: (idx > 0 ? part.slice(idx + 1) : part).trim(),
      };
    })
    .filter((e) => e.password.length > 0);
}

/** Vérifie un couple identifiant/mot de passe. L'identifiant n'est pas secret
 *  (comparaison simple) ; le mot de passe est comparé à temps constant, avec
 *  une comparaison factice quand l'identifiant est inconnu pour ne pas fuiter
 *  son existence par le chronomètre. */
function checkCredentials(raw: string, user: string, password: string): boolean {
  const entries = parseAdminEntries(raw);
  const entry = entries.find((e) => e.user === user);
  if (!entry) {
    safeEqual(password, "comparaison-factice-anti-chronometre");
    return false;
  }
  return safeEqual(password, entry.password);
}

/** Identité authentifiée de la requête (posée par guard, lue par la page
 *  Utilisateurs pour interdire l'auto-verrouillage et tracer l'audit). */
const REQUEST_USER = new WeakMap<Request, string>();

export function currentUser(req: Request): string {
  return REQUEST_USER.get(req) ?? "admin";
}

/** Comment la requête s'est authentifiée. « humain » = session de la page de
 *  connexion, ou secret ADMIN_TOKEN (couple nommé ou jeton nu historique : l'accès
 *  de secours du propriétaire) ; jamais une clé de service ni le compte sauvegarde. */
type AuthKind = "session" | "paire" | "nu" | "service" | "access";
const REQUEST_KIND = new WeakMap<Request, AuthKind>();

export function isHuman(req: Request): boolean {
  const kind = REQUEST_KIND.get(req);
  return (kind === "session" || kind === "paire" || kind === "nu" || kind === "access") && currentUser(req) !== BACKUP_USER;
}

/** Compte de la sauvegarde de nuit (scripts/sauvegarde_nuit.py, depuis le Mac) :
 *  identifiant réservé, qui n'ouvre QUE l'export de la base (et sa propre
 *  déconnexion). Une fuite de son mot de passe donne une copie des données —
 *  c'est son métier — mais aucune écriture, aucun réglage, aucun compte. */
export const BACKUP_USER = "sauvegarde";
const BACKUP_ROUTES = new Set(["/api/admin/export.sqlite", "/api/admin/export.sql", "/api/admin/export-uploads.tar", "/api/admin/logout"]);

function backupAccountRefused(username: string, url: URL): Response | null {
  if (username !== BACKUP_USER || BACKUP_ROUTES.has(url.pathname)) return null;
  return apiError(403, "le compte « sauvegarde » n'ouvre que l'export de la base");
}

/** Garde IP (ADMIN_ALLOWED_IPS) appliquée APRÈS l'authentification, aux humains
 *  seulement : une clé de service et le compte « sauvegarde » partent du Mac et
 *  passent depuis toute adresse (lot 3 ; cf. src/core/ip-allow.ts). */
function ipRefused(req: Request): Response | null {
  if (!isIpDenied(req)) return null;
  if (REQUEST_KIND.get(req) === "service" || currentUser(req) === BACKUP_USER) return null;
  return ipDeniedResponse();
}

export function guard(inner: Handler): Handler {
  return async (req, env, params, url, ctx) => {
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const handler: Handler = (r, e, p, u, c) => ipRefused(r) ?? inner(r, e, p, u, c);
    // Adresse hors liste : seules une clé de service, une session ou une paire
    // ADMIN_TOKEN peuvent encore se révéler exemptées ; tout le reste est
    // refusé ici, sans lire la base.
    if (isIpDenied(req) && !presented) return ipDeniedResponse();

    // 0) Accès de service (Claude, scripts du Mac) : clé svc:<clé>, droits admin.
    if (presented.startsWith("svc:")) {
      const name = await resolveServiceKey(env.DB, presented.slice(4));
      if (!name) return apiError(401, "clé de service inconnue ou révoquée");
      REQUEST_USER.set(req, `svc:${name}`);
      REQUEST_KIND.set(req, "service");
      return handler(req, env, params, url, ctx);
    }

    // 1) Session de la page de login (comptes en base — page Utilisateurs).
    if (presented.startsWith("session:")) {
      const username = await sessionUser(env.DB, presented.slice(8));
      if (!username) return apiError(401, "session expirée ou révoquée");
      const refused = backupAccountRefused(username, url);
      if (refused) return refused;
      REQUEST_USER.set(req, username);
      REQUEST_KIND.set(req, "session");
      return handler(req, env, params, url, ctx);
    }

    // 2) Accès de secours hors base : secret ADMIN_TOKEN (couple id:mdp lié,
    //    ou mot de passe nu pour verify-deploy et les sessions historiques).
    const raw = env.ADMIN_TOKEN?.trim();
    if (raw) {
      const sep = presented.indexOf(":");
      let ok = false;
      if (sep > 0) {
        ok = checkCredentials(raw, presented.slice(0, sep), presented.slice(sep + 1));
        if (ok) {
          const refused = backupAccountRefused(presented.slice(0, sep), url);
          if (refused) return refused;
          REQUEST_USER.set(req, presented.slice(0, sep));
          REQUEST_KIND.set(req, "paire");
        }
      } else {
        // Pas de sortie anticipée : chaque candidat est comparé à temps constant.
        // Le mot de passe nu de la paire « sauvegarde:… » reste celui du compte
        // de sauvegarde : il n'ouvre que l'export, comme la paire complète.
        let matched: string | null = null;
        for (const e of parseAdminEntries(raw)) {
          if (safeEqual(presented, e.password)) {
            ok = true;
            if (matched === null || e.user !== BACKUP_USER) matched = e.user;
          }
        }
        if (ok && matched === BACKUP_USER) {
          const refused = backupAccountRefused(BACKUP_USER, url);
          if (refused) return refused;
          REQUEST_USER.set(req, BACKUP_USER);
        }
        if (ok) REQUEST_KIND.set(req, "nu");
      }
      if (ok) return handler(req, env, params, url, ctx);
      return apiError(401, "non autorisé");
    }
    if (req.headers.get("cf-access-jwt-assertion")) {
      REQUEST_KIND.set(req, "access");
      return handler(req, env, params, url, ctx);
    }

    // 3) Sans secret : fail-closed tant qu'aucun compte n'existe en base ;
    //    401 (→ page de login) dès que le verrou vit en base.
    const hasUsers = await env.DB.prepare("SELECT 1 FROM admin_users WHERE active = 1 LIMIT 1").first();
    if (hasUsers) return apiError(401, "non autorisé");
    return apiError(503, "ADMIN_TOKEN non configuré — accès refusé (fail-closed)");
  };
}

/** Pourcentage de remise borné à [0,100] — une saisie « 150 » au lieu de « 15 »
 *  produisait un devis et des arrhes NÉGATIFS (audit ECC 2026-07-30). Le moteur
 *  de tarification plafonne aussi de son côté : double ceinture, la saisie
 *  fautive est refusée ici pour ne jamais entrer en base. */
function pctOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), 100);
}

/** Vrai si la valeur fournie est un pourcentage hors bornes (refus en 400). */
function badPct(v: unknown): boolean {
  if (v == null) return false;
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 || n > 100;
}

function intParam(v: string | null | undefined, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- tarifs : bornes, plages et surcharges ----------------------------------

/** Plage maximale d'un calendrier ou d'une écriture de surcharge (un peu plus
 *  d'un an — la vue année en a besoin, au-delà c'est une erreur de saisie). */
const MAX_RANGE_DAYS = 370;

/** Prix de référence des exemples chiffrés du back-office (200,00 €) : un
 *  ordre de grandeur réel pour ces gîtes, et un nombre rond à vérifier de tête. */
const EXAMPLE_PRICE_CENTS = 20000;

/** Bornes de prix d'un hébergement (issue #31). Lues à chaque écriture
 *  tarifaire : règle de saison comme surcharge de jour, même garde-fou. */
async function boundsForUnit(db: D1Database, unitId: number): Promise<PriceBounds> {
  const unit = await getUnit(db, unitId);
  return { minCents: unit?.priceMinCents ?? null, maxCents: unit?.priceMaxCents ?? null };
}

/** Jours de [from, to] INCLUS, filtrés sur des jours de semaine optionnels
 *  (0 = dimanche … 6 = samedi). C'est le geste « je sélectionne les trois
 *  week-ends de mars et je pose 240 € ». */
function expandRange(from: IsoDate, to: IsoDate, weekdays: number[] | null): IsoDate[] {
  const days: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!weekdays || weekdays.includes(dayOfWeek(d))) days.push(d);
  }
  return days;
}

/** Lit et valide `from`/`to` (inclusifs) d'une requête de plage tarifaire. */
function parseRange(from: string, to: string): { ok: true; from: IsoDate; to: IsoDate } | { ok: false; message: string } {
  if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, message: "dates invalides (format AAAA-MM-JJ)" };
  if (from > to) return { ok: false, message: "la date de fin doit suivre la date de début" };
  if (diffDays(from, to) > MAX_RANGE_DAYS) return { ok: false, message: `plage trop longue (max ${MAX_RANGE_DAYS} jours)` };
  return { ok: true, from, to };
}

/** `weekdays=0,6` → [0, 6] ; absent ou vide → null (tous les jours). */
function parseWeekdays(raw: unknown): number[] | null {
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : null;
  if (!list) return null;
  const days = [...new Set(list.map((d) => Math.floor(Number(d))).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return days.length > 0 ? days : null;
}

function toStatsBooking(b: BookingRow): StatsBooking {
  return { unitId: b.unitId, checkin: b.checkin, checkout: b.checkout, totalCents: b.totalCents };
}

function csvEscape(v: unknown): string {
  const raw = String(v ?? "");
  // Injection de formule Excel/LibreOffice : un client qui saisit son nom en
  // « =HYPERLINK("http://…"&A1,"Cliquez") » verrait la formule s'exécuter à
  // l'ouverture de l'export. L'apostrophe de tête neutralise la cellule.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(rows: unknown[][], filename: string): Response {
  const text = rows.map((r) => r.map(csvEscape).join(";")).join("\r\n");
  // BOM UTF-8 pour Excel
  return new Response("﻿" + text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function confirmedYearBookings(db: D1Database, propertyId: number, year: number): Promise<StatsBooking[]> {
  const rows = await bookingsInWindow(db, propertyId, `${year}-01-01`, `${year + 1}-01-01`);
  return rows.filter((b) => b.status === "confirmed").map(toStatsBooking);
}

/** Réservations confirmées de l'année, avec leur date de prise de réservation —
 *  base du délai de réservation (issue #36). `created_at` est un horodatage
 *  complet : on n'en garde que le jour, le délai se compte en jours. */
async function leadTimeBookings(db: D1Database, propertyId: number, year: number): Promise<LeadTimeBooking[]> {
  const rows = await bookingsInWindow(db, propertyId, `${year}-01-01`, `${year + 1}-01-01`);
  return rows
    .filter((b) => b.status === "confirmed")
    .map((b) => ({
      unitId: b.unitId,
      unitName: b.unitName ?? `Unité ${b.unitId}`,
      checkin: b.checkin,
      bookedOn: b.createdAt.slice(0, 10),
    }));
}

/** Créneau libre pour cette unité ? MÊME règle que le site public : l'unité
 *  elle-même plus toutes celles qui la bloquent par `unit_links` (issue #70).
 *
 *  Sert à ANNONCER l'indisponibilité avant le clic — la garantie anti-surbooking
 *  reste l'INSERT atomique de `createBookingAtomic` (ARCHITECTURE.md §3), qu'on
 *  ne remplace jamais par un SELECT suivi d'un INSERT.
 *
 *  Les conflits sont renvoyés nommés : au téléphone, « pris par PM-2026-004,
 *  Domaine entier » se dit, « indisponible » se subit. */
/** Entier borné, NaN-safe. `Number("abc")` vaut NaN, et TOUTE comparaison avec
 *  NaN est fausse : sans ce garde-fou, un `adults: "abc"` traversait le
 *  contrôle de capacité (`NaN > max` est faux) et finissait lié en SQL
 *  (contre-review Gemini, 2026-08-28). */
function intOr(value: unknown, fallback: number, min: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

/** Les options d'une réservation, reconstruites depuis son devis enregistré.
 *
 *  `options_json` ne garde que des libellés et des montants : sans cette
 *  reconstruction, recalculer un devis sans renvoyer les options les effacerait
 *  en silence — le total chuterait et la plateforme annoncerait un avoir à
 *  rembourser qui n'existe pas (contre-review Gemini, 2026-08-28).
 *
 *  Le libellé commence toujours par le nom de l'option ; la quantité d'une
 *  option « à l'unité » se relit dans sa parenthèse. Une ligne qu'on n'arrive
 *  PAS à rattacher fait échouer la modification : mieux vaut un refus explicite
 *  qu'un prix silencieusement faux. */
function optionsFromQuote(
  optionsJson: string | null,
  referential: { id: number; name: string; pricingMode: string }[],
): { ok: true; options: { id: number; qty: number }[] } | { ok: false; unmatched: string[] } {
  let lines: { label?: unknown }[] = [];
  try {
    const parsed: unknown = optionsJson ? JSON.parse(optionsJson) : [];
    lines = Array.isArray(parsed) ? (parsed as { label?: unknown }[]) : [];
  } catch {
    lines = [];
  }
  const options: { id: number; qty: number }[] = [];
  const unmatched: string[] = [];
  for (const line of lines) {
    const label = String(line?.label ?? "");
    if (!label) continue;
    const opt = referential.find((o) => label === o.name || label.startsWith(`${o.name} (`));
    if (!opt) {
      unmatched.push(label);
      continue;
    }
    const qty = opt.pricingMode === "per_unit_qty" ? Number(/\((\d+)/.exec(label)?.[1] ?? 1) || 1 : 1;
    options.push({ id: opt.id, qty });
  }
  return unmatched.length > 0 ? { ok: false, unmatched } : { ok: true, options };
}

/** Un conflit nommé : une réservation active (avec sa référence) ou un blocage
 *  manuel (avec son motif). `status = 'blocked'` distingue le second. */
interface AvailabilityConflict {
  reference: string;
  unitName: string;
  checkin: IsoDate;
  checkout: IsoDate;
  status: string;
  viaLink: boolean;
}

async function checkAvailability(
  db: D1Database,
  unitId: number,
  propertyId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: Date = new Date(),
  // Modifier une réservation, c'est se comparer à tout le monde SAUF soi-même :
  // sans cette exclusion, prolonger un séjour d'une nuit se heurterait à sa
  // propre occupation (issue #73).
  excludeBookingId?: number,
): Promise<{ available: boolean; conflicts: AvailabilityConflict[] }> {
  const [links, bookings, manualBlocks] = await Promise.all([
    listLinks(db, propertyId),
    bookingsInWindow(db, propertyId, checkin, checkout),
    manualBlocksInWindow(db, propertyId, checkin, checkout),
  ]);
  const nowSql = sqlNow(now);
  const others = excludeBookingId ? bookings.filter((b) => b.id !== excludeBookingId) : bookings;
  const spans = [
    ...others.map((b) => ({
      unitId: b.unitId,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
      holdExpiresAt: b.holdExpiresAt,
    })),
    ...blocksAsSpans(manualBlocks),
  ];
  const available = isUnitFree(unitId, checkin, checkout, spans, links, nowSql);
  const blockers = blockingUnitIds(unitId, links);
  const conflicts: AvailabilityConflict[] = others
    .filter(
      (b) =>
        blockers.has(b.unitId) &&
        isActiveBooking({ status: b.status, holdExpiresAt: b.holdExpiresAt }, nowSql) &&
        rangesOverlap(b.checkin, b.checkout, checkin, checkout),
    )
    .map((b) => ({
      reference: b.reference,
      unitName: b.unitName ?? `Unité ${b.unitId}`,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
      viaLink: b.unitId !== unitId,
    }));
  // Un blocage manuel se nomme lui aussi : « travaux salle de bains » se dit
  // au téléphone, « indisponible » se subit (issue #74).
  for (const k of manualBlocks) {
    if (!blockers.has(k.unitId) || !rangesOverlap(k.checkin, k.checkout, checkin, checkout)) continue;
    conflicts.push({
      reference: k.reason || "blocage manuel",
      unitName: k.unitName ?? `Unité ${k.unitId}`,
      checkin: k.checkin,
      checkout: k.checkout,
      status: "blocked",
      viaLink: k.unitId !== unitId,
    });
  }
  return { available, conflicts };
}

export function registerAdminRoutes(router: Router): void {
  // Lot 2 du nouvel écran : ménage, modèles de réponse, mon compte, envoi de
  // photos (src/api/admin-lot2.ts). Avant les routes historiques : la route
  // d'envoi de photos est plus précise que celles de la galerie.
  registerLot2AdminRoutes(router);
  // Lot 3 : promotions Airbnb, prix dérivés par canal, avis (src/api/admin-lot3.ts).
  registerLot3AdminRoutes(router);
  registerImprovementRoutes(router);
  registerStripeAdminRoutes(router);

  // --- connexion --------------------------------------------------------------
  // SEULE route /api/admin/* volontairement HORS guard : elle sert à obtenir
  // l'accès. Elle ne renvoie jamais de donnée métier — juste oui/non (+ session).
  router.post("/api/admin/login", async (req, env) => {
    const body = (await req.json().catch(() => ({}))) as { user?: unknown; password?: unknown };
    const user = typeof body.user === "string" ? body.user.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!user || !password) return apiError(400, "identifiant et mot de passe requis");
    // Garde IP : depuis une adresse hors liste, seul le compte « sauvegarde »
    // (tiré depuis le Mac, export seul) peut ouvrir une session.
    if (isIpDenied(req) && user !== BACKUP_USER) return ipDeniedResponse();

    // 1) Comptes en base (gérés par la page Utilisateurs) → session de 30 jours.
    const row = await env.DB.prepare("SELECT id, username, password_hash, active FROM admin_users WHERE username = ?")
      .bind(user)
      .first<{ id: number; username: string; password_hash: string; active: number }>();
    if (row) {
      if (!row.active) return apiError(401, "compte désactivé");
      if (!(await verifyPassword(password, row.password_hash))) {
        await audit(env.DB, "admin", "login.failed", `user:${row.username}`);
        return apiError(401, "identifiant ou mot de passe incorrect");
      }
      const session = await createSession(env.DB, row.id);
      await audit(env.DB, "admin", "login.ok", `user:${row.username}`);
      return json({ ok: true, user: row.username, session });
    }

    // 2) Accès de secours : secret ADMIN_TOKEN (pas de session — le navigateur
    //    conserve id:mdp et la garde le revérifie à chaque requête).
    const raw = env.ADMIN_TOKEN?.trim();
    if (raw && checkCredentials(raw, user, password)) return json({ ok: true, user });
    if (!raw) {
      const hasUsers = await env.DB.prepare("SELECT 1 FROM admin_users LIMIT 1").first();
      if (!hasUsers) return apiError(503, "ADMIN_TOKEN non configuré — accès refusé (fail-closed)");
    }
    await audit(env.DB, "admin", "login.failed", `user:${user.slice(0, 40)}`);
    return apiError(401, "identifiant ou mot de passe incorrect");
  });

  router.post("/api/admin/logout", guard(async (req, env) => {
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented.startsWith("session:")) await deleteSession(env.DB, presented.slice(8));
    return json({ ok: true });
  }));

  // --- utilisateurs (page Utilisateurs — tout se gère depuis le back-office) --
  router.get("/api/admin/users", guard(async (_req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT u.id, u.username, u.active, u.created_at, u.last_login_at, " +
        "(SELECT COUNT(*) FROM admin_sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions " +
        "FROM admin_users u ORDER BY u.username",
    ).all();
    return json({ users: results, breakGlass: Boolean(env.ADMIN_TOKEN?.trim()) });
  }));

  router.post("/api/admin/users", guard(async (req, env) => {
    if (!isHuman(req)) return apiError(403, "les comptes du back-office se gèrent depuis une session humaine (pas par une clé de service)");
    const body = (await req.json().catch(() => ({}))) as { username?: unknown };
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{1,19}$/.test(username)) {
      return apiError(400, "identifiant invalide — 2 à 20 caractères parmi a-z, 0-9, point, tiret, underscore");
    }
    const exists = await env.DB.prepare("SELECT 1 FROM admin_users WHERE username = ?").bind(username).first();
    if (exists) return apiError(409, "cet identifiant existe déjà");
    const password = generatePassword();
    const res = await env.DB.prepare("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)")
      .bind(username, await hashPassword(password))
      .run();
    await audit(env.DB, "admin", "user.create", `user:${username}`, { par: currentUser(req) });
    // Le mot de passe n'est affiché qu'une fois — il n'est stocké que haché.
    return json({ ok: true, id: res.meta.last_row_id, username, password });
  }));

  router.post("/api/admin/users/:id/reset-password", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "les comptes du back-office se gèrent depuis une session humaine (pas par une clé de service)");
    const id = Number(p.id);
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    const password = generatePassword();
    await env.DB.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), id).run();
    await deleteUserSessions(env.DB, id); // l'ancien mot de passe et ses sessions tombent ensemble
    await audit(env.DB, "admin", "user.reset_password", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true, username: row.username, password });
  }));

  router.patch("/api/admin/users/:id", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "les comptes du back-office se gèrent depuis une session humaine (pas par une clé de service)");
    const id = Number(p.id);
    const body = (await req.json().catch(() => ({}))) as { active?: unknown };
    if (typeof body.active !== "boolean") return apiError(400, "champ active (booléen) requis");
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    if (!body.active && row.username === currentUser(req)) return apiError(400, "impossible de désactiver son propre compte");
    await env.DB.prepare("UPDATE admin_users SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
    if (!body.active) await deleteUserSessions(env.DB, id);
    await audit(env.DB, "admin", body.active ? "user.enable" : "user.disable", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  router.delete("/api/admin/users/:id", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "les comptes du back-office se gèrent depuis une session humaine (pas par une clé de service)");
    const id = Number(p.id);
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    if (row.username === currentUser(req)) return apiError(400, "impossible de supprimer son propre compte");
    await deleteUserSessions(env.DB, id);
    await env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(id).run();
    await audit(env.DB, "admin", "user.delete", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- référentiel de base ----------------------------------------------------
  router.get("/api/admin/properties", guard(async (_req, env) => json({ properties: await listProperties(env.DB) })));

  router.get("/api/admin/units", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ units: await listUnits(env.DB, propertyId), links: await listLinks(env.DB, propertyId) });
  }));

  router.patch("/api/admin/units/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    if (!id) return apiError(400, "id invalide");
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return apiError(400, "corps JSON attendu");

    // Garde-fous de prix par hébergement (issue #31) : null pour les retirer.
    const priceMinCents =
      !("priceMinCents" in body) ? undefined : body.priceMinCents == null ? null : Math.round(Number(body.priceMinCents));
    const priceMaxCents =
      !("priceMaxCents" in body) ? undefined : body.priceMaxCents == null ? null : Math.round(Number(body.priceMaxCents));

    // Arrhes propres à l'hébergement (issue #75). Champ vidé → null, ce qui
    // signifie « repli sur le pourcentage du domaine » et non « 0 % ».
    let depositPct: number | null | undefined;
    if ("depositPct" in body) {
      if (body.depositPct == null || body.depositPct === "") {
        depositPct = null;
      } else {
        const v = Math.round(Number(body.depositPct));
        if (!Number.isFinite(v) || v < 0 || v > 100) return apiError(400, "pourcentage d'arrhes attendu entre 0 et 100");
        depositPct = v;
      }
    }
    if (priceMinCents !== undefined || priceMaxCents !== undefined) {
      const unit = await getUnit(env.DB, id);
      if (!unit) return apiError(404, "hébergement inconnu");
      const nextMin = priceMinCents === undefined ? unit.priceMinCents : priceMinCents;
      const nextMax = priceMaxCents === undefined ? unit.priceMaxCents : priceMaxCents;
      const ok = checkBounds(nextMin, nextMax);
      if (!ok.ok) return apiError(400, ok.message);
    }

    await updateUnit(env.DB, id, {
      priceMinCents,
      priceMaxCents,
      depositPct,
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      capacityBase: body.capacityBase != null ? Number(body.capacityBase) : undefined,
      capacityMax: body.capacityMax != null ? Number(body.capacityMax) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      compositePricing: body.compositePricing === "own" || body.compositePricing === "sum" ? body.compositePricing : undefined,
      cleaningFeeCents: body.cleaningFeeCents != null ? Math.round(Number(body.cleaningFeeCents)) : undefined,
      photoUrl: typeof body.photoUrl === "string" ? body.photoUrl.trim() : undefined,
    });
    await audit(env.DB, "admin", "unit.update", `unit:${id}`, { ...body, par: currentUser(req) });
    return json({ ok: true });
  }));

  // Nouveau bien (maison C, futur gîte…) + liaisons mutuelles optionnelles.
  router.post("/api/admin/units", guard(async (req, env) => {
    const body = await readJson<Record<string, unknown>>(req);
    const name = String(body?.name ?? "").trim();
    const propertyId = intParam(String(body?.propertyId ?? ""), 0);
    if (!body || !name || !propertyId) return apiError(400, "propertyId et name requis");
    const capacityBase = Math.max(1, Math.floor(Number(body.capacityBase ?? 2)));
    const capacityMax = Math.max(capacityBase, Math.floor(Number(body.capacityMax ?? capacityBase)));
    const id = await createUnit(env.DB, {
      propertyId,
      name,
      description: typeof body.description === "string" ? body.description : null,
      capacityBase,
      capacityMax,
      isComposite: body.isComposite === true,
      compositePricing: body.compositePricing === "sum" ? "sum" : "own",
      cleaningFeeCents: body.cleaningFeeCents != null ? Math.round(Number(body.cleaningFeeCents)) : 0,
      photoUrl: typeof body.photoUrl === "string" ? body.photoUrl.trim() || null : null,
    });
    if (Array.isArray(body.linkedUnitIds) && body.linkedUnitIds.length > 0) {
      await setMutualLinks(env.DB, id, body.linkedUnitIds.map(Number));
    }
    // règle tarifaire de départ optionnelle, pour que le bien soit vendable direct
    if (body.priceWeekCents != null) {
      const week = Math.round(Number(body.priceWeekCents));
      await createRateRule(env.DB, {
        unitId: id,
        seasonId: null,
        priceWeekCents: week,
        priceWeekendCents: Math.round(Number(body.priceWeekendCents ?? week)),
        holidayPct: 15,
        minNights: Math.max(1, Math.floor(Number(body.minNights ?? 2))),
        checkinDays: null,
      });
    }
    await audit(env.DB, "admin", "unit.create", `unit:${id}`, { name, propertyId, par: currentUser(req) });
    return json({ id }, 201);
  }));

  // Liaisons mutuelles d'un bien (résa de l'un ⇒ blocage de l'autre, 2 sens).
  router.put("/api/admin/units/:id/links", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ partnerIds?: unknown[] }>(req);
    if (!id || !body || !Array.isArray(body.partnerIds)) return apiError(400, "partnerIds attendu");
    await setMutualLinks(env.DB, id, body.partnerIds.map(Number));
    await audit(env.DB, "admin", "unit.links", `unit:${id}`, { partnerIds: body.partnerIds, par: currentUser(req) });
    return json({ ok: true });
  }));

  /* ── Galerie de photos d'un hébergement (issue #32) ───────────────────────
   *
   * Ce que le back-office fait : ordonner, retirer, réactiver, corriger le
   * texte alternatif et la légende. Ce qu'il ne fait PAS : téléverser. Les
   * fichiers restent des assets commités, produits par
   * `scripts/optimize-images.mjs` et servis par le binding ASSETS. « Ajouter »
   * signifie donc rattacher un fichier DÉJÀ présent, et le serveur le vérifie
   * en allant vraiment le chercher.
   * ------------------------------------------------------------------------ */

  /** Chemins acceptés : un JPEG sous /img/, sans remontée de dossier. La liste
   *  blanche vaut mieux qu'une chasse aux « .. » — un chemin encodé (`%2e%2e`)
   *  ne franchit pas cette expression.
   *
   *  JPEG SEULEMENT, et c'est volontaire : `path` est le fichier de REPLI, celui
   *  que reçoit un navigateur sans WebP. Accepter un `.webp` ici priverait ces
   *  navigateurs de toute image ; accepter un `.png` donnerait un fichier dont
   *  `imageSize()` ne sait pas lire les dimensions. */
  const PHOTO_PATH = /^\/img\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpg|jpeg)$/;

  router.get("/api/admin/units/:id/photos", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    if (!id) return apiError(400, "id d'hébergement attendu");
    const photos = await listUnitPhotos(env.DB, [id], true);
    return json({ photos });
  }));

  // Ordre, éditorial et affichage en une seule écriture : la vue envoie la
  // liste complète telle qu'elle est à l'écran, l'ordre du tableau FAIT
  // l'ordre d'affichage. Un `sort_order` saisi à la main serait un piège.
  router.put("/api/admin/units/:id/photos", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ photos?: unknown }>(req);
    if (!id || !body || !Array.isArray(body.photos)) return apiError(400, "photos attendu");

    const connues = new Map((await listUnitPhotos(env.DB, [id], true)).map((ph) => [ph.id, ph]));
    const photos: { id: number; alt: string; caption: string | null; active: boolean }[] = [];
    for (const raw of body.photos as Record<string, unknown>[]) {
      const photoId = Math.round(Number(raw?.id));
      if (!Number.isFinite(photoId) || !connues.has(photoId)) return apiError(400, "photo inconnue pour cet hébergement");
      // Texte alternatif OBLIGATOIRE (issue #32) : une photo sans alt est
      // invisible pour qui ne voit pas l'image. Le refus est net, pas un
      // silence qui laisserait passer une chaîne vide.
      const alt = String(raw.alt ?? "").trim();
      if (alt.length < 3) return apiError(400, "texte alternatif obligatoire sur chaque photo (3 caractères minimum)");
      if (alt.length > 300) return apiError(400, "texte alternatif trop long (300 caractères maximum)");
      const caption = String(raw.caption ?? "").trim();
      if (caption.length > 200) return apiError(400, "légende trop longue (200 caractères maximum)");
      photos.push({ id: photoId, alt, caption: caption || null, active: raw.active !== false });
    }
    if (photos.length !== connues.size) return apiError(400, "la liste doit contenir toutes les photos de l'hébergement");
    if (new Set(photos.map((ph) => ph.id)).size !== photos.length) return apiError(400, "photo citée deux fois");

    await updateUnitPhotos(env.DB, id, photos);
    await audit(env.DB, "admin", "unit.photos", `unit:${id}`, {
      ordre: photos.map((ph) => ph.id),
      masquees: photos.filter((ph) => !ph.active).length,
      par: currentUser(req),
    });
    return json({ ok: true });
  }));

  // Rattache un fichier DÉJÀ COMMITÉ à la galerie. Le serveur le télécharge
  // depuis son propre binding ASSETS : c'est ce qui distingue « choisir parmi
  // les fichiers présents » d'une saisie d'URL arbitraire, et c'est aussi ce
  // qui donne les dimensions sans les demander à personne.
  router.post("/api/admin/units/:id/photos", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Record<string, unknown>>(req);
    if (!id || !body) return apiError(400, "corps de requête attendu");
    const unit = await getUnit(env.DB, id);
    if (!unit) return apiError(404, "hébergement inconnu");

    const path = String(body.path ?? "").trim();
    if (!PHOTO_PATH.test(path)) return apiError(400, "chemin attendu sous /img/, fichier .jpg uniquement");
    const alt = String(body.alt ?? "").trim();
    if (alt.length < 3) return apiError(400, "texte alternatif obligatoire (3 caractères minimum)");
    if (alt.length > 300) return apiError(400, "texte alternatif trop long (300 caractères maximum)");
    const caption = String(body.caption ?? "").trim();
    if (caption.length > 200) return apiError(400, "légende trop longue (200 caractères maximum)");

    if (!env.ASSETS) return apiError(503, "vérification des fichiers indisponible");
    // `PUBLIC_BASE_URL` est déclarée dans wrangler.jsonc, mais une valeur vide ou
    // mal formée ferait lever `new URL` et répondre 500 au lieu d'un message.
    const origine = /^https?:\/\//.test(env.PUBLIC_BASE_URL ?? "") ? env.PUBLIC_BASE_URL : "http://assets.local";
    const lire = async (chemin: string): Promise<Uint8Array | null> => {
      const res = await env.ASSETS.fetch(new Request(new URL(chemin, origine)));
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    };
    const octets = await lire(path);
    if (!octets) return apiError(400, "fichier introuvable dans public/ — le déposer et le commiter d'abord");
    const taille = imageSize(path, octets);
    if (!taille) return apiError(400, "fichier illisible comme image");

    // Variantes WebP déduites par convention `<base>-<largeur>.webp`, celle que
    // produit optimize-images.mjs. On vérifie leur présence réelle plutôt que
    // de la supposer : trois photos du site n'ont volontairement pas de WebP.
    const base = path.replace(/\.[a-z]+$/i, "");
    const webpWidths: number[] = [];
    for (const w of [640, 1280]) {
      if (await lire(`${base}-${w}.webp`)) webpWidths.push(w);
    }

    const photoId = await createUnitPhoto(env.DB, {
      unitId: id,
      path,
      alt,
      caption: caption || null,
      webpWidths,
      width: taille.width,
      height: taille.height,
    });
    if (photoId == null) return apiError(409, "cette photo est déjà dans la galerie de cet hébergement");
    await audit(env.DB, "admin", "unit.photo.add", `unit:${id}`, { path, par: currentUser(req) });
    return json({ id: photoId }, 201);
  }));

  // Calendrier des tarifs (vue elloha) : prix calculé jour par jour, avec sa
  // PROVENANCE (surcharge / saison / tarif de base) pour que la cellule sache
  // se colorer, et le prix qu'aurait le jour sans sa surcharge.
  //
  // `?unit=` → un bien (forme historique, inchangée pour le back-office actuel).
  // `?units=1,2,3` ou `?property=` → plusieurs biens en UNE requête : la vue
  // année sur trois hébergements coûtait sinon trois appels, six en changeant
  // d'année (spec UX § 9).
  router.get("/api/admin/rate-calendar", guard(async (_req, env, _p, url) => {
    let from = url.searchParams.get("from") ?? "";
    let to = url.searchParams.get("to") ?? "";
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to) {
      from = todayInZone().slice(0, 8) + "01";
      to = addDays(from, 62);
    }
    if (diffDays(from, to) > MAX_RANGE_DAYS) to = addDays(from, MAX_RANGE_DAYS);

    const unitsParam = url.searchParams.get("units");
    const propertyParam = url.searchParams.get("property");
    const multi = unitsParam != null || propertyParam != null;

    if (!multi) {
      const unitId = intParam(url.searchParams.get("unit"), 0);
      const ctx = await getQuoteContext(env.DB, unitId, { from, toExclusive: to });
      if (!ctx) return apiError(404, "hébergement inconnu");
      const days = rateCalendar(ctx.pricingUnit, from, to, ctx.seasons, ctx.rateRules, ctx.rateOverrides);
      return json({
        unit: {
          id: ctx.unit.id,
          name: ctx.unit.name,
          cleaningFeeCents: ctx.unit.cleaningFeeCents,
          // Un bien composite en mode « somme » n'a pas de prix propre : son
          // calendrier est la somme des maisons et n'accepte pas de surcharge
          // (spec UX § 5 — l'interface doit le dire, pas laisser essayer).
          editable: !(ctx.unit.isComposite && ctx.unit.compositePricing === "sum"),
          compositePricing: ctx.unit.compositePricing,
          priceMinCents: ctx.unit.priceMinCents,
          priceMaxCents: ctx.unit.priceMaxCents,
        },
        from,
        to,
        days,
        seasons: ctx.seasons,
      });
    }

    const propertyId = intParam(propertyParam, 1);
    const wanted = unitsParam
      ? new Set(unitsParam.split(",").map((v) => Math.floor(Number(v))).filter((n) => n > 0))
      : null;
    const [units, links, seasons, rules, overrides] = await Promise.all([
      listUnits(env.DB, propertyId),
      listLinks(env.DB, propertyId),
      listSeasons(env.DB, propertyId),
      listRateRules(env.DB, propertyId),
      listRateOverridesForProperty(env.DB, propertyId, from, to),
    ]);
    const active = units.filter((u) => u.active && (!wanted || wanted.has(u.id)));
    const physicalIds = new Set(units.filter((u) => u.active && !u.isComposite).map((u) => u.id));
    const out = active.map((u) => {
      const pricingUnit: UnitPricingInfo = {
        id: u.id,
        name: u.name,
        compositePricing: u.isComposite ? u.compositePricing : "own",
        cleaningFeeCents: u.cleaningFeeCents,
        depositPct: u.depositPct,
        components: u.isComposite
          ? links
              .filter((l) => l.unitId === u.id && physicalIds.has(l.blocksUnitId))
              .map((l) => {
                const c = units.find((x) => x.id === l.blocksUnitId);
                return { id: l.blocksUnitId, name: c?.name ?? "", cleaningFeeCents: c?.cleaningFeeCents ?? 0 };
              })
          : [],
      };
      return {
        unit: {
          id: u.id,
          name: u.name,
          cleaningFeeCents: u.cleaningFeeCents,
          editable: !(u.isComposite && u.compositePricing === "sum"),
          compositePricing: u.compositePricing,
          priceMinCents: u.priceMinCents,
          priceMaxCents: u.priceMaxCents,
        },
        days: rateCalendar(pricingUnit, from, to, seasons, rules, overrides),
      };
    });
    return json({ from, to, units: out, seasons });
  }));

  // --- surcharges tarifaires par jour (issue #23) -----------------------------

  // Surcharges brutes d'un bien sur une plage — ce qui est POSÉ à la main,
  // sans le calcul. Le calendrier ci-dessus donne le résultat effectif.
  router.get("/api/admin/rate-overrides", guard(async (_req, env, _p, url) => {
    const unitId = intParam(url.searchParams.get("unit"), 0);
    if (!unitId) return apiError(400, "unit requis");
    const range = parseRange(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    if (!range.ok) return apiError(400, range.message);
    const overrides = await listRateOverrides(env.DB, [unitId], range.from, addDays(range.to, 1));
    return json({ unitId, from: range.from, to: range.to, overrides });
  }));

  // Pose ou retire prix et minimum de nuits sur [from, to] INCLUS, avec un
  // filtre optionnel de jours de semaine (`weekdays=5,6` → les week-ends).
  //
  // Sémantique de chaque champ, pensée pour l'éditeur de cellule :
  //   absent  → on ne touche pas à cette valeur ;
  //   nombre  → on la pose (validée : > 0 et dans les bornes du bien) ;
  //   null    → on la RETIRE, le jour repasse au tarif de saison.
  // Une surcharge vidée des deux côtés disparaît : retirer un prix ne laisse
  // jamais un 0 fantôme derrière lui.
  router.patch("/api/admin/rate-overrides", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{
      unitId?: unknown; from?: unknown; to?: unknown; weekdays?: unknown;
      priceCents?: unknown; minNights?: unknown;
    }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const unitId = intParam(String(body.unitId ?? ""), 0);
    if (!unitId) return apiError(400, "unitId requis");
    const range = parseRange(String(body.from ?? ""), String(body.to ?? ""));
    if (!range.ok) return apiError(400, range.message);

    const unit = await getUnit(env.DB, unitId);
    if (!unit) return apiError(404, "hébergement inconnu");
    // Spec UX § 5 : un bien composite en mode « somme » n'a pas de prix propre.
    if (unit.isComposite && unit.compositePricing === "sum") {
      return apiError(409, `« ${unit.name} » est tarifé par la somme de ses maisons — posez le prix sur chaque maison, ou basculez ce bien en tarif propre`);
    }

    const hasPrice = "priceCents" in body;
    const hasMinNights = "minNights" in body;
    if (!hasPrice && !hasMinNights) return apiError(400, "priceCents ou minNights attendu");

    let priceCents: number | null | undefined;
    if (hasPrice) {
      if (body.priceCents === null) {
        priceCents = null;
      } else {
        const c = checkPrice(body.priceCents, { minCents: unit.priceMinCents, maxCents: unit.priceMaxCents }, "prix");
        if (!c.ok) return apiError(400, c.message);
        priceCents = c.cents;
      }
    }

    let minNights: number | null | undefined;
    if (hasMinNights) {
      if (body.minNights === null) {
        minNights = null;
      } else {
        const n = Math.floor(Number(body.minNights));
        if (!Number.isFinite(n) || n < 1 || n > 60) return apiError(400, "minimum de nuits invalide (1 à 60)");
        minNights = n;
      }
    }

    const weekdays = parseWeekdays(body.weekdays);
    const days = expandRange(range.from, range.to, weekdays);
    if (days.length === 0) return apiError(400, "aucun jour dans la plage après filtrage");

    const res = await setRateOverrides(env.DB, unitId, days, { priceCents, minNights });
    await audit(env.DB, "admin", "rate.override", `unit:${unitId}`, {
      from: range.from, to: range.to, weekdays, priceCents, minNights, ...res, par: currentUser(req),
    });
    await triggerBeds24Push(env.DB, env, execCtx, unit.propertyId);
    return json({ ok: true, unitId, from: range.from, to: range.to, days: days.length, ...res });
  }));

  // Retire toute surcharge sur une plage — retour au tarif de saison. Sert
  // aussi de bouton « Annuler » après avoir peint une plage (spec UX § 7).
  router.delete("/api/admin/rate-overrides", guard(async (req, env, _p, url, execCtx) => {
    const unitId = intParam(url.searchParams.get("unit"), 0);
    if (!unitId) return apiError(400, "unit requis");
    const range = parseRange(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    if (!range.ok) return apiError(400, range.message);
    const unit = await getUnit(env.DB, unitId);
    if (!unit) return apiError(404, "hébergement inconnu");
    const days = expandRange(range.from, range.to, parseWeekdays(url.searchParams.get("weekdays")));
    const removed = await deleteRateOverrides(env.DB, unitId, days);
    await audit(env.DB, "admin", "rate.override_clear", `unit:${unitId}`, { from: range.from, to: range.to, removed, par: currentUser(req) });
    await triggerBeds24Push(env.DB, env, execCtx, unit.propertyId);
    return json({ ok: true, unitId, removed });
  }));

  // --- prix conseillé par plateforme (issue #31) ------------------------------

  // Les places de marché prennent une commission : le tarif qu'on y affiche est
  // volontairement majoré par rapport à la vente directe. Le calcul est
  // délibérément sans magie — prix direct × (1 + majoration %) — pour que le
  // propriétaire puisse le refaire de tête et rester maître de ses prix.
  /** Valide le canal de référence demandé — AVANT toute écriture, pour qu'une
   *  demande refusée ne laisse pas la moitié du réglage posée en base.
   *  Chaîne vide (ou `null`) = retour au prix de vente directe. */
  function checkPushChannel(
    raw: unknown,
    channels: readonly ChannelMarkup[],
  ): { ok: true; value: string } | { ok: false; response: Response } {
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      return { ok: false, response: apiError(400, "canal invalide — attendu son identifiant, ou null pour ne rien majorer") };
    }
    const wanted = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (wanted && !channels.some((c) => c.channel === wanted)) {
      const known = channels.map((c) => c.channel).join(", ") || "aucun";
      return { ok: false, response: apiError(400, `canal « ${wanted} » inconnu — canaux configurés : ${known}`) };
    }
    return { ok: true, value: wanted };
  }

  /** Écrit le canal de référence et le journalise. Le push est décidé par
   *  l'appelant : toute écriture ne change pas forcément le prix poussé. */
  async function writePushChannel(
    env: Env,
    req: Request,
    value: string,
    channels: readonly ChannelMarkup[],
  ): Promise<void> {
    await setSetting(env.DB, PUSH_CHANNEL_KEY, value);
    await audit(env.DB, "admin", "pricing.push_channel", "app", {
      channel: value || null,
      markupPct: pushMarkupPct(channels, value || null),
      par: currentUser(req),
    });
  }

  // Réponse commune aux trois routes de majoration : les canaux configurés,
  // la formule en toutes lettres, et LEQUEL sert de référence au push.
  async function channelMarkupState(db: D1Database): Promise<{
    channels: ChannelMarkup[];
    examples: ChannelSuggestion[];
    formula: string;
    maxPct: number;
    pushChannel: string | null;
    pushMarkupPct: number;
    example: { directCents: number; pushedCents: number };
  }> {
    const channels = parseChannelMarkups(await getSetting(db, CHANNEL_MARKUPS_KEY));
    const pushChannel = parsePushChannel(await getSetting(db, PUSH_CHANNEL_KEY), channels);
    const pct = pushMarkupPct(channels, pushChannel);
    return {
      channels,
      // Un exemple chiffré vaut mieux qu'un pourcentage seul : c'est lui qui
      // permet au propriétaire de vérifier d'un coup d'œil ce qui part. Il est
      // calculé ICI, avec l'arrondi du moteur — le back-office l'affiche, il
      // ne le recalcule pas (deux arrondis finiraient par diverger).
      examples: suggestForChannels(EXAMPLE_PRICE_CENTS, channels),
      formula: CHANNEL_PRICE_FORMULA,
      // Borne de saisie, donnée par le serveur pour que l'écran ne la recopie pas.
      maxPct: CHANNEL_MARKUP_MAX_PCT,
      pushChannel,
      pushMarkupPct: pct,
      example: { directCents: EXAMPLE_PRICE_CENTS, pushedCents: pushedPriceCents(EXAMPLE_PRICE_CENTS, pct) },
    };
  }

  router.get("/api/admin/channel-markups", guard(async (_req, env) => json(await channelMarkupState(env.DB))));

  router.put("/api/admin/channel-markups", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{ channels?: unknown; pushChannel?: unknown }>(req);
    const channels = normalizeChannelMarkups(body?.channels, CHANNEL_MARKUP_MAX_PCT);
    if (!channels) {
      return apiError(400, `canaux invalides — attendu une liste { channel, label, markupPct 0 à ${CHANNEL_MARKUP_MAX_PCT} }`);
    }
    // Le canal de référence est facultatif ici : on ne le touche que s'il est
    // fourni. Sinon, un simple ajustement de pourcentage le remettrait à zéro.
    const wanted = body && "pushChannel" in body ? checkPushChannel(body.pushChannel, channels) : null;
    if (wanted && !wanted.ok) return wanted.response;

    const before = await channelMarkupState(env.DB);
    await setSetting(env.DB, CHANNEL_MARKUPS_KEY, JSON.stringify(channels));
    await audit(env.DB, "admin", "pricing.channel_markups", "app", { channels, par: currentUser(req) });
    if (wanted?.ok) await writePushChannel(env, req, wanted.value, channels);

    const after = await channelMarkupState(env.DB);
    // Prix dérivés actifs (lot 3) : les multiplicateurs vivent chez Beds24, ils
    // repartent avec la nouvelle majoration. Un échec n'annule pas
    // l'enregistrement : il est dit, et l'écran Plateformes montre « à renvoyer ».
    let linking: { resent: boolean; error?: string } | undefined;
    if (parsePriceLinking(await getSetting(env.DB, PRICE_LINKING_KEY)).enabled && beds24WritesAllowed(env)) {
      try {
        await sendPriceLinking(env, true);
        const lines = derivedLines(channels);
        await setSetting(env.DB, PRICE_LINKING_KEY, JSON.stringify({ enabled: true, sentMarkups: Object.fromEntries(lines.map((l) => [l.channel, l.markupPct])), sentAt: new Date().toISOString() }));
        linking = { resent: true };
      } catch (e) {
        linking = { resent: false, error: e instanceof Error ? e.message : String(e) };
        await audit(env.DB, "admin", "beds24.price_linking_failed", "app", { error: linking.error, journal: e instanceof PriceLinkingError ? e.journal : undefined, par: currentUser(req) });
      }
    }
    if (linking) return json({ ...after, linking });
    // Changer un pourcentage, ou retirer le canal appliqué de la liste, change
    // le prix qui part aux plateformes : sans ce push, Airbnb et Booking
    // garderaient l'ancien prix jusqu'au prochain cron.
    if (after.pushMarkupPct !== before.pushMarkupPct) await triggerBeds24PushAll(env.DB, env, execCtx);
    return json(after);
  }));

  // « Appliquer le prix conseillé au canal » (issue #31). Un prix par canal ne
  // se stocke nulle part — et n'aurait de sens nulle part ailleurs : le SEUL
  // endroit où un prix part vers une place de marché est le calendrier poussé
  // à Beds24. On y applique donc la majoration du canal choisi ; le prix de
  // vente directe, lui, n'est jamais modifié.
  router.post("/api/admin/channel-markups/apply", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{ channel?: unknown }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const channels = parseChannelMarkups(await getSetting(env.DB, CHANNEL_MARKUPS_KEY));
    const wanted = checkPushChannel(body.channel, channels);
    if (!wanted.ok) return wanted.response;
    await writePushChannel(env, req, wanted.value, channels);
    // Geste explicite du propriétaire : on renvoie les calendriers sans se
    // demander si la valeur a changé — c'est ce qu'il vient de demander.
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json(await channelMarkupState(env.DB));
  }));

  // Prix conseillé, sur un prix isolé (`?priceCents=`, pour l'éditeur de
  // cellule) ou jour par jour sur une plage (`?unit=&from=&to=`).
  router.get("/api/admin/suggested-prices", guard(async (_req, env, _p, url) => {
    const channels = parseChannelMarkups(await getSetting(env.DB, CHANNEL_MARKUPS_KEY));
    // Le canal actuellement appliqué au push, pour que l'interface montre ce
    // qui est déjà en place au lieu de reproposer de l'appliquer.
    const pushChannel = parsePushChannel(await getSetting(env.DB, PUSH_CHANNEL_KEY), channels);
    const rawPrice = url.searchParams.get("priceCents");
    if (rawPrice != null) {
      const cents = Math.round(Number(rawPrice));
      if (!Number.isFinite(cents) || cents < 1) return apiError(400, "priceCents invalide");
      return json({
        directCents: cents,
        channels: suggestForChannels(cents, channels),
        formula: CHANNEL_PRICE_FORMULA,
        pushChannel,
      });
    }

    const unitId = intParam(url.searchParams.get("unit"), 0);
    if (!unitId) return apiError(400, "priceCents ou unit requis");
    const range = parseRange(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    if (!range.ok) return apiError(400, range.message);
    const toExclusive = addDays(range.to, 1);
    const ctx = await getQuoteContext(env.DB, unitId, { from: range.from, toExclusive });
    if (!ctx) return apiError(404, "hébergement inconnu");
    const days = rateCalendar(ctx.pricingUnit, range.from, toExclusive, ctx.seasons, ctx.rateRules, ctx.rateOverrides);
    return json({
      unit: { id: ctx.unit.id, name: ctx.unit.name },
      from: range.from,
      to: range.to,
      formula: CHANNEL_PRICE_FORMULA,
      pushChannel,
      days: days.map((d) => ({
        date: d.date,
        directCents: d.priceCents,
        source: d.source,
        channels: d.priceCents == null ? [] : suggestForChannels(d.priceCents, channels),
      })),
    });
  }));

  router.patch("/api/admin/properties/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Record<string, unknown>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateProperty(env.DB, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      address: typeof body.address === "string" ? body.address : undefined,
      commune: typeof body.commune === "string" ? body.commune : undefined,
      contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : undefined,
      contactPhone: typeof body.contactPhone === "string" ? body.contactPhone : undefined,
    });
    await audit(env.DB, "admin", "property.update", `property:${id}`, { ...body, par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- tableau de bord ----------------------------------------------------------
  router.get("/api/admin/overview", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const property = await getProperty(db, propertyId);
    if (!property) return apiError(404, "domaine inconnu");

    const now = new Date();
    const today = todayInZone(now);
    const nowSql = sqlNow(now);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));

    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);

    // Occupation & revenus du mois en cours (et du même mois N-1)
    const curBookings = await confirmedYearBookings(db, propertyId, year);
    const prevBookings = await confirmedYearBookings(db, propertyId, year - 1);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const cur = computeYearStats(year, statsUnits, links, curBookings);
    const prev = computeYearStats(year - 1, statsUnits, links, prevBookings);
    const curMonth = cur.months[month - 1];
    const prevMonth = prev.months[month - 1];

    // Fenêtre large pour arrivées/départs/alertes
    const wide = await bookingsInWindow(db, propertyId, addDays(today, -1), addDays(today, 540));
    const confirmed = wide.filter((b) => b.status === "confirmed");

    const horizon = addDays(today, 7);
    const arrivals = confirmed
      .filter((b) => b.checkin >= today && b.checkin < horizon)
      .map((b) => ({ ...summary(b), kind: "arrivée" as const }));
    const departures = confirmed
      .filter((b) => b.checkout >= today && b.checkout < horizon)
      .map((b) => ({ ...summary(b), kind: "départ" as const }));

    const nextArrival = confirmed.filter((b) => b.checkin >= today).sort((a, b) => (a.checkin < b.checkin ? -1 : 1))[0] ?? null;

    const balancesDue = confirmed
      .filter((b) => b.totalCents - b.paidCents > 0)
      .map((b) => ({
        ...summary(b),
        balanceCents: b.totalCents - b.paidCents,
        balanceDueDate: b.balanceDueDate,
        overdue: !!b.balanceDueDate && b.balanceDueDate <= today,
      }));

    const activeHolds = wide.filter((b) => b.status === "pending" && isActiveBooking({ status: b.status, holdExpiresAt: b.holdExpiresAt }, nowSql));

    const compositeIds = new Set(units.filter((u) => u.isComposite).map((u) => u.id));
    const linkAlerts = confirmed
      .filter((b) => compositeIds.has(b.unitId) && b.checkout >= today && b.checkin <= addDays(today, 60))
      .map((b) => {
        const blocked = links.filter((l) => l.unitId === b.unitId).map((l) => units.find((u) => u.id === l.blocksUnitId)?.name ?? "");
        // `id` : sans lui l'alerte du tableau de bord ne mène nulle part (issue #48).
        return { id: b.id, reference: b.reference, checkin: b.checkin, checkout: b.checkout, unitName: b.unitName, blocked };
      });

    // `listFeeds` ne connaît pas les domaines : sans ce filtre, le tableau de
    // bord d'un domaine affiche les flux en erreur de l'autre — et depuis que
    // l'alerte est cliquable (issue #48), elle mène alors à une vue Synchro où
    // le flux nommé n'existe pas.
    const unitIds = new Set(units.map((u) => u.id));
    const feeds = (await listFeeds(db)).filter((f) => unitIds.has(f.unitId));
    const feedAlerts = feeds.filter((f) => f.lastStatus && f.lastStatus !== "ok");

    // Carte « Santé » : ce qui échoue aujourd'hui sans que personne ne l'apprenne
    // (audit ECC 2026-07-30 § observabilité). Un échec de lecture ne doit jamais
    // faire tomber le tableau de bord — d'où le repli neutre.
    let health: Awaited<ReturnType<typeof healthSignals>> = {
      orphanPayments: [],
      overpaidBookings: [],
      failedEmails: [],
      recentErrors: [],
      beds24LastPull: null,
      beds24StaleHours: null,
    };
    try {
      health = await healthSignals(db, propertyId, now);
    } catch (e) {
      console.error("healthSignals —", e);
    }

    // Dérives LENTES (issue #71) : les quatre pannes qui ne lèvent aucune
    // erreur — flux iCal muet, unité sans tarif applicable, message client sans
    // réponse, traitement planifié à l'arrêt. Même repli neutre que ci-dessus :
    // une carte « Santé » ne doit jamais faire tomber le tableau de bord.
    let drift: DriftSignal[] = [];
    try {
      drift = detectDrift(await collectDriftInput(db, propertyId, now), now);
    } catch (e) {
      console.error("driftSignals —", e);
    }
    let newEmails = 0;
    try {
      newEmails = await countNewMessages(db, propertyId);
    } catch {
      newEmails = 0; // table absente tant que la migration 0005 n'est pas passée
    }

    function summary(b: BookingRow) {
      return {
        id: b.id,
        reference: b.reference,
        unitName: b.unitName,
        guestName: b.guestName,
        checkin: b.checkin,
        checkout: b.checkout,
        persons: b.adults + b.children,
        totalCents: b.totalCents,
        paidCents: b.paidCents,
        status: b.status,
      };
    }

    return json({
      property: { id: property.id, name: property.name },
      today,
      kpis: {
        monthLabel: today.slice(0, 7),
        occupancyPct: curMonth?.occupancyPct ?? 0,
        occupancyPrevPct: prevMonth?.occupancyPct ?? 0,
        revenueCents: curMonth?.revenueCents ?? 0,
        revenuePrevCents: prevMonth?.revenueCents ?? 0,
        nextArrival: nextArrival
          ? { checkin: nextArrival.checkin, unitName: nextArrival.unitName, persons: nextArrival.adults + nextArrival.children, guestName: nextArrival.guestName }
          : null,
        balanceDueTotalCents: balancesDue.reduce((s, b) => s + b.balanceCents, 0),
        balanceDueCount: balancesDue.length,
      },
      movements: [...arrivals, ...departures].sort((a, b) => ((a.kind === "arrivée" ? a.checkin : a.checkout) < (b.kind === "arrivée" ? b.checkin : b.checkout) ? -1 : 1)),
      alerts: {
        overdueBalances: balancesDue.filter((b) => b.overdue),
        linkAlerts,
        feedAlerts: feedAlerts.map((f) => ({ id: f.id, name: f.name, status: f.lastStatus })),
        activeHolds: activeHolds.map((b) => ({ id: b.id, reference: b.reference, unitName: b.unitName, holdExpiresAt: b.holdExpiresAt })),
        newEmails,
      },
      health: {
        ...health,
        // Beds24 figé > 2 h = les calendriers OTA ne reflètent plus nos dates :
        // risque de surbooking silencieux tant que personne ne regarde.
        beds24Stale: health.beds24StaleHours != null && health.beds24StaleHours > 2,
        drift,
        ok:
          health.orphanPayments.length === 0 &&
          health.overpaidBookings.length === 0 &&
          health.failedEmails.length === 0 &&
          health.recentErrors.length === 0 &&
          drift.length === 0 &&
          !(health.beds24StaleHours != null && health.beds24StaleHours > 2),
      },
    });
  }));

  // --- planning -------------------------------------------------------------
  router.get("/api/admin/planning", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    let from = url.searchParams.get("from") ?? "";
    let to = url.searchParams.get("to") ?? "";
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to) {
      const today = todayInZone();
      from = today.slice(0, 8) + "01";
      to = addDays(from, 45);
    }
    const [units, links, rows, manual] = await Promise.all([
      listUnits(db, propertyId),
      listLinks(db, propertyId),
      bookingsInWindow(db, propertyId, from, to),
      manualBlocksInWindow(db, propertyId, from, to),
    ]);
    const now = sqlNow();
    const active = rows.filter((b) => isActiveBooking({ status: b.status, holdExpiresAt: b.holdExpiresAt }, now));
    const compositeIds = new Set(units.filter((u) => u.isComposite).map((u) => u.id));

    const bookings = active.map((b) => ({
      id: b.id,
      reference: b.reference,
      unitId: b.unitId,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
      source: b.source,
      channelLabel: b.channelLabel,
      guestName: b.guestName || b.channelLabel || "—",
      persons: b.adults + b.children,
      isComposite: compositeIds.has(b.unitId),
      paidState:
        b.totalCents <= 0 ? "n/a" : b.paidCents >= b.totalCents ? "soldée" : b.paidCents > 0 ? "acompte" : "impayée",
      balanceCents: Math.max(0, b.totalCents - b.paidCents),
    }));

    // Blocages par liaison : pour chaque unité, les résas actives — et les
    // blocages manuels — d'AUTRES unités qui la bloquent.
    const blocks: { unitId: number; checkin: IsoDate; checkout: IsoDate; sourceBookingId: number; sourceReference: string }[] = [];
    for (const u of units) {
      const blockers = new Set(links.filter((l) => l.blocksUnitId === u.id).map((l) => l.unitId));
      for (const b of active) {
        if (b.unitId !== u.id && blockers.has(b.unitId)) {
          blocks.push({ unitId: u.id, checkin: b.checkin, checkout: b.checkout, sourceBookingId: b.id, sourceReference: b.reference });
        }
      }
      for (const k of manual) {
        if (k.unitId !== u.id && blockers.has(k.unitId)) {
          blocks.push({
            unitId: u.id, checkin: k.checkin, checkout: k.checkout,
            sourceBookingId: 0,
            sourceReference: k.reason ? `blocage — ${k.reason}` : "blocage manuel",
          });
        }
      }
    }

    return json({
      from,
      to,
      units: units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active })),
      bookings,
      blocks,
      // Blocages manuels PORTÉS par l'unité (travaux, usage perso) : rendus
      // distincts du blocage par liaison, et supprimables en un clic (#74).
      manualBlocks: manual.map((k) => ({
        id: k.id,
        unitId: k.unitId,
        checkin: k.checkin,
        checkout: k.checkout,
        reason: k.reason,
        createdBy: k.createdBy,
      })),
    });
  }));

  // --- blocages manuels (issue #74) -----------------------------------------
  //
  // Un blocage n'est PAS une réservation : il n'entre ni dans les statistiques
  // de vente, ni dans les exports, ni dans les relances — toutes lisent
  // `bookings`. Mais il occupe le stock par le MÊME chemin atomique, liaisons
  // comprises : `createManualBlockAtomic` est le pendant exact de
  // `createBookingAtomic` (ARCHITECTURE.md §3).
  router.get("/api/admin/blocks", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const today = todayInZone();
    const from = isIsoDate(url.searchParams.get("from") ?? "") ? String(url.searchParams.get("from")) : today;
    const to = isIsoDate(url.searchParams.get("to") ?? "") ? String(url.searchParams.get("to")) : addDays(today, 540);
    return json({ blocks: await manualBlocksInWindow(env.DB, propertyId, from, to) });
  }));

  router.post("/api/admin/blocks", guard(async (req, env, _p, _url, execCtx) => {
    const db = env.DB;
    const body = await readJson<{ unitId?: number; checkin?: string; checkout?: string; reason?: string }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const checkin = String(body.checkin ?? "");
    const checkout = String(body.checkout ?? "");
    if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) return apiError(400, "dates invalides");
    const unit = await getUnit(db, Math.floor(Number(body.unitId)));
    if (!unit) return apiError(404, "hébergement inconnu");
    const reason = String(body.reason ?? "").trim().slice(0, 200);
    if (reason.length < 2) return apiError(400, "motif requis (travaux, usage personnel…)");

    const created = await createManualBlockAtomic(db, {
      unitId: unit.id,
      checkin,
      checkout,
      reason,
      createdBy: currentUser(req),
    });
    if (!created.ok) {
      // Le refus se nomme : « pris par PM-2026-004 » se tranche au téléphone.
      const [conflicts, others] = await Promise.all([
        blockingBookings(db, unit.id, checkin, checkout),
        blockingManualBlocks(db, unit.id, checkin, checkout),
      ]);
      return apiError(409, "créneau déjà occupé — rien n'a été bloqué", {
        conflicts: conflicts.map((b) => ({ reference: b.reference, unitName: b.unitName, checkin: b.checkin, checkout: b.checkout })),
        blocks: others.map((k) => ({ reason: k.reason, unitName: k.unitName, checkin: k.checkin, checkout: k.checkout })),
      });
    }
    await audit(db, "admin", "block.create", `block:${created.id}`, {
      par: currentUser(req), unit: unit.name, checkin, checkout, reason,
    });
    triggerBeds24Push(db, env, execCtx, unit.propertyId);
    return json({ block: await getManualBlock(db, created.id) }, 201);
  }));

  router.delete("/api/admin/blocks/:id", guard(async (req, env, p, _url, execCtx) => {
    const db = env.DB;
    const id = intParam(p.id, 0);
    const block = await getManualBlock(db, id);
    if (!block) return apiError(404, "blocage inconnu");
    const released = await releaseManualBlock(db, id, currentUser(req));
    if (!released) return apiError(409, "blocage déjà levé");
    await audit(db, "admin", "block.release", `block:${id}`, {
      par: currentUser(req), unit: block.unitName, checkin: block.checkin, checkout: block.checkout,
    });
    if (block.propertyId != null) triggerBeds24Push(db, env, execCtx, block.propertyId);
    return json({ ok: true });
  }));

  // --- réservations -----------------------------------------------------------
  // La liste de travail répond d'abord à « qui arrive bientôt ? » : tri par
  // date d'arrivée par défaut, et filtre de période à venir / en cours /
  // passées (issue #51). `sort=created` restitue l'ordre historique.
  router.get("/api/admin/bookings", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const rawPeriod = url.searchParams.get("period") ?? "";
    const period = (["upcoming", "current", "past"] as const).find((p) => p === rawPeriod);
    if (rawPeriod && !period) return apiError(400, "period invalide — attendu upcoming, current ou past");
    const today = todayInZone();
    const bookings = await listBookings(env.DB, {
      propertyId,
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit: intParam(url.searchParams.get("limit"), 200),
      period,
      today,
      sort: url.searchParams.get("sort") === "created" ? "created" : "checkin",
    });
    return json({ bookings, today, period: period ?? null });
  }));

  router.get("/api/admin/bookings/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    // `history` : le journal d'audit de CETTE réservation. Sans lui, une
    // relance de solde n'était visible nulle part sur la fiche — ni sa date,
    // ni son auteur (issue #69).
    const [payments, emails, history] = await Promise.all([
      listPayments(env.DB, { bookingId: id }),
      listEmailLog(env.DB, id),
      listAuditByEntity(env.DB, `booking:${id}`),
    ]);
    let quote: unknown = null;
    try {
      quote = booking.quoteJson ? JSON.parse(booking.quoteJson) : null;
    } catch {
      quote = null;
    }
    return json({ booking, payments, emails, history, quote });
  }));

  // --- registre des personnes hébergées (issue #84) -----------------------------
  //
  // Journal append-only, saisi À L'ARRIVÉE depuis la fiche réservation. Rien
  // n'est collecté au moment de la réservation en ligne : le tunnel public ne
  // connaît pas ces routes, et aucune sortie du système (e-mail, canal OTA,
  // export iCal, statistiques, voucher) ne lit cette table.

  router.get("/api/admin/bookings/:id/guest-register", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const guest = booking.guestId != null ? await getGuest(env.DB, booking.guestId) : null;
    return json({
      entries: await listGuestRegister(env.DB, id),
      idTypes: GUEST_ID_TYPES.map((value) => ({ value, label: GUEST_ID_TYPE_FR[value] })),
      // Pré-remplissage du premier occupant : le réservant, dont on a déjà le
      // nom. Les champs d'état civil restent vides — ils se lisent sur la
      // pièce d'identité présentée à l'arrivée, ils ne se devinent pas.
      prefill: {
        firstName: guest?.firstName ?? "",
        lastName: guest?.lastName ?? "",
        nationality: guest?.country ?? "",
        arrivalDate: booking.checkin,
        departureDate: booking.checkout,
        occupants: booking.adults + booking.children,
      },
      retentionYears: GUEST_REGISTER_RETENTION_YEARS,
    });
  }));

  router.post("/api/admin/bookings/:id/guest-register", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    // Une réservation annulée n'a hébergé personne : le masquage du bouton
    // côté back-office ne suffit pas, la route le refuse aussi.
    if (booking.status === "cancelled") return apiError(409, "réservation annulée — aucun occupant à enregistrer");
    const body = await readJson<{ entries?: unknown }>(req);
    const raw = Array.isArray(body?.entries) ? body.entries : null;
    if (!raw || raw.length === 0) return apiError(400, "aucun occupant à enregistrer");
    if (raw.length > MAX_GUEST_ENTRIES_PER_REQUEST) {
      return apiError(400, `trop d'occupants en une fois (max ${MAX_GUEST_ENTRIES_PER_REQUEST})`);
    }

    // Tout est validé AVANT la première écriture : une saisie de 4 occupants
    // dont le 3e est fautif ne doit pas laisser 2 lignes orphelines en base.
    const today = todayInZone();
    const parsed: GuestRegisterEntry[] = [];
    for (let i = 0; i < raw.length; i++) {
      const res = parseGuestEntry(raw[i], today);
      if (!res.ok) return apiError(400, `occupant ${i + 1} : ${res.message}`);
      // Les dates déclarées restent DANS le séjour. Sans cette borne, une
      // faute de frappe sur l'année de départ sortait la réservation entière
      // du délai de conservation au passage suivant de la purge — ou l'y
      // enfermait pour un siècle (contre-review du 2026-08-28).
      if (res.entry.arrivalDate < booking.checkin || res.entry.departureDate > booking.checkout) {
        return apiError(400, `occupant ${i + 1} : dates hors du séjour (${booking.checkin} → ${booking.checkout})`);
      }
      parsed.push(res.entry);
    }

    // Une correction se fait ligne par ligne. C'est le SEUL cas où une
    // insertion peut être refusée (ligne déjà remplacée), donc le seul où un
    // lot pourrait s'arrêter en cours de route et laisser des lignes déjà
    // écrites derrière lui — l'append-only n'ayant pas de retour en arrière.
    // Un lot de plusieurs occupants ne porte donc jamais de correction, et ne
    // peut pas échouer à mi-parcours.
    if (parsed.length > 1 && parsed.some((e) => e.supersedesId != null)) {
      return apiError(400, "une correction s'enregistre seule, pas dans un lot d'occupants");
    }

    const by = currentUser(req);
    const ids: number[] = [];
    for (const entry of parsed) {
      const res = await insertGuestEntry(env.DB, { bookingId: id, entry, recordedBy: by });
      if (!res.ok) {
        // La ligne visée n'existe pas, appartient à une autre réservation, ou
        // a déjà été corrigée. Le lot ne portant qu'une correction à la fois
        // (garde ci-dessus), rien n'a encore été écrit ici.
        return apiError(409, "cette ligne a déjà été corrigée ou n'appartient pas à cette réservation");
      }
      ids.push(res.id);
    }

    // Journal d'audit : le NOMBRE d'occupants et rien d'autre. Aucune donnée
    // nominative ne doit transiter par `audit_log`, qui est relu et exporté
    // dans des contextes qui n'ont pas à connaître le registre.
    await audit(env.DB, "admin", "guest_register.record", `booking:${id}`, {
      occupants: ids.length,
      corrections: parsed.filter((e) => e.supersedesId != null).length,
      par: by,
    });
    return json({ entries: await listGuestRegister(env.DB, id) }, 201);
  }));

  // Export CSV par période — la sortie unique de ces données, sur demande
  // d'une autorité. Retient les séjours qui CROISENT [from, to], bornes
  // incluses ; `property` restreint au domaine demandé.
  router.get("/api/admin/guest-register.csv", guard(async (req, env, _p, url) => {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!isIsoDate(from) || !isIsoDate(to)) return apiError(400, "période requise (from et to, format AAAA-MM-JJ)");
    if (from > to) return apiError(400, "la date de fin doit suivre la date de début");
    if (diffDays(from, to) > MAX_REGISTER_EXPORT_DAYS) {
      return apiError(400, `période trop longue (max ${MAX_REGISTER_EXPORT_DAYS} jours)`);
    }
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const entries = await listGuestRegisterBetween(env.DB, from, to, propertyId);
    const rows: unknown[][] = [
      [
        "Réservation", "Hébergement", "Nom", "Prénom", "Date de naissance", "Nationalité",
        "Type de pièce", "Numéro de pièce", "Arrivée", "Départ", "Saisi par", "Saisi le", "État",
      ],
      ...entries.map((e) => [
        e.bookingReference ?? "", e.unitName ?? "", e.lastName, e.firstName, e.birthDate, e.nationality,
        GUEST_ID_TYPE_FR[e.idType] ?? e.idType, e.idNumber, e.arrivalDate, e.departureDate,
        e.recordedBy, e.recordedAt,
        e.supersededById != null
          ? `remplacée par la ligne ${e.supersededById}`
          : e.supersedesId != null
            ? `en vigueur (remplace la ligne ${e.supersedesId})`
            : "en vigueur",
      ]),
    ];
    // L'export lui aussi se trace sans donnée nominative : qui a exporté quelle
    // période, et combien de lignes en sont sorties.
    await audit(env.DB, "admin", "guest_register.export", undefined, {
      from, to, property: propertyId ?? "tous", lignes: entries.length, par: currentUser(req),
    });
    return csvResponse(rows, `registre-${from}_${to}.csv`);
  }));

  // Vente manuelle (résa téléphone) : devis serveur + création directe.
  router.post("/api/admin/bookings", guard(async (req, env, _p, _url, execCtx) => {
    const db = env.DB;
    const body = await readJson<
      QuoteBody & {
        guest?: { firstName?: string; lastName?: string; email?: string; phone?: string; address?: string; country?: string; lang?: string };
        internalNotes?: string;
        confirmNow?: boolean;          // ignoré depuis le 11/10/2026 : une vente du back-office crée toujours une option
        generatePaymentLink?: boolean; // true = créer un lien Stripe à transmettre
        paymentMode?: "deposit" | "full";
        holdMinutes?: number;          // si non confirmée : durée de l'option (défaut 72 h)
      }
    >(req);
    if (!body) return apiError(400, "corps JSON attendu");
    if (!isIsoDate(String(body.checkin)) || !isIsoDate(String(body.checkout)) || String(body.checkin) >= String(body.checkout)) {
      return apiError(400, "dates invalides");
    }
    const adults = Math.max(1, Math.floor(Number(body.adults ?? 1)));
    const children = Math.max(0, Math.floor(Number(body.children ?? 0)));
    const lastName = String(body.guest?.lastName ?? "").trim();
    if (lastName.length < 2) return apiError(400, "nom du client requis");

    const ctx = await getQuoteContext(db, Number(body.unitId));
    if (!ctx) return apiError(404, "hébergement inconnu");

    const today = todayInZone();
    const quote = quoteFromContext(ctx, { ...body, adults, children }, today);
    // En vente manuelle, min_nights et jour d'arrivée restent bloquants ;
    // seul un devis calculable passe.
    if (!quote.ok) return apiError(409, "devis impossible", { details: quote.errors, minNights: quote.minNights });

    const email = String(body.guest?.email ?? "").trim();
    const guestId = await upsertGuest(db, {
      email: email || null,
      firstName: String(body.guest?.firstName ?? "").trim() || null,
      lastName,
      phone: String(body.guest?.phone ?? "").trim() || null,
      address: String(body.guest?.address ?? "").trim() || null,
      country: String(body.guest?.country ?? "").trim() || null,
      lang: body.guest?.lang === "nl" ? "nl" : undefined,
    });

    const full = body.paymentMode === "full" || quote.balanceDueDate === null;
    const amountDue = full ? quote.totalCents : quote.depositCents;
    // Décision de Julien (11/10/2026) : pas de vente « confirmée » au back-office.
    // La vente crée une OPTION ; le client reçoit un lien vers la page de sa
    // réservation, y accepte les CGV, paie les arrhes, puis reçoit la
    // confirmation et son PDF (handlePaymentSuccess). `confirmNow` est ignoré.

    const created = await createBookingAtomic(db, {
      unitId: ctx.unit.id,
      checkin: String(body.checkin),
      checkout: String(body.checkout),
      adults,
      children,
      status: "pending",
      holdMinutes: intParam(String(body.holdMinutes ?? ""), 72 * 60),
      source: "manual",
      guestId,
      totalCents: quote.totalCents,
      depositCents: amountDue,
      balanceDueDate: full ? null : quote.balanceDueDate,
      quoteJson: JSON.stringify(quote),
      optionsJson: JSON.stringify(quote.lines.filter((l) => l.kind === "option")),
      promoCode: quote.promoApplied,
      internalNotes: String(body.internalNotes ?? "").trim() || null,
    });
    if (!created.ok) return apiError(409, "créneau indisponible (conflit avec une autre réservation)");
    await audit(db, "admin", "booking.create_manual", `booking:${created.id}`, { reference: created.reference });
    triggerBeds24Push(db, env, execCtx, ctx.unit.propertyId);

    let paymentUrl: string | null = null;
    if (body.generatePaymentLink && amountDue >= 50) {
      const booking = (await getBooking(db, created.id)) as BookingRow;
      const res = await startCheckout(db, env, booking, full ? "full" : "deposit", amountDue, "admin");
      paymentUrl = res.url;
    }
    // L'option part vers le client : mail `payment_link` (le gabarit existant) dont
    // le lien est la page de SA réservation (voucher), où il accepte les CGV et
    // paie les arrhes. Une erreur d'envoi ne défait pas la vente : le lien reste
    // dans la réponse, à transmettre à la main.
    let optionUrl: string | null = null;
    let optionMailQueued = false;
    const booking = await getBooking(db, created.id);
    if (booking) {
      optionUrl = voucherUrl(env, booking);
      if (email) {
        try {
          const property = booking.propertyId != null ? await getProperty(db, booking.propertyId) : null;
          if (property) {
            const mail = buildPaymentLinkEmail(booking, property, full ? "Paiement intégral" : "Arrhes", amountDue, optionUrl, { holdUntil: booking.holdExpiresAt });
            await queueEmail(db, env, { bookingId: booking.id, to: email, subject: mail.subject, bodyText: mail.bodyText, kind: "payment_link" });
            optionMailQueued = true;
          }
        } catch (e) {
          await audit(db, "admin", "option_mail.error", `booking:${created.id}`, { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return json({ booking, paymentUrl, optionUrl, optionMailQueued }, 201);
  }));

  // Annulation (CGV v3.1 art. 4-5, décisions du 12/10/2026) : voir services/annulation.ts.
  // `par` : « locataire » (le client) ou « proprietaire » (l'exploitant), noms d'API inchangés.
  // `simuler: true` rend le plan sans rien faire ; un plan qui rembourse par
  // Stripe exige `confirmer: true`.
  router.post("/api/admin/bookings/:id/cancel", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ reason?: string; par?: string; simuler?: boolean; confirmer?: boolean; forceMajeure?: boolean; sejourEntame?: boolean }>(req);
    // « client » et « exploitant » sont acceptés comme synonymes.
    const parBrut = body?.par ?? "locataire";
    const par = parBrut === "client" ? "locataire" : parBrut === "exploitant" ? "proprietaire" : parBrut;
    if (par !== "locataire" && par !== "proprietaire") return apiError(400, "par : « locataire » (le client) ou « proprietaire » (l'exploitant)");
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    if (booking.status === "cancelled") return apiError(409, "déjà annulée");
    const cfg = await stripeConfigForBooking(env.DB, env, booking);
    const plan = await planCancellation(env.DB, cfg, booking, par, { forceMajeure: body?.forceMajeure === true, sejourEntame: body?.sejourEntame === true });
    if (body?.simuler === true) return json({ ok: true, simule: true, plan });
    if (plan.stripeRefundCents > 0 && body?.confirmer !== true) {
      return json({ error: "Cette annulation rembourse de l'argent par Stripe : confirmer: true est requis (simuler: true pour voir le plan).", plan }, 400);
    }
    // Argent en jeu (arrhes gardées, remboursement, indemnité) : jamais par une clé de service
    // (script, agent) — une session humaine seulement.
    if (plan.mode === "arrhes" && !isHuman(req)) return apiError(403, "annuler une réservation payée se fait depuis une session humaine (pas par une clé de service)");
    // Les lignes de remboursement existent AVANT l'annulation : une panne entre les deux les laisse reprenables.
    const prepared = await prepareRefunds(env.DB, booking, plan.stripeRefunds);
    const done = await cancelBooking(env.DB, id, String(body?.reason ?? "annulation admin"));
    if (!done) {
      await dropPreparedRefunds(env.DB, booking, prepared.map((x) => x.rowId));
      return apiError(409, "déjà annulée");
    }
    await audit(env.DB, "admin", "booking.cancel", `booking:${id}`, { reason: body?.reason, par: currentUser(req), annulePar: par, plan });
    if (booking.propertyId != null) triggerBeds24Push(env.DB, env, execCtx, booking.propertyId);

    // Un remboursement échoué ne défait pas l'annulation : il est signalé et rejouable.
    const refunds = prepared.length > 0 ? await executeRefunds(env.DB, cfg, booking, prepared) : [];
    const failed = refunds.filter((r) => r.status === "failed");
    if (failed.length > 0) await audit(env.DB, "admin", "refund.failed", `booking:${id}`, { failed });
    if (refunds.length > 0) await audit(env.DB, "admin", "refund.done", `booking:${id}`, { refunds });
    if (plan.indemnityCents > 0 || plan.manualRefundCents > 0) {
      await audit(env.DB, "admin", "refund.manual_due", `booking:${id}`, { indemnityCents: plan.indemnityCents, manualRefundCents: plan.manualRefundCents });
    }

    // Mail au client : une fois, à l'annulation, et seulement si de l'argent ou
    // une réservation confirmée est en jeu (une option non payée n'en reçoit pas).
    let mail: "stub" | "sent" | "failed" | "non" = "non";
    try {
      const concerned = plan.mode === "arrhes" || booking.status === "confirmed";
      if (plan.mode !== "canal" && concerned && booking.guestEmail && booking.propertyId != null && !(await hasEmailOfKinds(env.DB, id, ["cancellation"]))) {
        const property = await getProperty(env.DB, booking.propertyId);
        if (property) {
          const email = buildCancellationEmail(booking, property, plan);
          mail = await queueEmail(env.DB, env, { bookingId: id, to: booking.guestEmail, subject: email.subject, bodyText: email.bodyText, kind: "cancellation" });
        }
      }
    } catch (e) {
      mail = "failed";
      await audit(env.DB, "admin", "cancellation_mail.error", `booking:${id}`, { error: e instanceof Error ? e.message : String(e) });
    }
    return json({ ok: true, plan, refunds, mail, note: plan.note });
  }));

  // Rejeu d'un remboursement Stripe échoué (ligne payments kind=refund, status=failed).
  router.post("/api/admin/bookings/:id/refunds/:refundId/retry", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "un remboursement se rejoue depuis une session humaine (pas par une clé de service)");
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const cfg = await stripeConfigForBooking(env.DB, env, booking);
    try {
      const outcome = await replayRefund(env.DB, cfg, booking, intParam(p.refundId, 0));
      return json({ ok: outcome.status !== "failed", refund: outcome });
    } catch (e) {
      return apiError(409, e instanceof Error ? e.message : String(e));
    }
  }));

  router.post("/api/admin/bookings/:id/confirm", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ sendVoucher?: boolean; sendConfirmation?: boolean }>(req);
    const outcome = await confirmBookingAtomic(env.DB, id);
    if (outcome === "conflict") {
      await audit(env.DB, "admin", "booking.confirm_conflict", `booking:${id}`);
      return apiError(409, "le créneau a été repris entre-temps — cette réservation ne peut plus être confirmée");
    }
    if (outcome !== "confirmed") return apiError(409, "cette réservation n'est pas en attente");
    await audit(env.DB, "admin", "booking.confirm_manual", `booking:${id}`);
    // `sendVoucher` : ancien nom du drapeau, gardé pour les scripts existants.
    let voucherQueued = false;
    if (body?.sendVoucher || body?.sendConfirmation) voucherQueued = await sendConfirmation(env.DB, env, id);
    return json({ ok: true, voucherQueued, confirmationQueued: voucherQueued });
  }));

  router.post("/api/admin/bookings/:id/payments", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const body = await readJson<{ kind?: string; method?: string; amountCents?: number; note?: string }>(req);
    const amount = Math.round(Number(body?.amountCents));
    if (!Number.isFinite(amount) || amount === 0) return apiError(400, "montant invalide");
    const kind = ["deposit", "balance", "full", "refund", "manual"].includes(String(body?.kind)) ? String(body?.kind) : "manual";
    const method = ["stripe", "transfer", "cash", "other"].includes(String(body?.method)) ? String(body?.method) : "transfer";
    await addPayment(env.DB, {
      bookingId: id,
      kind: kind as "manual",
      method: method as "transfer",
      amountCents: amount,
      status: "succeeded",
      note: String(body?.note ?? "").trim() || null,
      receivedAt: sqlNow(),
    });
    await audit(env.DB, "admin", "payment.manual", `booking:${id}`, { amount, method, kind });
    return json({ booking: await getBooking(env.DB, id) });
  }));

  router.post("/api/admin/bookings/:id/payment-link", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    if (booking.status === "cancelled") return apiError(400, "réservation annulée");
    const body = await readJson<{ amountCents?: number; kind?: string }>(req);
    const balance = Math.max(0, booking.totalCents - booking.paidCents);
    const amount = body?.amountCents != null ? Math.round(Number(body.amountCents)) : balance;
    if (!Number.isFinite(amount) || amount < 50) return apiError(400, "montant invalide (min 0,50 €)");
    const kind = body?.kind === "deposit" || body?.kind === "full" ? body.kind : "balance";
    const { url } = await startCheckout(env.DB, env, booking, kind, amount, "admin");
    return json({ url, amountCents: amount });
  }));

  /** « Relancer le solde » (issue #69) : un clic, un email journalisé, une
   *  ligne d'historique — au lieu de fabriquer un lien à la main et de
   *  l'envoyer depuis sa propre boîte.
   *
   *  L'email porte l'URL du VOUCHER, pas une session de paiement : une session
   *  Stripe expire (30 min), un rappel se lit parfois le surlendemain. Le
   *  voucher ouvre une session fraîche au clic (issue #67) — et on n'ouvre donc
   *  pas une session « en attente » de plus à chaque relance, ce qui reviendrait
   *  à nourrir le problème que la même issue demande de nettoyer.
   *
   *  `kind = 'balance_reminder'`, comme le rappel automatique du cron : une
   *  relance manuelle vaut rappel, et dispense donc le cron du sien. */
  router.post("/api/admin/bookings/:id/balance-reminder", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    if (booking.status !== "confirmed") return apiError(400, "réservation non confirmée — pas de solde à relancer");
    if (!booking.guestEmail) return apiError(400, "pas d'email client sur cette réservation");
    const balance = booking.totalCents - booking.paidCents;
    if (balance <= 0) return apiError(400, "cette réservation est intégralement réglée");
    const property = booking.propertyId != null ? await getProperty(env.DB, booking.propertyId) : null;
    if (!property) return apiError(404, "domaine inconnu");

    const payUrl = voucherUrl(env, booking);
    const email = buildBalanceReminderEmail(booking, property, payUrl);
    await queueEmail(env.DB, env, {
      bookingId: id,
      to: booking.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      kind: "balance_reminder",
    });
    await audit(env.DB, "admin", "email.balance_reminder", `booking:${id}`, {
      par: currentUser(req),
      balanceCents: balance,
      to: booking.guestEmail,
    });
    return json({ ok: true, balanceCents: balance, payUrl });
  }));

  /** Renvoie la confirmation (mail soigné + PDF de confirmation et CGV en pièce jointe). L'URL
   *  `resend-voucher` est l'ancien nom, gardé pour les scripts et le back-office
   *  d'avant. */
  const resendConfirmation = guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const queued = await sendConfirmation(env.DB, env, id, { force: true });
    if (!queued) return apiError(400, "pas d'email client sur cette réservation");
    await audit(env.DB, "admin", "email.confirmation_resent", `booking:${id}`, { par: currentUser(req) });
    return json({ ok: true });
  });
  router.post("/api/admin/bookings/:id/resend-confirmation", resendConfirmation);
  router.post("/api/admin/bookings/:id/resend-voucher", resendConfirmation);

  /** « Confirmation de réservation et conditions générales » en PDF (toute
   *  réservation, y compris pour la relire avant envoi). `contrat.pdf` est
   *  l'ancien nom, gardé en alias : même réponse. */
  const confirmationPdf = guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const ctx = await loadConfirmationPdfContext(env.DB, id);
    if (!ctx) return apiError(404, "réservation inconnue");
    return new Response(buildConfirmationPdf(ctx), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${confirmationFileName(ctx.booking.reference)}"`,
        "cache-control": "private, no-store",
      },
    });
  });
  router.get("/api/admin/bookings/:id/confirmation.pdf", confirmationPdf);
  router.get("/api/admin/bookings/:id/contrat.pdf", confirmationPdf);

  /** Modifier une réservation SANS annuler-recréer (issue #73).
   *
   *  Trois choses peuvent bouger, indépendamment : le séjour (dates et/ou
   *  logement), les coordonnées du client, les notes internes.
   *
   *  Le séjour passe par `updateBookingStayAtomic` : le créneau d'origine est
   *  libéré et le nouveau pris par la MÊME instruction, sous le même garde-fou
   *  que la création. Annuler puis recréer aurait rouvert l'ancien créneau le
   *  temps de la bascule — et surtout perdu les paiements reçus et la preuve
   *  d'acceptation des CGV, ce qui est précisément le geste que cette issue
   *  supprime.
   *
   *  Le devis est recalculé sur les nouvelles dates. Le déjà-payé est
   *  conservé : l'écart devient un solde à payer, ou un avoir à rembourser —
   *  remboursement MANUEL, jamais déclenché par cette route (le back-office
   *  l'affiche, un humain le traite dans Stripe).
   */
  router.patch("/api/admin/bookings/:id", guard(async (req, env, p, _url, execCtx) => {
    const db = env.DB;
    const id = intParam(p.id, 0);
    const body = await readJson<{
      internalNotes?: string;
      guest?: { firstName?: string; lastName?: string; email?: string; phone?: string; address?: string; country?: string; lang?: string };
      unitId?: number;
      checkin?: string;
      checkout?: string;
      adults?: number;
      children?: number;
      options?: { id: number; qty: number }[];
      promoCode?: string | null;
      paymentMode?: "deposit" | "full";
    }>(req);
    if (!body) return apiError(400, "corps JSON attendu");

    const before = await getBooking(db, id);
    if (!before) return apiError(404, "réservation inconnue");

    const wantsStay = body.checkin != null || body.checkout != null || body.unitId != null
      || body.adults != null || body.children != null || body.options != null || body.promoCode !== undefined;
    const wantsGuest = body.guest != null;
    const wantsNotes = typeof body.internalNotes === "string";
    if (!wantsStay && !wantsGuest && !wantsNotes) return apiError(400, "rien à modifier");

    // --- séjour ---------------------------------------------------------------
    let quotePayload: unknown = null;
    if (wantsStay) {
      if (before.status === "cancelled") return apiError(409, "réservation annulée — elle ne se modifie plus");
      const checkin = String(body.checkin ?? before.checkin);
      const checkout = String(body.checkout ?? before.checkout);
      if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) return apiError(400, "dates invalides");
      const adults = intOr(body.adults ?? before.adults, before.adults, 1);
      const children = intOr(body.children ?? before.children, before.children, 0);
      const unitId = intOr(body.unitId ?? before.unitId, before.unitId, 1);

      const ctx = await getQuoteContext(db, unitId);
      if (!ctx) return apiError(404, "hébergement inconnu");
      if (adults + children > ctx.unit.capacityMax) {
        return apiError(409, `capacité dépassée : ${ctx.unit.name} accueille ${ctx.unit.capacityMax} personnes`);
      }

      // Options non renvoyées ⇒ on reconduit celles de la réservation, jamais
      // « aucune » : un recalcul ne doit pas faire disparaître ce qui est vendu.
      let options = body.options;
      if (options === undefined) {
        const carried = optionsFromQuote(before.optionsJson, ctx.options);
        if (!carried.ok) {
          return apiError(409, "options de cette réservation non reconnues — précise-les pour recalculer le devis", {
            details: carried.unmatched,
          });
        }
        options = carried.options;
      }

      const quote = quoteFromContext(
        ctx,
        {
          unitId,
          checkin,
          checkout,
          adults,
          children,
          options,
          promoCode: body.promoCode !== undefined ? body.promoCode : before.promoCode,
        },
        todayInZone(),
      );
      if (!quote.ok) return apiError(409, "devis impossible sur ces dates", { details: quote.errors, minNights: quote.minNights });

      const full = body.paymentMode === "full" || quote.balanceDueDate === null;
      const outcome = await updateBookingStayAtomic(db, id, {
        unitId,
        checkin,
        checkout,
        adults,
        children,
        totalCents: quote.totalCents,
        // « Attendu à la réservation », recalculé comme à la création. Le
        // déjà-encaissé vit dans `payments` / `paid_cents` et n'y touche pas.
        depositCents: Math.min(full ? quote.totalCents : quote.depositCents, quote.totalCents),
        balanceDueDate: full ? null : quote.balanceDueDate,
        quoteJson: JSON.stringify(quote),
        optionsJson: JSON.stringify(quote.lines.filter((l) => l.kind === "option")),
        promoCode: quote.promoApplied,
      });
      if (outcome === "conflict") {
        // Le refus se nomme, et la réservation d'origine n'a pas bougé.
        const conflicts = await checkAvailability(db, unitId, ctx.unit.propertyId, checkin, checkout, new Date(), id);
        await audit(db, "admin", "booking.modify_conflict", `booking:${id}`, {
          par: currentUser(req), vers: { unitId, checkin, checkout },
        });
        return apiError(409, "créneau indisponible — la réservation n'a pas été modifiée", { conflicts: conflicts.conflicts });
      }
      if (outcome !== "updated") return apiError(409, "réservation non modifiable");

      // Avant / après dans le journal : c'est ce qu'on relit six mois plus tard.
      await audit(db, "admin", "booking.modify", `booking:${id}`, {
        par: currentUser(req),
        avant: {
          unitId: before.unitId, unitName: before.unitName, checkin: before.checkin, checkout: before.checkout,
          adults: before.adults, children: before.children, totalCents: before.totalCents,
        },
        apres: {
          unitId, unitName: ctx.unit.name, checkin, checkout,
          adults, children, totalCents: quote.totalCents,
        },
      });
      quotePayload = quote;
      triggerBeds24Push(db, env, execCtx, ctx.unit.propertyId);
      if (before.propertyId != null && before.propertyId !== ctx.unit.propertyId) {
        triggerBeds24Push(db, env, execCtx, before.propertyId);
      }
    }

    // --- coordonnées du client -------------------------------------------------
    if (wantsGuest && before.guestId) {
      const g = body.guest ?? {};
      const clean = (v: unknown): string | null => {
        const t = String(v ?? "").trim();
        return t === "" ? null : t;
      };
      await updateGuest(db, before.guestId, {
        firstName: clean(g.firstName),
        lastName: clean(g.lastName) ?? undefined,
        email: clean(g.email),
        phone: clean(g.phone),
        address: clean(g.address),
        country: clean(g.country),
      });
      // L'« après » se relit en base : `updateGuest` ne remplace que les champs
      // fournis (COALESCE), recomposer le payload afficherait des trous.
      const refreshed = await getBooking(db, id);
      await audit(db, "admin", "booking.modify_guest", `booking:${id}`, {
        par: currentUser(req),
        avant: { nom: before.guestName, email: before.guestEmail },
        apres: { nom: refreshed?.guestName ?? null, email: refreshed?.guestEmail ?? null },
      });
    }

    if (wantsNotes) await updateBookingNotes(db, id, String(body.internalNotes));

    const after = await getBooking(db, id);
    const delta = (after?.totalCents ?? 0) - (after?.paidCents ?? 0);
    return json({
      ok: true,
      booking: after,
      quote: quotePayload,
      // Positif = solde à encaisser ; négatif = avoir à rembourser à la main.
      balanceCents: Math.max(0, delta),
      refundCents: Math.max(0, -delta),
    });
  }));

  // Devis côté admin (vente manuelle)
  router.post("/api/admin/quote", guard(async (req, env) => {
    const body = await readJson<QuoteBody & { bookingId?: number }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    if (!isIsoDate(String(body.checkin)) || !isIsoDate(String(body.checkout)) || String(body.checkin) >= String(body.checkout)) {
      return apiError(400, "dates invalides");
    }
    const ctx = await getQuoteContext(env.DB, Number(body.unitId));
    if (!ctx) return apiError(404, "hébergement inconnu");
    const quote = quoteFromContext(
      ctx,
      { ...body, adults: Math.max(1, Number(body.adults ?? 1)), children: Math.max(0, Number(body.children ?? 0)) },
      todayInZone(),
    );
    // Le devis dit combien ; il doit aussi dire SI c'est vendable (issue #70).
    // Sans ce champ, la vente téléphone calculait un prix sur un créneau déjà
    // pris et ne l'apprenait qu'au 409 de la création, le client au téléphone.
    // Même règle de liaison que le site public — l'INSERT atomique reste la
    // vérité transactionnelle, ceci n'est que l'annonce anticipée.
    const availability = await checkAvailability(
      env.DB,
      ctx.unit.id,
      ctx.unit.propertyId,
      String(body.checkin),
      String(body.checkout),
      new Date(),
      // Devis de MODIFICATION : la réservation qu'on déplace ne se bloque pas
      // elle-même (issue #73).
      body.bookingId ? Math.floor(Number(body.bookingId)) : undefined,
    );
    return json({ unit: { id: ctx.unit.id, name: ctx.unit.name }, quote, availability });
  }));

  // --- saisons ----------------------------------------------------------------
  router.get("/api/admin/seasons", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ seasons: await listSeasons(env.DB, propertyId) });
  }));

  router.post("/api/admin/seasons", guard(async (req, env, _p, url, execCtx) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ name?: string; dateStart?: string; dateEnd?: string; priority?: number }>(req);
    const name = String(body?.name ?? "").trim();
    const dateStart = String(body?.dateStart ?? "");
    const dateEnd = String(body?.dateEnd ?? "");
    if (!name || !isIsoDate(dateStart) || !isIsoDate(dateEnd) || dateStart > dateEnd) {
      return apiError(400, "nom et dates (début ≤ fin) requis");
    }
    const id = await createSeason(env.DB, propertyId, { name, dateStart, dateEnd, priority: Math.floor(Number(body?.priority ?? 0)) });
    await audit(env.DB, "admin", "season.create", `season:${id}`, { ...body, par: currentUser(req) });
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ id }, 201);
  }));

  router.patch("/api/admin/seasons/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ name?: string; dateStart?: string; dateEnd?: string; priority?: number }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (body.dateStart !== undefined && !isIsoDate(String(body.dateStart))) return apiError(400, "dateStart invalide");
    if (body.dateEnd !== undefined && !isIsoDate(String(body.dateEnd))) return apiError(400, "dateEnd invalide");
    await updateSeason(env.DB, id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      dateStart: body.dateStart !== undefined ? String(body.dateStart) : undefined,
      dateEnd: body.dateEnd !== undefined ? String(body.dateEnd) : undefined,
      priority: body.priority !== undefined ? Math.floor(Number(body.priority)) : undefined,
    });
    await audit(env.DB, "admin", "season.update", `season:${id}`, { ...body, par: currentUser(req) });
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  router.delete("/api/admin/seasons/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    await deleteSeason(env.DB, id);
    await audit(env.DB, "admin", "season.delete", `season:${id}`, { par: currentUser(req) });
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  // --- règles tarifaires --------------------------------------------------------
  router.get("/api/admin/rate-rules", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ rules: await listRateRules(env.DB, propertyId) });
  }));

  router.post("/api/admin/rate-rules", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<Partial<RateRuleInput>>(req);
    if (!body || !body.unitId) return apiError(400, "unitId requis");
    // Garde-fou : prix strictement positif ET dans les bornes de l'hébergement
    // (issue #50 / #31). Même règle qu'au PATCH, appliquée au même endroit.
    const bounds = await boundsForUnit(env.DB, Number(body.unitId));
    const week = checkPrice(body.priceWeekCents, bounds, "prix semaine");
    if (!week.ok) return apiError(400, week.message);
    const weekend = checkPrice(body.priceWeekendCents ?? week.cents, bounds, "prix weekend");
    if (!weekend.ok) return apiError(400, weekend.message);
    try {
      const id = await createRateRule(env.DB, {
        unitId: Number(body.unitId),
        seasonId: body.seasonId != null ? Number(body.seasonId) : null,
        priceWeekCents: week.cents,
        priceWeekendCents: weekend.cents,
        holidayPct: Math.floor(Number(body.holidayPct ?? 0)),
        minNights: Math.max(1, Math.floor(Number(body.minNights ?? 1))),
        checkinDays: Array.isArray(body.checkinDays) ? body.checkinDays.map(Number).filter((d) => d >= 0 && d <= 6) : null,
      });
      await audit(env.DB, "admin", "rate.create", `rate:${id}`, { ...body, par: currentUser(req) });
      await triggerBeds24PushAll(env.DB, env, execCtx);
      return json({ id }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) return apiError(409, "une règle existe déjà pour cette unité et cette saison");
      throw e;
    }
  }));

  router.patch("/api/admin/rate-rules/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<RateRuleInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");

    // ISSUE #50 — ce PATCH n'avait AUCUNE borne basse là où le POST en avait
    // une, et il déclenche le push vers Beds24 juste en dessous. Un champ vidé
    // par mégarde (`toCents("") === 0` côté back-office) publiait donc 0 €/nuit
    // sur Airbnb et Booking. Le trou se ferme ici, avant toute écriture.
    const rule = await getRateRule(env.DB, id);
    if (!rule) return apiError(404, "règle tarifaire inconnue");
    const bounds = await boundsForUnit(env.DB, rule.unitId);
    let priceWeek: number | undefined;
    let priceWeekend: number | undefined;
    if (body.priceWeekCents !== undefined) {
      const c = checkPrice(body.priceWeekCents, bounds, "prix semaine");
      if (!c.ok) return apiError(400, c.message);
      priceWeek = c.cents;
    }
    if (body.priceWeekendCents !== undefined) {
      const c = checkPrice(body.priceWeekendCents, bounds, "prix weekend");
      if (!c.ok) return apiError(400, c.message);
      priceWeekend = c.cents;
    }

    await updateRateRule(env.DB, id, {
      priceWeekCents: priceWeek,
      priceWeekendCents: priceWeekend,
      holidayPct: body.holidayPct != null ? Math.floor(Number(body.holidayPct)) : undefined,
      minNights: body.minNights != null ? Math.max(1, Math.floor(Number(body.minNights))) : undefined,
      checkinDays:
        body.checkinDays === undefined
          ? undefined
          : Array.isArray(body.checkinDays)
            ? body.checkinDays.map(Number).filter((d) => d >= 0 && d <= 6)
            : null,
    });
    await audit(env.DB, "admin", "rate.update", `rate:${id}`, { ...body, par: currentUser(req) });
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  router.delete("/api/admin/rate-rules/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    await deleteRateRule(env.DB, id);
    await audit(env.DB, "admin", "rate.delete", `rate:${id}`, { par: currentUser(req) });
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  // --- promotions -----------------------------------------------------------------
  router.get("/api/admin/promotions", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ promotions: await listPromotions(env.DB, propertyId) });
  }));

  router.post("/api/admin/promotions", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<Partial<PromotionInput>>(req);
    const kind = String(body?.kind ?? "");
    if (!body || !["code", "long_stay", "early_bird", "last_minute"].includes(kind)) return apiError(400, "kind invalide");
    if (kind === "code" && !String(body.code ?? "").trim()) return apiError(400, "code requis");
    if (kind !== "code" && body.threshold == null) return apiError(400, "seuil requis pour une remise automatique");
    if (body.discountPct == null && body.discountCents == null) return apiError(400, "remise % ou montant requis");
    if (badPct(body.discountPct)) return apiError(400, "remise en % hors bornes (0 à 100)");
    const id = await createPromotion(env.DB, propertyId, {
      kind: kind as PromotionInput["kind"],
      code: kind === "code" ? String(body.code).trim() : null,
      label: String(body.label ?? "").trim() || (kind === "code" ? `Code ${String(body.code).trim()}` : kind),
      discountPct: pctOrNull(body.discountPct),
      discountCents: body.discountCents != null ? Math.round(Number(body.discountCents)) : null,
      threshold: body.threshold != null ? Math.floor(Number(body.threshold)) : null,
      validFrom: body.validFrom && isIsoDate(String(body.validFrom)) ? String(body.validFrom) : null,
      validUntil: body.validUntil && isIsoDate(String(body.validUntil)) ? String(body.validUntil) : null,
      maxUses: body.maxUses != null ? Math.floor(Number(body.maxUses)) : null,
      active: body.active !== false,
    });
    await audit(env.DB, "admin", "promotion.create", `promotion:${id}`, { ...body, par: currentUser(req) });
    return json({ id }, 201);
  }));

  router.patch("/api/admin/promotions/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<PromotionInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (badPct(body.discountPct)) return apiError(400, "remise en % hors bornes (0 à 100)");
    await updatePromotion(env.DB, id, {
      code: body.code !== undefined ? String(body.code).trim() : undefined,
      label: body.label !== undefined ? String(body.label).trim() : undefined,
      discountPct: body.discountPct !== undefined ? pctOrNull(body.discountPct) : undefined,
      discountCents: body.discountCents !== undefined ? (body.discountCents == null ? null : Math.round(Number(body.discountCents))) : undefined,
      threshold: body.threshold !== undefined ? (body.threshold == null ? null : Math.floor(Number(body.threshold))) : undefined,
      validFrom: body.validFrom !== undefined ? (body.validFrom && isIsoDate(String(body.validFrom)) ? String(body.validFrom) : null) : undefined,
      validUntil: body.validUntil !== undefined ? (body.validUntil && isIsoDate(String(body.validUntil)) ? String(body.validUntil) : null) : undefined,
      maxUses: body.maxUses !== undefined ? (body.maxUses == null ? null : Math.floor(Number(body.maxUses))) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
    });
    await audit(env.DB, "admin", "promotion.update", `promotion:${id}`, { ...body, par: currentUser(req) });
    return json({ ok: true });
  }));

  router.delete("/api/admin/promotions/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    await deletePromotion(env.DB, id);
    await audit(env.DB, "admin", "promotion.delete", `promotion:${id}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- options ---------------------------------------------------------------------
  router.get("/api/admin/options", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ options: await listOptionsAdmin(env.DB, propertyId) });
  }));

  router.post("/api/admin/options", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<Partial<OptionInput>>(req);
    const name = String(body?.name ?? "").trim();
    const mode = String(body?.pricingMode ?? "per_stay");
    const price = Math.round(Number(body?.priceCents));
    if (!name || !Number.isFinite(price) || price < 0) return apiError(400, "nom et prix requis");
    if (!["per_stay", "per_night", "per_person", "per_person_night", "per_unit_qty"].includes(mode)) {
      return apiError(400, "pricingMode invalide");
    }
    const id = await createOption(env.DB, propertyId, {
      name,
      pricingMode: mode as OptionInput["pricingMode"],
      priceCents: price,
      unitLabel: String(body?.unitLabel ?? "").trim() || null,
      maxQty: body?.maxQty != null ? Math.floor(Number(body.maxQty)) : null,
      active: body?.active !== false,
      sortOrder: Math.floor(Number(body?.sortOrder ?? 0)),
    });
    await audit(env.DB, "admin", "option.create", `option:${id}`, { ...body, par: currentUser(req) });
    return json({ id }, 201);
  }));

  router.patch("/api/admin/options/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<OptionInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateOption(env.DB, id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      pricingMode: body.pricingMode,
      priceCents: body.priceCents != null ? Math.round(Number(body.priceCents)) : undefined,
      unitLabel: body.unitLabel !== undefined ? (String(body.unitLabel).trim() || null) : undefined,
      maxQty: body.maxQty !== undefined ? (body.maxQty == null ? null : Math.floor(Number(body.maxQty))) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      sortOrder: body.sortOrder != null ? Math.floor(Number(body.sortOrder)) : undefined,
    });
    await audit(env.DB, "admin", "option.update", `option:${id}`, { ...body, par: currentUser(req) });
    return json({ ok: true });
  }));

  router.delete("/api/admin/options/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    await deleteOption(env.DB, id);
    await audit(env.DB, "admin", "option.delete", `option:${id}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- clients ---------------------------------------------------------------------
  router.get("/api/admin/guests", guard(async (_req, env, _p, url) => {
    return json({ guests: await listGuests(env.DB, url.searchParams.get("search") ?? undefined) });
  }));

  router.get("/api/admin/guests/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const guest = await getGuest(env.DB, id);
    if (!guest) return apiError(404, "client inconnu");
    return json({ guest, bookings: await bookingsForGuest(env.DB, id) });
  }));

  router.patch("/api/admin/guests/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Record<string, unknown>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateGuest(env.DB, id, {
      email: typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined,
      firstName: typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" && body.lastName.trim() ? body.lastName.trim() : undefined,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      address: typeof body.address === "string" ? body.address : undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      lang: typeof body.lang === "string" ? body.lang : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    await audit(env.DB, "admin", "guest.update", `guest:${id}`);
    return json({ ok: true });
  }));

  // --- paiements ---------------------------------------------------------------------
  router.get("/api/admin/payments", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    return json({ payments: await listPayments(env.DB, { propertyId }) });
  }));

  // --- statistiques ---------------------------------------------------------------------
  router.get("/api/admin/stats", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const year = intParam(url.searchParams.get("year"), Number(todayInZone().slice(0, 4)));
    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const [cur, prev] = await Promise.all([
      confirmedYearBookings(db, propertyId, year).then((b) => computeYearStats(year, statsUnits, links, b)),
      confirmedYearBookings(db, propertyId, year - 1).then((b) => computeYearStats(year - 1, statsUnits, links, b)),
    ]);

    // Indicateurs de DÉCISION (issue #36) : à quelle avance les gens réservent,
    // où ils abandonnent, et ce qu'ils cherchent sans le trouver.
    const [stages, direct, searches] = await Promise.all([
      countSearchStages(db, { propertyId, year }),
      countDirectBookings(db, { propertyId, year }),
      listSearchLog(db, { propertyId, year }),
    ]);
    const leadTime = computeLeadTime(year, await leadTimeBookings(db, propertyId, year));

    return json({
      current: cur,
      previous: prev,
      leadTime,
      funnel: computeFunnel({ ...stages, ...direct }),
      searches: summarizeSearches(searches),
    });
  }));

  router.get("/api/admin/stats.csv", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const year = intParam(url.searchParams.get("year"), Number(todayInZone().slice(0, 4)));
    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const stats = computeYearStats(year, statsUnits, links, await confirmedYearBookings(db, propertyId, year));
    const rows: unknown[][] = [
      ["Mois", "Nuits occupées", "Nuits disponibles", "Occupation %", "Revenus (€)"],
      ...stats.months.map((m) => [
        `${year}-${String(m.month).padStart(2, "0")}`,
        m.occupiedNights,
        m.capacityNights,
        m.occupancyPct,
        (m.revenueCents / 100).toFixed(2),
      ]),
      [],
      ["Unité", "Nuits vendues", "Revenus (€)"],
      ...stats.perUnit.map((u) => [u.name, u.nights, (u.revenueCents / 100).toFixed(2)]),
      [],
      ["Année", year, "Occupation %", stats.occupancyPct, "ADR (€)", (stats.adrCents / 100).toFixed(2)],
    ];
    return csvResponse(rows, `stats-${year}.csv`);
  }));

  router.get("/api/admin/bookings.csv", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const bookings = await listBookings(env.DB, { propertyId, limit: 1000 });
    const rows: unknown[][] = [
      ["Référence", "Unité", "Arrivée", "Départ", "Nuits", "Adultes", "Enfants", "Client", "Email", "Statut", "Source", "Total (€)", "Payé (€)", "Créée le"],
      ...bookings.map((b) => [
        b.reference, b.unitName, b.checkin, b.checkout, diffDays(b.checkin, b.checkout),
        b.adults, b.children, b.guestName ?? "", b.guestEmail ?? "", b.status, b.source,
        (b.totalCents / 100).toFixed(2), (b.paidCents / 100).toFixed(2), b.createdAt,
      ]),
    ];
    return csvResponse(rows, "reservations.csv");
  }));

  // --- paramètres ---------------------------------------------------------------------
  const SETTING_KEYS = new Set([
    "deposit_pct", "balance_due_days", "hold_minutes",
    "tourist_tax_cents_per_person_night", "tourist_tax_include_children",
    "caution_cents", "checkin_time", "checkout_time", "cgv_text",
    "allow_deposit", "allow_full_payment",
    "auto_reply_enabled", "auto_reply_text", "email_forward_to",
  ]);

  router.get("/api/admin/settings", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const property = await getProperty(env.DB, propertyId);
    if (!property) return apiError(404, "domaine inconnu");
    return json({
      property,
      settings: await getSettings(env.DB, propertyId),
      units: await listUnits(env.DB, propertyId),
    });
  }));

  router.put("/api/admin/settings", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ settings?: Record<string, unknown> }>(req);
    if (!body?.settings) return apiError(400, "settings attendu");
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.settings)) {
      if (!SETTING_KEYS.has(key)) return apiError(400, `clé inconnue : ${key}`);
      entries[key] = String(value);
    }
    await updateSettings(env.DB, propertyId, entries);
    await audit(env.DB, "admin", "settings.update", `property:${propertyId}`, entries);
    return json({ settings: await getSettings(env.DB, propertyId) });
  }));

  // --- synchro iCal ---------------------------------------------------------------------
  router.get("/api/admin/ical", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const units = await listUnits(env.DB, propertyId);
    const feeds = (await listFeeds(env.DB)).filter((f) => units.some((u) => u.id === f.unitId));
    return json({
      feeds,
      exports: units
        .filter((u) => u.active)
        .map((u) => ({ unitId: u.id, unitName: u.name, url: `${env.PUBLIC_BASE_URL}/ical/${u.icalToken}.ics` })),
    });
  }));

  // Régénère le secret de l'URL d'export iCal d'un bien (les jetons du seed
  // « local-dev-token-* » ne doivent jamais rester en production). L'ancienne
  // adresse cesse de répondre : à réabonner côté Google/Airbnb après coup.
  router.post("/api/admin/units/:id/ical-token", guard(async (req, env, p) => {
    const unitId = intParam(p.id, 0);
    if (!unitId) return apiError(400, "bien inconnu");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const res = await env.DB.prepare("UPDATE units SET ical_token = ?1 WHERE id = ?2").bind(token, unitId).run();
    if (!res.meta.changes) return apiError(404, "bien inconnu");
    await audit(env.DB, "admin", "unit.ical_token.regenerate", `unit:${unitId}`, { par: currentUser(req) });
    return json({ unitId, url: `${env.PUBLIC_BASE_URL}/ical/${token}.ics` });
  }));

  router.post("/api/admin/ical-feeds", guard(async (req, env) => {
    const body = await readJson<{ unitId?: number; name?: string; url?: string; departureDayIncluded?: boolean }>(req);
    const unitId = intParam(String(body?.unitId ?? ""), 0);
    const name = String(body?.name ?? "").trim();
    const feedUrl = String(body?.url ?? "").trim();
    if (!unitId || !name || !/^https?:\/\//.test(feedUrl)) return apiError(400, "unitId, name et url http(s) requis");
    const departureDayIncluded = body?.departureDayIncluded === true;
    const id = await createFeed(env.DB, { unitId, name, url: feedUrl, departureDayIncluded });
    await audit(env.DB, "admin", "ical_feed.create", `feed:${id}`, { unitId, name, departureDayIncluded });
    return json({ id }, 201);
  }));

  router.patch("/api/admin/ical-feeds/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ name?: string; url?: string; active?: boolean; departureDayIncluded?: boolean }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (body.url !== undefined && !/^https?:\/\//.test(String(body.url))) return apiError(400, "url invalide");
    await updateFeed(env.DB, id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      url: body.url !== undefined ? String(body.url).trim() : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      departureDayIncluded: typeof body.departureDayIncluded === "boolean" ? body.departureDayIncluded : undefined,
    });
    await audit(env.DB, "admin", "ical_feed.update", `feed:${id}`, body);
    return json({ ok: true });
  }));

  router.delete("/api/admin/ical-feeds/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    await deleteFeed(env.DB, id);
    await audit(env.DB, "admin", "ical_feed.delete", `feed:${id}`);
    return json({ ok: true });
  }));

  router.post("/api/admin/ical-feeds/:id/sync", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const feed = await getFeed(env.DB, id);
    if (!feed) return apiError(404, "flux inconnu");
    const result = await syncFeed(env.DB, feed);
    return json({ result });
  }));

  router.post("/api/admin/ical-sync", guard(async (_req, env) => {
    const feeds = await listFeeds(env.DB, true);
    const results = [];
    for (const feed of feeds) results.push(await syncFeed(env.DB, feed));
    return json({ results });
  }));

  // --- import elloha (phase 2) — dry-run par défaut ---------------------------------
  router.post("/api/admin/import/elloha", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ csv?: string; dryRun?: boolean }>(req);
    const csv = String(body?.csv ?? "");
    if (csv.trim().length === 0) return apiError(400, "csv attendu");
    const result = await importElloha(env.DB, propertyId, csv, body?.dryRun !== false);
    return json({ result });
  }));

  // --- import des agendas Google de papa (scripts/importer_agenda_google.py) -------
  // Idempotent ; `essai: true` dit ce qui serait fait sans rien écrire.
  router.post("/api/admin/import/agenda-google", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{ unitId?: unknown; feedId?: unknown; evenements?: unknown; essai?: unknown }>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const unitId = intParam(String(body.unitId ?? ""), 0);
    const feedId = intParam(String(body.feedId ?? ""), 0);
    if (!Array.isArray(body.evenements) || body.evenements.length === 0) return apiError(400, "evenements : liste attendue");
    if (body.evenements.length > MAX_AGENDA_EVENTS) return apiError(400, `au plus ${MAX_AGENDA_EVENTS} événements par envoi`);
    const feed = await getFeed(env.DB, feedId);
    if (!feed) return apiError(404, "flux iCal inconnu");
    if (feed.unitId !== unitId) return apiError(400, `le flux ${feedId} appartient au bien ${feed.unitId}, pas au bien ${unitId}`);
    const essai = body.essai === true;
    const result = await importAgendaGoogle(env.DB, feed, body.evenements, { essai });
    if (!essai) {
      await audit(env.DB, "admin", "agenda.import", `feed:${feed.id}`, {
        par: currentUser(req), creees: result.creees, completees: result.completees,
        annulees: result.annulees, blocages: result.blocages, ignorees: result.ignorees,
      });
      const unit = await getUnit(env.DB, unitId);
      if (unit && result.creees + result.annulees + result.blocages > 0) triggerBeds24Push(env.DB, env, execCtx, unit.propertyId);
    }
    return json({ result });
  }));

  // --- accès de service (Claude, scripts du Mac) -------------------------------------
  // Liste : tout accès admin. Création et révocation : humains seulement (une clé
  // ne fabrique pas d'autres clés). La clé en clair n'est rendue qu'une fois.
  router.get("/api/admin/service-keys", guard(async (_req, env) => {
    return json({ keys: await listServiceKeys(env.DB) });
  }));

  router.post("/api/admin/service-keys", guard(async (req, env) => {
    if (!isHuman(req)) return apiError(403, "une clé de service se crée depuis une session humaine (page Utilisateurs)");
    const body = await readJson<{ name?: unknown }>(req);
    const name = typeof body?.name === "string" ? body.name.trim().toLowerCase() : "";
    if (!validServiceKeyName(name)) return apiError(400, "nom invalide — 2 à 40 caractères parmi a-z, 0-9, point, tiret, underscore");
    const exists = await env.DB.prepare("SELECT 1 FROM service_keys WHERE name = ?1").bind(name).first();
    if (exists) return apiError(409, "ce nom existe déjà (une clé révoquée garde son nom : en choisir un autre)");
    const { key, row } = await createServiceKey(env.DB, name, currentUser(req));
    await audit(env.DB, "admin", "service_key.create", `service_key:${row.id}`, { name, par: currentUser(req) });
    return json({ ok: true, key, serviceKey: row, header: "Authorization: Bearer svc:<clé>" });
  }));

  router.post("/api/admin/service-keys/:id/revoke", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "une clé de service se révoque depuis une session humaine (page Utilisateurs)");
    const id = intParam(p.id, 0);
    if (!(await revokeServiceKey(env.DB, id, currentUser(req)))) return apiError(404, "clé inconnue ou déjà révoquée");
    await audit(env.DB, "admin", "service_key.revoke", `service_key:${id}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- export de la base (sauvegarde de nuit, tirée depuis le Mac) ------------------
  // .sqlite : fichier SQLite complet et cohérent (VACUUM INTO), Node seulement.
  // .sql : schéma + données en SQL, les deux cibles (seule voie sur Workers).
  // Ouvert à tout compte du back-office, et au compte réservé « sauvegarde ».
  router.get("/api/admin/export.sqlite", guard(async (req, env) => {
    if (!env.SQLITE_SNAPSHOT) {
      return apiError(501, "export SQLite indisponible sur cette cible (Cloudflare) : utiliser /api/admin/export.sql");
    }
    const bytes = await env.SQLITE_SNAPSHOT();
    await audit(env.DB, "admin", "export.sqlite", undefined, { octets: bytes.byteLength, par: currentUser(req) });
    return new Response(bytes, {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="gites-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }));

  // .tar des photos envoyées depuis le back-office (UPLOADS_DIR, Node
  // seulement) : tirée par la sauvegarde de nuit juste après la base.
  router.get("/api/admin/export-uploads.tar", guard(async (req, env) => {
    const store = env.UPLOADS;
    if (!store?.list || !store.read) {
      return apiError(501, "photos indisponibles sur cette cible (seulement sur le serveur Node)", { code: "uploads_unavailable" });
    }
    const names = (await store.list()).filter((n) => /^[0-9a-f]{32}\.(?:jpg|png|webp)$/.test(n)).sort();
    await audit(env.DB, "admin", "export.uploads", undefined, { fichiers: names.length, par: currentUser(req) });
    const read = store.read.bind(store);
    return new Response(tarStream(names, read), {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="gites-photos-${new Date().toISOString().slice(0, 10)}.tar"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-gites-files": String(names.length),
      },
    });
  }));

  router.get("/api/admin/export.sql", guard(async (req, env) => {
    const dump = await exportSql(env.DB);
    await audit(env.DB, "admin", "export.sql", undefined, { tables: dump.tables, lignes: dump.rows, par: currentUser(req) });
    return new Response(dump.sql, {
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="gites-${new Date().toISOString().slice(0, 10)}.sql"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }));

  // --- messages : les échanges clients vivent dans la plateforme --------------------
  router.get("/api/admin/messages", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const bookingId = intParam(url.searchParams.get("booking"), 0) || undefined;
    try {
      return json({
        messages: await listMessages(env.DB, { propertyId, status, bookingId, direction: bookingId ? undefined : "in" }),
      });
    } catch {
      return json({ messages: [], note: "table messages absente — appliquer les migrations" });
    }
  }));

  router.get("/api/admin/messages/:id/thread", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const message = await getMessage(env.DB, id);
    if (!message) return apiError(404, "message inconnu");
    const thread = await getThread(env.DB, {
      bookingId: message.bookingId,
      guestId: message.guestId,
      email: message.bookingId || message.guestId ? null : message.direction === "in" ? message.fromEmail : message.toEmail,
    });
    return json({ message, thread });
  }));

  router.patch("/api/admin/messages/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ status?: string }>(req);
    const status = body?.status === "traité" ? "traité" : "nouveau";
    await markMessage(env.DB, id, status);
    return json({ ok: true });
  }));

  /** Réponse de l'équipe : visible immédiatement dans le fil (et sur le voucher
   *  du client) ; doublée par email si l'envoi réel est activé (sinon stub). */
  async function sendTeamReply(
    env: Env,
    opts: {
      propertyId: number; bookingId: number | null; guestId: number | null; toEmail: string | null; subject: string; body: string;
      /** Réponse à un mail de la boîte de contact : fil Gmail conservé (In-Reply-To / References). */
      thread?: { inReplyTo: string | null; references: string | null };
    },
  ): Promise<{ id: number; delivery: string }> {
    const db = env.DB;
    const property = await getProperty(db, opts.propertyId);
    let delivery = "aucune";
    let sentMessageId: string | null = null;
    if (opts.toEmail && /@/.test(opts.toEmail)) {
      // Le statut réel de l'envoi (SMTP ou Resend), et non plus une déduction
      // des variables : un échec d'envoi se voit comme tel dans le fil.
      const sent = await queueEmailDetailed(db, env, {
        bookingId: opts.bookingId,
        to: opts.toEmail,
        subject: opts.subject,
        bodyText: opts.body,
        kind: "reply",
        inReplyTo: opts.thread?.inReplyTo ?? null,
        references: opts.thread?.references ?? null,
      });
      delivery = sent.status;
      // le Message-ID SMTP (<…>) : la réponse du client, In-Reply-To, retrouvera ce fil
      sentMessageId = sent.providerId && /^<[^<>\s]+>$/.test(sent.providerId) ? sent.providerId : null;
    }
    const id = await insertOutboundMessage(db, {
      propertyId: opts.propertyId,
      toEmail: opts.toEmail,
      fromEmail: property?.contactEmail ?? "équipe",
      subject: opts.subject,
      bodyText: opts.body,
      bookingId: opts.bookingId,
      guestId: opts.guestId,
      delivery,
      channel: opts.thread ? "email" : "form",
      messageId: sentMessageId,
      inReplyTo: opts.thread?.inReplyTo ?? null,
      references: opts.thread?.references ?? null,
    });
    await audit(db, "admin", "message.reply", `message:${id}`, { bookingId: opts.bookingId, delivery });
    return { id, delivery };
  }

  router.post("/api/admin/messages/:id/reply", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const original = await getMessage(env.DB, id);
    if (!original) return apiError(404, "message inconnu");
    const body = await readJson<{ body?: string }>(req);
    const text = String(body?.body ?? "").trim();
    if (text.length < 2) return apiError(400, "réponse vide");
    // Message d'un canal (Airbnb, Booking…) : la réponse repart par Beds24, sur
    // le canal du voyageur, et jamais par mail (l'adresse est souvent un relais).
    if (original.channel === "beds24") {
      try {
        const result = await replyOnChannel(env, original, text);
        await markMessage(env.DB, id, "traité");
        return json({ ok: true, ...result });
      } catch (e) {
        if (e instanceof Beds24Error) {
          await audit(env.DB, "admin", "message.reply.beds24.error", `message:${id}`, { error: e.message });
          return apiError(502, `réponse non partie vers ${original.canal ?? "le canal"} : ${e.message}`);
        }
        throw e;
      }
    }
    const toEmail = original.direction === "in" ? original.fromEmail : original.toEmail;
    // Mail de la boîte de contact : on ne répond jamais à l'adresse des gîtes (boucle) ni à un
    // expéditeur qui s'en réclame sans preuve.
    let thread: { inReplyTo: string | null; references: string | null } | undefined;
    if (original.channel === "email") {
      if (original.spoofed || (toEmail && (await ownAddresses(env.DB, env)).has(toEmail.toLowerCase()))) {
        return apiError(400, "Ce message vient de l'adresse des gîtes elle-même (ou s'en réclame sans preuve) : pas de réponse, cela écrirait aux gîtes.");
      }
      const parent = original.direction === "in" ? extractMessageIds(original.messageId)[0] ?? null : null;
      const chain = [...extractMessageIds(original.refs), ...(parent ? [parent] : [])].filter((x, i, a) => a.indexOf(x) === i).slice(-20);
      thread = { inReplyTo: parent, references: chain.length ? chain.join(" ") : null };
    }
    const result = await sendTeamReply(env, {
      propertyId: original.propertyId ?? 1,
      bookingId: original.bookingId,
      guestId: original.guestId,
      toEmail,
      subject: original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`,
      body: text,
      thread,
    });
    // un envoi échoué ne retire pas la conversation de « À répondre » : rien n'est parti
    if (result.delivery !== "failed") await markMessage(env.DB, id, "traité");
    return json({ ok: true, ...result });
  }));

  // Boîte de contact (IMAP) : état de la relève, et relève à la demande.
  router.get("/api/admin/mailbox", guard(async (_req, env) => {
    return json({
      configured: mailboxConfigured(env),
      supported: typeof env.IMAP_FETCH === "function",
      note: mailboxConfigured(env) && !env.IMAP_FETCH ? NO_SOCKET_MESSAGE : null,
      state: await getMailboxState(env.DB),
    });
  }));

  router.post("/api/admin/mailbox/poll", guard(async (_req, env) => {
    const result = await pullMailbox(env);
    return json({ ok: !result.error, result });
  }));

  // Nouveau message à un client depuis sa réservation (fiche résa → Messages).
  router.post("/api/admin/bookings/:id/messages", guard(async (req, env, p) => {
    const bookingId = intParam(p.id, 0);
    const booking = await getBooking(env.DB, bookingId);
    if (!booking) return apiError(404, "réservation inconnue");
    const body = await readJson<{ body?: string }>(req);
    const text = String(body?.body ?? "").trim();
    if (text.length < 2) return apiError(400, "message vide");
    const result = await sendTeamReply(env, {
      propertyId: booking.propertyId ?? 1,
      bookingId: booking.id,
      guestId: booking.guestId,
      toEmail: booking.guestEmail ?? null,
      subject: `[${booking.reference}] Votre réservation`,
      body: text,
    });
    return json({ ok: true, ...result });
  }));

  // Simulateur d'email entrant (test local de toute la chaîne, sans DNS ni
  // envoi réel : l'accusé de réception éventuel est journalisé en stub).
  router.post("/api/admin/dev-inbound-email", guard(async (req, env) => {
    const body = await readJson<{ from?: string; fromName?: string; to?: string; subject?: string; text?: string }>(req);
    if (!body?.from || !body.text) return apiError(400, "from et text requis");
    const parsed: ParsedEmail = {
      messageId: `<simulation-${Date.now()}@local>`,
      from: String(body.from).toLowerCase(),
      fromName: body.fromName ?? null,
      to: body.to ?? null,
      subject: body.subject ?? "(simulation)",
      textBody: String(body.text),
      isAutoGenerated: false,
    };
    const result = await processInboundEmail(env.DB, env, parsed, {
      reply: async (subject, replyBody) => {
        await env.DB
          .prepare(
            "INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status) VALUES (NULL, ?1, ?2, ?3, 'auto_reply_simulation', 'stub')",
          )
          .bind(parsed.from, subject, replyBody)
          .run();
      },
      // pas de hook forward en simulation : le transfert réel n'existe qu'en prod
    });
    return json({ result });
  }));

  // --- checklist de mise en route -----------------------------------------------------
  router.get("/api/admin/checklist", guard(async (_req, env) => {
    return json({ items: await listChecklist(env.DB) });
  }));

  router.patch("/api/admin/checklist/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ status?: string; note?: string }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    const status = ["a_faire", "en_cours", "fait", "verifie", "n_a"].includes(String(body.status))
      ? (body.status as "fait")
      : undefined;
    await updateChecklistItem(env.DB, id, { status, note: typeof body.note === "string" ? body.note : undefined });
    await audit(env.DB, "admin", "checklist.update", `checklist:${id}`, body);
    return json({ ok: true });
  }));

  // --- journaux ---------------------------------------------------------------------
  router.get("/api/admin/email-log", guard(async (_req, env, _p, url) => {
    const bookingId = intParam(url.searchParams.get("booking"), 0) || undefined;
    return json({ emails: await listEmailLog(env.DB, bookingId) });
  }));

  router.get("/api/admin/audit", guard(async (_req, env, _p, url) => {
    return json({ entries: await listAudit(env.DB, intParam(url.searchParams.get("limit"), 200)) });
  }));

  // --- Beds24 (canal OTA) : diagnostic de connexion ---------------------------------
  // Compte relié, propriétés du compte, et état du mapping en base (« actif »,
  // « périmé » = l'id mappé n'existe plus dans ce compte, « absent »). Lectures
  // seules — sert aussi à décider si l'écran propose « Créer la propriété ».
  router.get("/api/admin/beds24/status", guard(async (_req, env, _p, url) => {
    return json(await beds24Liaison(env, intParam(url.searchParams.get("property"), 1)));
  }));

  // Ce que « Créer la propriété sur Beds24 » enverrait — aucun réseau sortant.
  router.get("/api/admin/beds24/creer-propriete/apercu", guard(async (_req, env, _p, url) => {
    try {
      return json(await buildPropertyPlan(env.DB, intParam(url.searchParams.get("property"), 1), env.PUBLIC_BASE_URL));
    } catch (e) {
      if (e instanceof CreationRefusee) return apiError(e.status, e.message);
      throw e;
    }
  }));

  // Création de la propriété et d'une room par hébergement vendable sur les
  // canaux, puis écriture du mapping (services/beds24-propriete.ts). Exige
  // { confirmer: true } : le compte Beds24 est réel, sans bac à sable.
  router.post("/api/admin/beds24/creer-propriete", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: unknown; confirmer?: unknown }>(req);
    if (body?.confirmer !== true) {
      return apiError(400, "confirmation requise — renvoyer { confirmer: true } après avoir relu l'aperçu");
    }
    const propertyId = Number(body.propertyId ?? 1);
    if (!Number.isInteger(propertyId) || propertyId < 1) return apiError(400, "propertyId invalide");
    try {
      return json(await createBeds24Property(env, propertyId, currentUser(req)));
    } catch (e) {
      if (e instanceof CreationRefusee) return apiError(e.status, e.message);
      if (e instanceof Beds24Error) {
        await audit(env.DB, "admin", "beds24.creer_propriete_echec", `property:${propertyId}`, {
          par: currentUser(req), erreur: e.message,
        });
        return apiError(502, e.message);
      }
      throw e;
    }
  }));

  // Rétablissement de la liaison DEPUIS le back-office : coller un code
  // d'invitation généré dans Beds24 (Settings → Apps & Integrations → API)
  // → échangé contre un refresh token stocké en base (app_settings), aucun
  // redéploiement ni secret à manipuler.
  router.post("/api/admin/beds24/invite-code", guard(async (req, env) => {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) return apiError(400, "code d'invitation requis");
    try {
      const setup = await beds24Setup(code);
      await setSetting(env.DB, "beds24_refresh_token", setup.refreshToken);
      resetBeds24TokenCache();
      await audit(env.DB, "admin", "beds24.invite_code", "app_settings:beds24_refresh_token", { par: currentUser(req) });
      return json({ ok: true, status: await beds24Status(env) });
    } catch (e) {
      const msg = e instanceof Beds24Error ? e.message : "échange du code impossible";
      return apiError(502, msg);
    }
  }));

  // Push manuel des calendriers (dispo + prix + min-nuits) vers Beds24.
  router.post("/api/admin/beds24/push", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: number; days?: number }>(req);
    const propertyId = Number(body?.propertyId ?? 1);
    const days = Math.min(Math.max(Number(body?.days ?? 400), 1), 730);
    try {
      const result = await pushCalendars(env.DB, env, propertyId, days);
      await audit(env.DB, "admin", "beds24.push", `property:${propertyId}`, { days, rooms: result.pushed.length });
      return json(result);
    } catch (e) {
      // Refus par élément (room inconnue du compte, valeur rejetée) : en clair.
      if (e instanceof Beds24Error) return apiError(502, e.message);
      throw e;
    }
  }));

  // Pull manuel des résas canaux (Beds24 → notre base).
  router.post("/api/admin/beds24/pull", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: number }>(req);
    const propertyId = Number(body?.propertyId ?? 1);
    const property = await getProperty(env.DB, propertyId);
    if (!property?.beds24PropertyId) return apiError(400, "propriété non mappée à Beds24");
    try {
      const result = await pullBeds24Bookings(env.DB, env, propertyId, property.beds24PropertyId);
      // Le pull a réussi : un échec du push qui le suit ne doit pas le masquer.
      try {
        await pushCalendars(env.DB, env, propertyId);
        return json(result);
      } catch (e) {
        if (e instanceof Beds24Error) return json({ ...result, pushError: e.message });
        throw e;
      }
    } catch (e) {
      if (e instanceof Beds24Error) return apiError(502, e.message);
      throw e;
    }
  }));

  // Vue « Canaux » : tout l'état local en un appel (aucun réseau sortant —
  // la vue reste instantanée même hors ligne ; l'état réel du compte passe par
  // GET /api/admin/beds24/status, que la vue appelle APRÈS s'être affichée).
  // Conflits de synchronisation (issue #72) — la seule action possible depuis
  // le back-office est une DÉCISION : ignorer (avec motif) ou rouvrir. On ne
  // « résout » pas un conflit à la main : c'est la synchro qui constate qu'il
  // ne se reproduit plus, sinon on masquerait un calendrier encore faux.
  router.patch("/api/admin/sync-conflicts/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ status?: string; reason?: string }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    const status = String(body.status ?? "");
    if (status !== "ignored" && status !== "open") {
      return apiError(400, "statut invalide — attendu « ignored » ou « open »");
    }
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (status === "ignored" && !reason) return apiError(400, "motif requis pour ignorer un conflit");
    const conflict = await getSyncConflict(env.DB, id);
    if (!conflict) return apiError(404, "conflit introuvable");
    await setSyncConflictStatus(env.DB, id, status, reason || null, sqlNow());
    await audit(env.DB, "admin", status === "ignored" ? "sync_conflict.ignored" : "sync_conflict.reopened", `conflict:${id}`, {
      label: conflict.label, reason: reason || null,
    });
    return json({ ok: true });
  }));

  router.get("/api/admin/channels/overview", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const [property, units, channelBookings, events, openConflicts, ignoredConflicts] = await Promise.all([
      getProperty(db, propertyId),
      listUnits(db, propertyId),
      listBeds24Bookings(db),
      listAuditByAction(db, "beds24.", 15),
      // Conflits de synchro persistés (issue #72). DEUX lectures plafonnées
      // séparément, et non une seule triée : les ouverts passant devant, un
      // plafond commun aurait fait sortir les ignorés de la vue dès qu'ils sont
      // nombreux — donc hors de portée du bouton « Rouvrir ». Les résolus, eux,
      // n'ont plus rien à dire ici.
      listSyncConflicts(db, propertyId, { status: "open", limit: 60 }),
      listSyncConflicts(db, propertyId, { status: "ignored", limit: 40 }),
    ]);
    const conflicts = [...openConflicts, ...ignoredConflicts];
    const lastPull = await db
      .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
      .bind(propertyId)
      .first<{ value: string }>();
    const webhookKey = ((await getSetting(env.DB, "beds24_webhook_key")) ?? env.BEDS24_WEBHOOK_KEY ?? "").trim() || null;
    return json({
      configured: await beds24Configured(env),
      webhookUrl: webhookKey
        ? `${env.PUBLIC_BASE_URL}/api/webhooks/beds24?key=${webhookKey}`
        : null,
      property: property
        ? { id: property.id, name: property.name, beds24PropertyId: property.beds24PropertyId }
        : null,
      units: units
        .filter((u) => u.active)
        .map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, beds24RoomId: u.beds24RoomId })),
      channelBookings: channelBookings.map((b) => ({
        reference: b.reference, unitName: b.unitName, channelLabel: b.channelLabel,
        checkin: b.checkin, checkout: b.checkout, status: b.status, totalCents: b.totalCents,
        guestName: b.guestName,
      })),
      lastPull: lastPull?.value ?? null,
      events,
      conflicts: conflicts
        .map((c) => ({
          id: c.id, source: c.source, kind: c.kind, status: c.status,
          unitId: c.unitId, unitName: c.unitName, checkin: c.checkin, checkout: c.checkout,
          bookingReference: c.bookingReference, channelLabel: c.channelLabel, label: c.label,
          firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt, ignoreReason: c.ignoreReason,
        })),
    });
  }));
}
