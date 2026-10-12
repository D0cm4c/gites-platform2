// Couche d'accès D1 — toutes les requêtes SQL du projet vivent ici.
//
// GARANTIE ANTI-SURBOOKING : createBookingAtomic vérifie la disponibilité
// (liaisons unit_links comprises) et insère la réservation dans UNE SEULE
// instruction SQL (INSERT … SELECT … WHERE NOT EXISTS). SQLite exécute chaque
// instruction atomiquement et D1 sérialise les écritures : deux réservations
// simultanées sur des unités en conflit ne peuvent jamais passer toutes les
// deux. Ce comportement est prouvé par test/booking-db.test.ts (courses).

import { addDays, isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import type { UnitLink } from "../core/availability";
import type { GuestIdType, GuestRegisterEntry } from "../core/guest-register";
import type { OptionDef, Promotion, RateOverride, RateRule, Season, UnitPricingInfo } from "../core/pricing";
import {
  MESSAGE_UNANSWERED_HOURS,
  RATE_HORIZON_DAYS,
  type DriftInput,
  type FeedState,
  type MessageState,
  type OpenConflictSummary,
  type UnitRateTarget,
} from "../core/drift";
import {
  conflictFingerprint,
  type SyncConflictInput,
  type SyncConflictKind,
  type SyncConflictSource,
  type SyncConflictStatus,
} from "../core/sync-conflicts";
import { phoneCore, sqlPhoneDigits } from "../core/phone";

type Raw = Record<string, unknown>;

/** Le créneau est-il fermé par un BLOCAGE MANUEL actif (issue #74) ?
 *
 *  Fragment SQL partagé par les CINQ écritures atomiques (création,
 *  confirmation, changement de dates, déménagement, réactivation) : un blocage
 *  manuel occupe le stock exactement comme une réservation confirmée, avec la
 *  MÊME expansion par `unit_links` — bloquer La Scierie ferme le Domaine.
 *
 *  Il est défini ici une seule fois, et pas recopié dans chaque requête :
 *  c'est la seule façon d'éviter qu'un des cinq chemins diverge en silence.
 *  Les trois arguments sont des EXPRESSIONS SQL écrites dans ce fichier
 *  (numéros de paramètres liés ou sous-requêtes), jamais des données. */
function manualBlockConflictSql(unitExpr: string, checkinExpr: string, checkoutExpr: string): string {
  return `NOT EXISTS (
            SELECT 1 FROM manual_blocks k
             WHERE k.active = 1
               AND k.checkin < ${checkoutExpr}
               AND k.checkout > ${checkinExpr}
               AND k.unit_id IN (
                 SELECT ${unitExpr}
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ${unitExpr}
               )
          )`;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => String(v ?? "");
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

// ---------------------------------------------------------------------------
// Domaines & unités
// ---------------------------------------------------------------------------

export interface PropertyRow {
  id: number;
  slug: string;
  name: string;
  refPrefix: string;
  address: string | null;
  commune: string | null;
  timezone: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  active: boolean;
  beds24PropertyId: number | null;
}

function mapProperty(r: Raw): PropertyRow {
  return {
    id: num(r.id), slug: str(r.slug), name: str(r.name), refPrefix: str(r.ref_prefix),
    address: strOrNull(r.address), commune: strOrNull(r.commune),
    timezone: str(r.timezone), currency: str(r.currency),
    contactEmail: strOrNull(r.contact_email), contactPhone: strOrNull(r.contact_phone),
    active: num(r.active) === 1,
    beds24PropertyId: r.beds24_property_id == null ? null : num(r.beds24_property_id),
  };
}

export async function listProperties(db: D1Database): Promise<PropertyRow[]> {
  const { results } = await db.prepare("SELECT * FROM properties WHERE active = 1 ORDER BY id").all();
  return (results as Raw[]).map(mapProperty);
}

export async function getProperty(db: D1Database, idOrSlug: number | string): Promise<PropertyRow | null> {
  const row = await db
    .prepare("SELECT * FROM properties WHERE id = ?1 OR slug = ?2")
    .bind(typeof idOrSlug === "number" ? idOrSlug : -1, String(idOrSlug))
    .first();
  return row ? mapProperty(row as Raw) : null;
}

export interface UnitRow {
  id: number;
  propertyId: number;
  slug: string;
  name: string;
  description: string | null;
  capacityBase: number;
  capacityMax: number;
  isComposite: boolean;
  compositePricing: "own" | "sum";
  active: boolean;
  sortOrder: number;
  icalToken: string;
  cleaningFeeCents: number;
  photoUrl: string | null;
  beds24RoomId: number | null;
  /** garde-fous de prix par nuit (issue #31) — null = aucune borne configurée */
  priceMinCents: number | null;
  priceMaxCents: number | null;
  /** pourcentage d'arrhes propre à l'hébergement (issue #75) — null = repli
   *  sur le `deposit_pct` du domaine */
  depositPct: number | null;
}

function mapUnit(r: Raw): UnitRow {
  return {
    id: num(r.id), propertyId: num(r.property_id), slug: str(r.slug), name: str(r.name),
    description: strOrNull(r.description),
    capacityBase: num(r.capacity_base), capacityMax: num(r.capacity_max),
    isComposite: num(r.is_composite) === 1,
    compositePricing: str(r.composite_pricing) === "sum" ? "sum" : "own",
    active: num(r.active) === 1, sortOrder: num(r.sort_order), icalToken: str(r.ical_token),
    cleaningFeeCents: num(r.cleaning_fee_cents), photoUrl: strOrNull(r.photo_url),
    beds24RoomId: r.beds24_room_id == null ? null : num(r.beds24_room_id),
    priceMinCents: numOrNull(r.price_min_cents),
    priceMaxCents: numOrNull(r.price_max_cents),
    depositPct: numOrNull(r.deposit_pct),
  };
}

export async function listUnits(db: D1Database, propertyId?: number): Promise<UnitRow[]> {
  const stmt = propertyId
    ? db.prepare("SELECT * FROM units WHERE property_id = ?1 ORDER BY sort_order, id").bind(propertyId)
    : db.prepare("SELECT * FROM units ORDER BY property_id, sort_order, id");
  const { results } = await stmt.all();
  return (results as Raw[]).map(mapUnit);
}

export async function getUnit(db: D1Database, unitId: number): Promise<UnitRow | null> {
  const row = await db.prepare("SELECT * FROM units WHERE id = ?1").bind(unitId).first();
  return row ? mapUnit(row as Raw) : null;
}

export async function getUnitByIcalToken(db: D1Database, token: string): Promise<UnitRow | null> {
  const row = await db.prepare("SELECT * FROM units WHERE ical_token = ?1").bind(token).first();
  return row ? mapUnit(row as Raw) : null;
}

export async function updateUnit(
  db: D1Database,
  unitId: number,
  fields: Partial<
    Pick<
      UnitRow,
      | "name" | "description" | "capacityBase" | "capacityMax" | "active" | "compositePricing"
      | "cleaningFeeCents" | "photoUrl" | "priceMinCents" | "priceMaxCents" | "depositPct"
    >
  >,
): Promise<void> {
  // Les garde-fous de prix se RETIRENT (retour à null) autant qu'ils se posent :
  // COALESCE ne suffit pas, d'où le drapeau « clé fournie » de ?10 et ?12.
  // Même mécanique pour le pourcentage d'arrhes en ?14/?15 : vider le champ
  // signifie « repli sur le domaine », pas « 0 % ».
  await db
    .prepare(
      `UPDATE units SET
         name = COALESCE(?2, name),
         description = COALESCE(?3, description),
         capacity_base = COALESCE(?4, capacity_base),
         capacity_max = COALESCE(?5, capacity_max),
         active = COALESCE(?6, active),
         composite_pricing = COALESCE(?7, composite_pricing),
         cleaning_fee_cents = COALESCE(?8, cleaning_fee_cents),
         photo_url = COALESCE(?9, photo_url),
         price_min_cents = CASE WHEN ?10 = 1 THEN ?11 ELSE price_min_cents END,
         price_max_cents = CASE WHEN ?12 = 1 THEN ?13 ELSE price_max_cents END,
         deposit_pct = CASE WHEN ?14 = 1 THEN ?15 ELSE deposit_pct END
       WHERE id = ?1`,
    )
    .bind(
      unitId,
      fields.name ?? null,
      fields.description ?? null,
      fields.capacityBase ?? null,
      fields.capacityMax ?? null,
      fields.active === undefined ? null : fields.active ? 1 : 0,
      fields.compositePricing ?? null,
      fields.cleaningFeeCents ?? null,
      fields.photoUrl ?? null,
      fields.priceMinCents === undefined ? 0 : 1,
      fields.priceMinCents ?? null,
      fields.priceMaxCents === undefined ? 0 : 1,
      fields.priceMaxCents ?? null,
      fields.depositPct === undefined ? 0 : 1,
      fields.depositPct ?? null,
    )
    .run();
}

/** Crée un nouvel hébergement (maison C, futur gîte…). Le token iCal est
 *  généré aléatoirement ; les liaisons se posent ensuite via setMutualLinks. */
export async function createUnit(
  db: D1Database,
  u: {
    propertyId: number;
    name: string;
    description?: string | null;
    capacityBase: number;
    capacityMax: number;
    isComposite?: boolean;
    compositePricing?: "own" | "sum";
    cleaningFeeCents?: number;
    photoUrl?: string | null;
    sortOrder?: number;
  },
): Promise<number> {
  const slug = u.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `unite-${Date.now()}`;
  const token = crypto.randomUUID().replace(/-/g, "");
  const res = await db
    .prepare(
      `INSERT INTO units (property_id, slug, name, description, capacity_base, capacity_max,
                          is_composite, composite_pricing, sort_order, ical_token, cleaning_fee_cents, photo_url)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      u.propertyId, slug, u.name, u.description ?? null, u.capacityBase, u.capacityMax,
      u.isComposite ? 1 : 0, u.compositePricing ?? "own", u.sortOrder ?? 99, token,
      u.cleaningFeeCents ?? 0, u.photoUrl ?? null,
    )
    .run();
  return res.meta.last_row_id;
}

/* --------------------------------------------------------------------------
 * Galerie de photos par hébergement (issue #32, migration 0021)
 *
 * Les FICHIERS restent des assets commités (public/img/gites/<gîte>/), produits
 * par scripts/optimize-images.mjs. Cette table ne porte que le chemin et
 * l'éditorial : ordre, texte alternatif, légende, retrait. Le back-office
 * choisit et ordonne parmi les fichiers présents, il n'en téléverse aucun.
 * -------------------------------------------------------------------------- */

export interface UnitPhotoRow {
  id: number;
  unitId: number;
  /** Chemin du JPEG de repli, ex. `/img/gites/la-scierie/facade.jpg`. */
  path: string;
  /** Texte alternatif — jamais vide (l'API refuse la chaîne vide). */
  alt: string;
  caption: string | null;
  /** Largeurs des variantes WebP présentes, ex. `[640, 1280]`. Vide = JPEG seul. */
  webpWidths: number[];
  width: number | null;
  height: number | null;
  sortOrder: number;
  active: boolean;
}

function mapUnitPhoto(r: Raw): UnitPhotoRow {
  const widths = strOrNull(r.webp_widths);
  return {
    id: num(r.id),
    unitId: num(r.unit_id),
    path: str(r.path),
    alt: str(r.alt),
    caption: strOrNull(r.caption),
    webpWidths: widths
      ? widths.split(",").map((w) => Number(w.trim())).filter((w) => Number.isFinite(w) && w > 0)
      : [],
    width: numOrNull(r.width),
    height: numOrNull(r.height),
    sortOrder: num(r.sort_order),
    active: num(r.active) === 1,
  };
}

/** Photos d'un ou plusieurs hébergements, dans l'ordre d'affichage.
 *  `includeInactive` n'est vrai que côté back-office : le public ne voit
 *  jamais une photo retirée. */
export async function listUnitPhotos(
  db: D1Database,
  unitIds: number[],
  includeInactive = false,
): Promise<UnitPhotoRow[]> {
  const ids = [...new Set(unitIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return [];
  // Liste d'ids construite à partir d'entiers validés ci-dessus, jamais de
  // texte reçu du client : pas de surface d'injection.
  const { results } = await db
    .prepare(
      `SELECT * FROM unit_photos
        WHERE unit_id IN (${ids.join(",")})${includeInactive ? "" : " AND active = 1"}
        ORDER BY unit_id, sort_order, id`,
    )
    .all();
  return (results as Raw[]).map(mapUnitPhoto);
}

/** Applique en un seul lot l'ordre, l'éditorial et l'état d'affichage des
 *  photos d'un hébergement. Les lignes non citées sont laissées telles quelles :
 *  la vue back-office envoie toujours la liste complète, mais une requête
 *  partielle ne doit pas faire disparaître le reste. */
export async function updateUnitPhotos(
  db: D1Database,
  unitId: number,
  photos: { id: number; alt: string; caption: string | null; active: boolean }[],
): Promise<void> {
  if (photos.length === 0) return;
  const stmts = photos.map((p, i) =>
    db
      .prepare(
        `UPDATE unit_photos SET alt = ?3, caption = ?4, active = ?5, sort_order = ?6
          WHERE id = ?1 AND unit_id = ?2`,
      )
      .bind(p.id, unitId, p.alt, p.caption, p.active ? 1 : 0, (i + 1) * 10),
  );
  await db.batch(stmts);
}

/** Rattache un fichier déjà présent dans les assets à un hébergement.
 *  Renvoie null si le chemin est déjà pris (l'index unique le garantit) —
 *  réactiver une photo retirée passe par updateUnitPhotos, pas par ici. */
export async function createUnitPhoto(
  db: D1Database,
  p: {
    unitId: number;
    path: string;
    alt: string;
    caption: string | null;
    webpWidths: number[];
    width: number | null;
    height: number | null;
    /** Faux pour une photo envoyée depuis l'ordinateur : masquée tant que
     *  son texte n'est pas écrit. Vrai par défaut. */
    active?: boolean;
  },
): Promise<number | null> {
  const next = await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM unit_photos WHERE unit_id = ?1")
    .bind(p.unitId)
    .first();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO unit_photos
         (unit_id, path, alt, caption, webp_widths, width, height, sort_order, active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      p.unitId,
      p.path,
      p.alt,
      p.caption,
      p.webpWidths.length ? p.webpWidths.join(",") : null,
      p.width,
      p.height,
      num((next as Raw | null)?.n ?? 10),
      p.active === false ? 0 : 1,
    )
    .run();
  return res.meta.changes > 0 ? res.meta.last_row_id : null;
}

/** Redéfinit les liaisons MUTUELLES d'une unité : toute résa de l'une bloque
 *  l'autre, dans les deux sens. Remplace l'existant pour cette unité. */
export async function setMutualLinks(db: D1Database, unitId: number, partnerIds: number[]): Promise<void> {
  const partners = [...new Set(partnerIds.filter((p) => p !== unitId && p > 0))];
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM unit_links WHERE unit_id = ?1 OR blocks_unit_id = ?1").bind(unitId),
  ];
  for (const p of partners) {
    stmts.push(db.prepare("INSERT INTO unit_links (unit_id, blocks_unit_id) VALUES (?1, ?2)").bind(unitId, p));
    stmts.push(db.prepare("INSERT INTO unit_links (unit_id, blocks_unit_id) VALUES (?1, ?2)").bind(p, unitId));
  }
  await db.batch(stmts);
}

/** Liens de blocage. Les liens sont toujours intra-domaine. */
export async function listLinks(db: D1Database, propertyId?: number): Promise<UnitLink[]> {
  const stmt = propertyId
    ? db
        .prepare(
          "SELECT ul.unit_id, ul.blocks_unit_id FROM unit_links ul JOIN units u ON u.id = ul.unit_id WHERE u.property_id = ?1",
        )
        .bind(propertyId)
    : db.prepare("SELECT unit_id, blocks_unit_id FROM unit_links");
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({ unitId: num(r.unit_id), blocksUnitId: num(r.blocks_unit_id) }));
}

// ---------------------------------------------------------------------------
// Paramètres par domaine
// ---------------------------------------------------------------------------

export interface PropertySettings {
  depositPct: number;
  balanceDueDays: number;
  holdMinutes: number;
  touristTaxCentsPerPersonNight: number;
  touristTaxIncludeChildren: boolean;
  cautionCents: number;
  checkinTime: string;
  checkoutTime: string;
  cgvText: string;
  allowDeposit: boolean;
  allowFullPayment: boolean;
  autoReplyEnabled: boolean;
  autoReplyText: string;
  emailForwardTo: string;
}

const SETTINGS_DEFAULTS: PropertySettings = {
  depositPct: 30,
  balanceDueDays: 30,
  holdMinutes: 30,
  touristTaxCentsPerPersonNight: 0,
  touristTaxIncludeChildren: true,
  cautionCents: 0,
  checkinTime: "16:00",
  checkoutTime: "10:00",
  cgvText: "",
  allowDeposit: true,
  allowFullPayment: true,
  autoReplyEnabled: false,
  autoReplyText: "",
  emailForwardTo: "",
};

export async function getSettings(db: D1Database, propertyId: number): Promise<PropertySettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE property_id = ?1")
    .bind(propertyId)
    .all();
  const kv = new Map((results as Raw[]).map((r) => [str(r.key), str(r.value)]));
  const bool = (k: string, d: boolean) => (kv.has(k) ? kv.get(k) === "true" : d);
  const int = (k: string, d: number) => (kv.has(k) ? Number(kv.get(k)) : d);
  const text = (k: string, d: string) => kv.get(k) ?? d;
  const D = SETTINGS_DEFAULTS;
  return {
    depositPct: int("deposit_pct", D.depositPct),
    balanceDueDays: int("balance_due_days", D.balanceDueDays),
    holdMinutes: int("hold_minutes", D.holdMinutes),
    touristTaxCentsPerPersonNight: int("tourist_tax_cents_per_person_night", D.touristTaxCentsPerPersonNight),
    touristTaxIncludeChildren: bool("tourist_tax_include_children", D.touristTaxIncludeChildren),
    cautionCents: int("caution_cents", D.cautionCents),
    checkinTime: text("checkin_time", D.checkinTime),
    checkoutTime: text("checkout_time", D.checkoutTime),
    cgvText: text("cgv_text", D.cgvText),
    allowDeposit: bool("allow_deposit", D.allowDeposit),
    allowFullPayment: bool("allow_full_payment", D.allowFullPayment),
    autoReplyEnabled: bool("auto_reply_enabled", D.autoReplyEnabled),
    autoReplyText: text("auto_reply_text", D.autoReplyText),
    emailForwardTo: text("email_forward_to", D.emailForwardTo),
  };
}

export async function updateSettings(db: D1Database, propertyId: number, entries: Record<string, string>): Promise<void> {
  const stmts = Object.entries(entries).map(([key, value]) =>
    db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (?1, ?2, ?3)").bind(propertyId, key, value),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// Contexte de tarification (tout ce qu'il faut pour computeQuote)
// ---------------------------------------------------------------------------

function mapSeason(r: Raw): Season {
  return { id: num(r.id), name: str(r.name), dateStart: str(r.date_start), dateEnd: str(r.date_end), priority: num(r.priority) };
}

function mapRateRule(r: Raw): RateRule {
  const days = strOrNull(r.checkin_days);
  return {
    id: num(r.id), unitId: num(r.unit_id), seasonId: numOrNull(r.season_id),
    priceWeekCents: num(r.price_week_cents), priceWeekendCents: num(r.price_weekend_cents),
    holidayPct: num(r.holiday_pct), minNights: num(r.min_nights),
    checkinDays: days ? days.split(",").map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d)) : null,
  };
}

function mapPromotion(r: Raw): Promotion {
  return {
    id: num(r.id), kind: str(r.kind) as Promotion["kind"], code: strOrNull(r.code), label: str(r.label),
    discountPct: numOrNull(r.discount_pct), discountCents: numOrNull(r.discount_cents),
    threshold: numOrNull(r.threshold), validFrom: strOrNull(r.valid_from), validUntil: strOrNull(r.valid_until),
    maxUses: numOrNull(r.max_uses), uses: num(r.uses), active: num(r.active) === 1,
  };
}

function mapOption(r: Raw): OptionDef & { active: boolean; sortOrder: number; propertyId: number } {
  return {
    id: num(r.id), name: str(r.name), pricingMode: str(r.pricing_mode) as OptionDef["pricingMode"],
    priceCents: num(r.price_cents), maxQty: numOrNull(r.max_qty), unitLabel: strOrNull(r.unit_label),
    active: num(r.active) === 1, sortOrder: num(r.sort_order), propertyId: num(r.property_id),
  };
}

export interface QuoteContext {
  property: PropertyRow;
  unit: UnitRow;
  pricingUnit: UnitPricingInfo;
  seasons: Season[];
  rateRules: RateRule[];
  /** surcharges par jour de l'unité et de ses composantes, sur la fenêtre
   *  demandée (toutes, si aucune fenêtre n'est passée) */
  rateOverrides: RateOverride[];
  promotions: Promotion[];
  options: (OptionDef & { active: boolean })[];
  settings: PropertySettings;
}

/** Contexte complet de tarification d'une unité.
 *
 *  `window` borne le chargement des surcharges à la période utile (le séjour
 *  pour un devis, la plage affichée pour un calendrier). Sans fenêtre, TOUTES
 *  les surcharges de l'unité sont chargées — pratique pour les tests, à éviter
 *  sur un chemin chaud. */
export async function getQuoteContext(
  db: D1Database,
  unitId: number,
  window?: { from: IsoDate; toExclusive: IsoDate },
): Promise<QuoteContext | null> {
  const unit = await getUnit(db, unitId);
  if (!unit) return null;
  const property = await getProperty(db, unit.propertyId);
  if (!property) return null;

  // Composantes d'une unité composite = unités physiques qu'elle bloque.
  const { results: compRows } = await db
    .prepare(
      `SELECT u.id, u.name, u.cleaning_fee_cents FROM unit_links ul
         JOIN units u ON u.id = ul.blocks_unit_id
        WHERE ul.unit_id = ?1 AND u.is_composite = 0
        ORDER BY u.sort_order, u.id`,
    )
    .bind(unitId)
    .all();
  const components = (compRows as Raw[]).map((r) => ({
    id: num(r.id),
    name: str(r.name),
    cleaningFeeCents: num(r.cleaning_fee_cents),
  }));

  const unitIds = [unitId, ...components.map((c) => c.id)];
  const placeholders = unitIds.map((_, i) => `?${i + 1}`).join(", ");
  const { results: ruleRows } = await db
    .prepare(`SELECT * FROM rate_rules WHERE unit_id IN (${placeholders})`)
    .bind(...unitIds)
    .all();

  const [{ results: seasonRows }, { results: promoRows }, { results: optionRows }, settings, rateOverrides] =
    await Promise.all([
      db.prepare("SELECT * FROM seasons WHERE property_id = ?1").bind(unit.propertyId).all(),
      db.prepare("SELECT * FROM promotions WHERE property_id = ?1").bind(unit.propertyId).all(),
      db.prepare("SELECT * FROM options WHERE property_id = ?1 AND active = 1 ORDER BY sort_order, id").bind(unit.propertyId).all(),
      getSettings(db, unit.propertyId),
      window
        ? listRateOverrides(db, unitIds, window.from, window.toExclusive)
        : listRateOverrides(db, unitIds, "0000-01-01", "9999-12-31"),
    ]);

  return {
    property,
    unit,
    pricingUnit: {
      id: unit.id,
      name: unit.name,
      compositePricing: unit.isComposite ? unit.compositePricing : "own",
      cleaningFeeCents: unit.cleaningFeeCents,
      depositPct: unit.depositPct,
      components: unit.isComposite ? components : [],
    },
    seasons: (seasonRows as Raw[]).map(mapSeason),
    rateRules: (ruleRows as Raw[]).map(mapRateRule),
    rateOverrides,
    promotions: (promoRows as Raw[]).map(mapPromotion),
    options: (optionRows as Raw[]).map(mapOption),
    settings,
  };
}

// ---------------------------------------------------------------------------
// Réservations
// ---------------------------------------------------------------------------

export interface BookingRow {
  id: number;
  reference: string;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  guestId: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  /** Langue du client (guests.lang) : mails et voucher en fr ou nl (lot 3). */
  guestLang?: string | null;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  status: "pending" | "confirmed" | "cancelled";
  holdExpiresAt: string | null;
  source: "direct" | "manual" | "ical" | "import";
  channelLabel: string | null;
  externalUid: string | null;
  totalCents: number;
  depositCents: number;
  paidCents: number;
  balanceDueDate: IsoDate | null;
  currency: string;
  quoteJson: string | null;
  optionsJson: string | null;
  promoCode: string | null;
  guestNotes: string | null;
  internalNotes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapBooking(r: Raw): BookingRow {
  return {
    id: num(r.id), reference: str(r.reference), unitId: num(r.unit_id),
    unitName: strOrNull(r.unit_name) ?? undefined,
    propertyId: r.property_id == null ? undefined : num(r.property_id),
    guestId: numOrNull(r.guest_id),
    guestName: strOrNull(r.guest_name),
    guestEmail: strOrNull(r.guest_email),
    guestLang: strOrNull(r.guest_lang),
    checkin: str(r.checkin), checkout: str(r.checkout),
    adults: num(r.adults), children: num(r.children),
    status: str(r.status) as BookingRow["status"],
    holdExpiresAt: strOrNull(r.hold_expires_at),
    source: str(r.source) as BookingRow["source"],
    channelLabel: strOrNull(r.channel_label), externalUid: strOrNull(r.external_uid),
    totalCents: num(r.total_cents), depositCents: num(r.deposit_cents), paidCents: num(r.paid_cents),
    balanceDueDate: strOrNull(r.balance_due_date), currency: str(r.currency),
    quoteJson: strOrNull(r.quote_json), optionsJson: strOrNull(r.options_json),
    promoCode: strOrNull(r.promo_code), guestNotes: strOrNull(r.guest_notes), internalNotes: strOrNull(r.internal_notes),
    cancelledAt: strOrNull(r.cancelled_at), cancelReason: strOrNull(r.cancel_reason),
    createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

const BOOKING_JOIN = `
  SELECT b.*, u.name AS unit_name, u.property_id AS property_id,
         TRIM(COALESCE(g.first_name, '') || ' ' || g.last_name) AS guest_name,
         g.email AS guest_email, COALESCE(b.lang, g.lang) AS guest_lang
    FROM bookings b
    JOIN units u ON u.id = b.unit_id
    LEFT JOIN guests g ON g.id = b.guest_id`;

export interface CreateBookingInput {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  status: "pending" | "confirmed";
  holdMinutes?: number;
  source: "direct" | "manual" | "ical" | "import";
  channelLabel?: string | null;
  externalUid?: string | null;
  guestId?: number | null;
  totalCents?: number;
  depositCents?: number;
  balanceDueDate?: IsoDate | null;
  quoteJson?: string | null;
  optionsJson?: string | null;
  promoCode?: string | null;
  guestNotes?: string | null;
  internalNotes?: string | null;
  /** injectable pour les tests (référence, hold, fenêtre de conflit) */
  now?: Date;
}

export type CreateBookingResult =
  | { ok: true; id: number; reference: string }
  | { ok: false; reason: "conflict" };

/** LA requête critique : vérifie la disponibilité (liaisons comprises) et
 *  insère dans une seule instruction atomique. meta.changes === 0 ⇒ conflit. */
export async function createBookingAtomic(db: D1Database, input: CreateBookingInput): Promise<CreateBookingResult> {
  if (!isIsoDate(input.checkin) || !isIsoDate(input.checkout) || input.checkin >= input.checkout) {
    throw new Error(`createBookingAtomic: dates invalides ${input.checkin} → ${input.checkout}`);
  }
  const nowDate = input.now ?? new Date();
  const now = sqlNow(nowDate);
  const year = todayInZone(nowDate).slice(0, 4);
  const holdExpiresAt =
    input.status === "pending"
      ? sqlNow(new Date(nowDate.getTime() + (input.holdMinutes ?? 30) * 60_000))
      : null;

  const res = await db
    .prepare(
      `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, children,
                             status, hold_expires_at, source, channel_label, external_uid,
                             total_cents, deposit_cents, balance_due_date, quote_json, options_json,
                             promo_code, guest_notes, internal_notes, created_at, updated_at)
       SELECT
         (SELECT p.ref_prefix FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?1)
           || '-' || ?2 || '-'
           || printf('%03d', 1 + (
                SELECT COUNT(*) FROM bookings b
                 WHERE b.reference LIKE
                   (SELECT p2.ref_prefix FROM units u2 JOIN properties p2 ON p2.id = u2.property_id WHERE u2.id = ?1)
                   || '-' || ?2 || '-%'
              )),
         ?1, ?6, ?3, ?4, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?5, ?5
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.checkin < ?4
            AND b.checkout > ?3
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
            AND b.unit_id IN (
              SELECT ?1
              UNION ALL
              SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
            )
       )
         AND ${manualBlockConflictSql("?1", "?3", "?4")}`,
    )
    .bind(
      input.unitId,                    // ?1
      year,                            // ?2
      input.checkin,                   // ?3
      input.checkout,                  // ?4
      now,                             // ?5
      input.guestId ?? null,           // ?6
      input.adults,                    // ?7
      input.children,                  // ?8
      input.status,                    // ?9
      holdExpiresAt,                   // ?10
      input.source,                    // ?11
      input.channelLabel ?? null,      // ?12
      input.externalUid ?? null,       // ?13
      input.totalCents ?? 0,           // ?14
      input.depositCents ?? 0,         // ?15
      input.balanceDueDate ?? null,    // ?16
      input.quoteJson ?? null,         // ?17
      input.optionsJson ?? null,       // ?18
      input.promoCode ?? null,         // ?19
      input.guestNotes ?? null,        // ?20
      input.internalNotes ?? null,     // ?21
    )
    .run();

  if (res.meta.changes !== 1) return { ok: false, reason: "conflict" };
  const id = res.meta.last_row_id;
  const row = await db.prepare("SELECT reference FROM bookings WHERE id = ?1").bind(id).first<{ reference: string }>();
  return { ok: true, id, reference: row?.reference ?? "" };
}

/** Inscrit une réservation DÉJÀ ANNULÉE (historique importé : séjour annulé
 *  dans un agenda externe). Pas de garde de disponibilité : une annulée
 *  n'occupe aucun stock, et son créneau a souvent été reloué. Même numérotation
 *  que createBookingAtomic. */
export async function insertCancelledBooking(
  db: D1Database,
  input: Omit<CreateBookingInput, "status" | "holdMinutes"> & { cancelReason: string },
): Promise<{ id: number; reference: string; inserted: boolean }> {
  if (!isIsoDate(input.checkin) || !isIsoDate(input.checkout) || input.checkin >= input.checkout) {
    throw new Error(`insertCancelledBooking: dates invalides ${input.checkin} → ${input.checkout}`);
  }
  const nowDate = input.now ?? new Date();
  const now = sqlNow(nowDate);
  const year = todayInZone(nowDate).slice(0, 4);
  const res = await db
    .prepare(
      `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, children,
                             status, source, channel_label, external_uid, total_cents,
                             internal_notes, cancelled_at, cancel_reason, created_at, updated_at)
       SELECT
         (SELECT p.ref_prefix FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?1)
           || '-' || ?2 || '-'
           || printf('%03d', 1 + (
                SELECT COUNT(*) FROM bookings b
                 WHERE b.reference LIKE
                   (SELECT p2.ref_prefix FROM units u2 JOIN properties p2 ON p2.id = u2.property_id WHERE u2.id = ?1)
                   || '-' || ?2 || '-%'
              )),
         ?1, ?6, ?3, ?4, ?7, ?8, 'cancelled', ?9, ?10, ?11, ?12, ?13, ?5, ?14, ?5, ?5
       WHERE ?11 IS NULL OR NOT EXISTS (SELECT 1 FROM bookings x WHERE x.external_uid = ?11)`,
    )
    .bind(
      input.unitId, year, input.checkin, input.checkout, now, input.guestId ?? null,
      input.adults, input.children, input.source, input.channelLabel ?? null, input.externalUid ?? null,
      input.totalCents ?? 0, input.internalNotes ?? null, input.cancelReason,
    )
    .run();
  if (res.meta.changes !== 1) {
    // Un appel concurrent a inscrit le même UID : on rend la ligne gagnante.
    const won = await db.prepare("SELECT id, reference FROM bookings WHERE external_uid = ?1").bind(input.externalUid ?? null).first<{ id: number; reference: string }>();
    if (!won) throw new Error("insertCancelledBooking: insertion refusée");
    return { id: Number(won.id), reference: won.reference, inserted: false };
  }
  const id = res.meta.last_row_id;
  const row = await db.prepare("SELECT reference FROM bookings WHERE id = ?1").bind(id).first<{ reference: string }>();
  return { id, reference: row?.reference ?? "", inserted: true };
}

export async function getBooking(db: D1Database, id: number): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.id = ?1`).bind(id).first();
  return row ? mapBooking(row as Raw) : null;
}

export async function getBookingByReference(db: D1Database, reference: string): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.reference = ?1`).bind(reference).first();
  return row ? mapBooking(row as Raw) : null;
}

export type BookingPeriod = "upcoming" | "current" | "past";
export type BookingSort = "created" | "checkin";

export interface BookingFilters {
  propertyId?: number;
  status?: string;
  from?: IsoDate;   // checkout > from
  to?: IsoDate;     // checkin < to
  search?: string;  // référence ou nom client
  limit?: number;
  /** Fenêtre relative à `today` — « à venir » / « en cours » / « passées » (issue #51). */
  period?: BookingPeriod;
  /** Jour de référence des périodes ; injectable pour les tests. */
  today?: IsoDate;
  /** `checkin` (défaut du back-office) répond à « qui arrive bientôt ? ».
   *  `created` garde l'ordre historique — utilisé par l'export CSV. */
  sort?: BookingSort;
}

export async function listBookings(db: D1Database, f: BookingFilters = {}): Promise<BookingRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };
  if (f.propertyId) push("u.property_id = ?", f.propertyId);
  if (f.status) push("b.status = ?", f.status);
  if (f.from) push("b.checkout > ?", f.from);
  if (f.to) push("b.checkin < ?", f.to);
  if (f.search) {
    binds.push(`%${f.search}%`);
    const i = binds.length;
    // Un numéro de téléphone se compare en chiffres, sans indicatif belge ni
    // 0 de tête (src/core/phone.ts) : « 0475 12 » trouve « +32 475 12 34 56 ».
    const core = phoneCore(f.search);
    let phone = "";
    if (core) {
      binds.push(`%${core}%`);
      phone = ` OR ${sqlPhoneDigits("g.phone")} LIKE ?${binds.length}`;
    }
    where.push(`(b.reference LIKE ?${i} OR g.last_name LIKE ?${i} OR g.first_name LIKE ?${i} OR g.email LIKE ?${i}${phone})`);
  }
  if (f.period) {
    // « En cours » = ce qui occupe la journée d'aujourd'hui, arrivée ET départ
    // du jour compris : le départ du matin fait encore partie du travail du
    // jour (état des lieux, ménage, solde). Les trois périodes forment une
    // partition — chaque réservation tombe dans exactement une.
    const today = f.today ?? todayInZone();
    if (f.period === "upcoming") push("b.checkin > ?", today);
    else if (f.period === "current") {
      push("b.checkin <= ?", today);
      push("b.checkout >= ?", today);
    } else push("b.checkout < ?", today);
  }

  // Tri par arrivée : croissant quand on regarde devant soi (le prochain
  // arrivant en tête), décroissant quand on regarde derrière (le dernier
  // séjour en tête). Sans ça, « passées » remonterait 2024 en premier.
  const order =
    f.sort === "checkin"
      ? f.period === "upcoming" || f.period === "current"
        ? "b.checkin ASC, b.id ASC"
        : "b.checkin DESC, b.id DESC"
      : "b.created_at DESC, b.id DESC";
  const sql = `${BOOKING_JOIN}${where.length ? " WHERE " + where.join(" AND ") : ""}
    ORDER BY ${order} LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapBooking);
}

/** Résas non annulées qui intersectent une fenêtre (planning, stats, iCal). */
export async function bookingsInWindow(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  to: IsoDate,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `${BOOKING_JOIN}
        WHERE u.property_id = ?1 AND b.status != 'cancelled' AND b.checkin < ?3 AND b.checkout > ?2
        ORDER BY b.checkin`,
    )
    .bind(propertyId, from, to)
    .all();
  return (results as Raw[]).map(mapBooking);
}

export interface DirectBookingPressure {
  /** Options de paiement encore vivantes (le créneau est gelé pour ce visiteur). */
  activeHolds: number;
  /** Réservations directes lancées sur la dernière heure. */
  lastHour: number;
}

/** Pression de réservation directe d'une même identité — email OU IP appelante.
 *
 *  Le hold est posé AVANT tout paiement : sans plafond, une boucle sur les
 *  combinaisons hébergement × dates gèle tout le calendrier de vente directe
 *  (issue #6). L'IP vient de `cgv_ip`, déjà renseignée à chaque réservation
 *  publique (preuve d'acceptation des CGV) — aucune colonne nouvelle.
 *
 *  Les deux critères sont en OU : changer d'email ne suffit pas à repartir de
 *  zéro, et une IP partagée (NAT, wifi public) ne pénalise pas un visiteur qui
 *  réserve pour la première fois tant qu'il reste sous le plafond. */
export async function countDirectBookingPressure(
  db: D1Database,
  p: { email: string; ip: string | null; now?: Date },
): Promise<DirectBookingPressure> {
  const nowDate = p.now ?? new Date();
  const now = sqlNow(nowDate);
  const hourAgo = sqlNow(new Date(nowDate.getTime() - 60 * 60_000));
  const email = p.email.trim().toLowerCase();
  const ip = p.ip?.trim() || null;
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
           WHERE b.source = 'direct' AND b.status = 'pending' AND b.hold_expires_at > ?1
             AND (lower(g.email) = ?2 OR (?3 IS NOT NULL AND b.cgv_ip = ?3))) AS active_holds,
         (SELECT COUNT(*) FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
           WHERE b.source = 'direct' AND b.created_at > ?4
             AND (lower(g.email) = ?2 OR (?3 IS NOT NULL AND b.cgv_ip = ?3))) AS last_hour`,
    )
    .bind(now, email, ip, hourAgo)
    .first<{ active_holds: number; last_hour: number }>();
  return { activeHolds: num(row?.active_holds ?? 0), lastHour: num(row?.last_hour ?? 0) };
}

export type ConfirmResult = "confirmed" | "conflict" | "not_pending";

/** Confirme un hold en réservation ferme, avec LE MÊME garde-fou atomique que
 *  la création et le déplacement (en s'excluant elle-même du test de conflit).
 *
 *  Pourquoi la garde est indispensable (audit ECC 2026-07-30) : un hold expiré
 *  rouvre le créneau immédiatement, et Stripe retente une livraison de webhook
 *  pendant jusqu'à 3 jours. Sans revérification, un webhook tardif confirmait
 *  une réservation dont les dates avaient été reprises entre-temps — deux
 *  séjours confirmés sur le même créneau, sans aucune alerte.
 *
 *  'conflict' ⇒ le créneau a été pris pendant le paiement : ne rien confirmer,
 *  alerter un humain (remboursement ou relogement dans l'heure). */
export async function confirmBookingAtomic(db: D1Database, id: number, now: string = sqlNow()): Promise<ConfirmResult> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?2
        WHERE id = ?1
          AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?1
               AND b.checkin < (SELECT checkout FROM bookings WHERE id = ?1)
               AND b.checkout > (SELECT checkin FROM bookings WHERE id = ?1)
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?2))
               AND b.unit_id IN (
                 SELECT unit_id FROM bookings WHERE id = ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul
                  WHERE ul.blocks_unit_id = (SELECT unit_id FROM bookings WHERE id = ?1)
               )
          )
          AND ${manualBlockConflictSql(
            "(SELECT unit_id FROM bookings WHERE id = ?1)",
            "(SELECT checkin FROM bookings WHERE id = ?1)",
            "(SELECT checkout FROM bookings WHERE id = ?1)",
          )}`,
    )
    .bind(id, now)
    .run();
  if (res.meta.changes === 1) return "confirmed";
  const row = await db.prepare("SELECT status FROM bookings WHERE id = ?1").bind(id).first<{ status: string }>();
  return row?.status === "pending" ? "conflict" : "not_pending";
}

export async function cancelBooking(db: D1Database, id: number, reason: string, now: string = sqlNow()): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?3, cancel_reason = ?2, updated_at = ?3
        WHERE id = ?1 AND status != 'cancelled'`,
    )
    .bind(id, reason, now)
    .run();
  return res.meta.changes === 1;
}

export async function updateBookingNotes(db: D1Database, id: number, internalNotes: string, now: string = sqlNow()): Promise<void> {
  await db.prepare("UPDATE bookings SET internal_notes = ?2, updated_at = ?3 WHERE id = ?1").bind(id, internalNotes, now).run();
}

/** Annule les options de paiement expirées (filet de sécurité du cron ; la
 *  disponibilité ne dépend PAS de ce nettoyage — les holds expirés sont déjà
 *  ignorés par la clause de conflit et par isActiveBooking). */
export async function expireStaleHolds(db: D1Database, now: string = sqlNow()): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1, cancel_reason = 'hold_expired', updated_at = ?1
        WHERE status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?1`,
    )
    .bind(now)
    .run();
  return res.meta.changes;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface GuestInput {
  email?: string | null;
  firstName?: string | null;
  lastName: string;
  phone?: string | null;
  address?: string | null;
  country?: string | null;
  lang?: string | null;
  notes?: string | null;
  /** true = consentement marketing donné maintenant (jamais rétrogradé ici). */
  marketingOptIn?: boolean;
}

/** Crée ou retrouve un client. Dédoublonnage par email (insensible à la casse). */
export async function upsertGuest(db: D1Database, g: GuestInput): Promise<number> {
  const email = g.email?.trim().toLowerCase() || null;
  // L'opt-in ne se donne que positivement ici : une résa sans case cochée ne
  // retire jamais un consentement déjà enregistré (le retrait = action admin).
  const optIn = g.marketingOptIn === true ? 1 : 0;
  if (email) {
    const existing = await db.prepare("SELECT id FROM guests WHERE lower(email) = ?1").bind(email).first<{ id: number }>();
    if (existing) {
      await db
        .prepare(
          `UPDATE guests SET first_name = COALESCE(?2, first_name), last_name = COALESCE(?3, last_name),
                             phone = COALESCE(?4, phone), address = COALESCE(?5, address),
                             country = COALESCE(?6, country), lang = COALESCE(?7, lang),
                             marketing_opt_in = MAX(marketing_opt_in, ?8),
                             marketing_opt_in_at = CASE WHEN ?8 = 1 AND marketing_opt_in = 0
                                                        THEN datetime('now') ELSE marketing_opt_in_at END
            WHERE id = ?1`,
        )
        .bind(existing.id, g.firstName ?? null, g.lastName ?? null, g.phone ?? null, g.address ?? null, g.country ?? null, g.lang ?? null, optIn)
        .run();
      return existing.id;
    }
  }
  const res = await db
    .prepare(
      `INSERT INTO guests (email, first_name, last_name, phone, address, country, lang, notes, marketing_opt_in, marketing_opt_in_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 'fr'), ?8, ?9, CASE WHEN ?9 = 1 THEN datetime('now') ELSE NULL END)`,
    )
    .bind(email, g.firstName ?? null, g.lastName, g.phone ?? null, g.address ?? null, g.country ?? null, g.lang ?? null, g.notes ?? null, optIn)
    .run();
  return res.meta.last_row_id;
}

/** Trace l'acceptation des CGV sur la résa (preuve : version + horodatage + IP). */
export async function recordCgvAcceptance(
  db: D1Database,
  bookingId: number,
  p: { version: string; ip: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE bookings SET cgv_version = ?2, cgv_accepted_at = datetime('now'), cgv_ip = ?3 WHERE id = ?1")
    .bind(bookingId, p.version, p.ip)
    .run();
}

export interface GuestRow {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string;
  phone: string | null;
  address: string | null;
  country: string | null;
  lang: string;
  notes: string | null;
  createdAt: string;
  bookingsCount?: number;
  totalSpentCents?: number;
}

export async function listGuests(db: D1Database, search?: string): Promise<GuestRow[]> {
  const base = `
    SELECT g.*, COUNT(b.id) AS bookings_count, COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.total_cents ELSE 0 END), 0) AS total_spent
      FROM guests g LEFT JOIN bookings b ON b.guest_id = g.id`;
  const core = search ? phoneCore(search) : null;
  const phone = core ? ` OR ${sqlPhoneDigits("g.phone")} LIKE ?2` : "";
  const stmt = search
    ? db
        .prepare(`${base} WHERE g.last_name LIKE ?1 OR g.first_name LIKE ?1 OR g.email LIKE ?1${phone} GROUP BY g.id ORDER BY g.last_name`)
        .bind(`%${search}%`, ...(core ? [`%${core}%`] : []))
    : db.prepare(`${base} GROUP BY g.id ORDER BY g.last_name`);
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), email: strOrNull(r.email), firstName: strOrNull(r.first_name), lastName: str(r.last_name),
    phone: strOrNull(r.phone), address: strOrNull(r.address), country: strOrNull(r.country),
    lang: str(r.lang), notes: strOrNull(r.notes), createdAt: str(r.created_at),
    bookingsCount: num(r.bookings_count), totalSpentCents: num(r.total_spent),
  }));
}

export async function getGuest(db: D1Database, id: number): Promise<GuestRow | null> {
  const row = await db.prepare("SELECT * FROM guests WHERE id = ?1").bind(id).first();
  if (!row) return null;
  const r = row as Raw;
  return {
    id: num(r.id), email: strOrNull(r.email), firstName: strOrNull(r.first_name), lastName: str(r.last_name),
    phone: strOrNull(r.phone), address: strOrNull(r.address), country: strOrNull(r.country),
    lang: str(r.lang), notes: strOrNull(r.notes), createdAt: str(r.created_at),
  };
}

export async function updateGuest(
  db: D1Database,
  id: number,
  g: Partial<Omit<GuestInput, "lastName"> & { lastName: string }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE guests SET
         email = COALESCE(?2, email), first_name = COALESCE(?3, first_name), last_name = COALESCE(?4, last_name),
         phone = COALESCE(?5, phone), address = COALESCE(?6, address), country = COALESCE(?7, country),
         lang = COALESCE(?8, lang), notes = COALESCE(?9, notes)
        WHERE id = ?1`,
    )
    .bind(
      id, g.email ?? null, g.firstName ?? null, g.lastName ?? null, g.phone ?? null,
      g.address ?? null, g.country ?? null, g.lang ?? null, g.notes ?? null,
    )
    .run();
}

export async function bookingsForGuest(db: D1Database, guestId: number): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.guest_id = ?1 ORDER BY b.checkin DESC`)
    .bind(guestId)
    .all();
  return (results as Raw[]).map(mapBooking);
}

export async function updateProperty(
  db: D1Database,
  id: number,
  p: Partial<{ name: string; address: string; commune: string; contactEmail: string; contactPhone: string }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE properties SET name = COALESCE(?2, name), address = COALESCE(?3, address),
                             commune = COALESCE(?4, commune), contact_email = COALESCE(?5, contact_email),
                             contact_phone = COALESCE(?6, contact_phone)
        WHERE id = ?1`,
    )
    .bind(id, p.name ?? null, p.address ?? null, p.commune ?? null, p.contactEmail ?? null, p.contactPhone ?? null)
    .run();
}

// ---------------------------------------------------------------------------
// Paiements
// ---------------------------------------------------------------------------

export interface PaymentInput {
  bookingId: number;
  kind: "deposit" | "balance" | "full" | "refund" | "manual";
  method: "stripe" | "transfer" | "cash" | "other";
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "refunded";
  stripeSessionId?: string | null;
  stripePaymentIntent?: string | null;
  note?: string | null;
  receivedAt?: string | null;
}

export async function addPayment(db: D1Database, p: PaymentInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO payments (booking_id, kind, method, amount_cents, status, stripe_session_id, stripe_payment_intent, note, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      p.bookingId, p.kind, p.method, p.amountCents, p.status,
      p.stripeSessionId ?? null, p.stripePaymentIntent ?? null, p.note ?? null, p.receivedAt ?? null,
    )
    .run();
  await recomputePaid(db, p.bookingId);
  return res.meta.last_row_id;
}

/** Recalcule le dénormalisé bookings.paid_cents (somme des paiements réussis). */
export async function recomputePaid(db: D1Database, bookingId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE bookings SET paid_cents =
         (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE booking_id = ?1 AND status = 'succeeded')
       WHERE id = ?1`,
    )
    .bind(bookingId)
    .run();
}

/** Note portée par un paiement dont la session de checkout a expiré sans être
 *  payée (issue #69). Pourquoi une NOTE et pas un statut `expired` : la colonne
 *  `payments.status` porte un CHECK (`pending`/`succeeded`/`failed`/`refunded`)
 *  et SQLite ne sait pas modifier un CHECK sans reconstruire la table. Le
 *  webhook Stripe `checkout.session.expired` marquait DÉJÀ ces paiements
 *  `failed` — on garde ce statut (une session morte n'est plus en attente) et
 *  la note en donne la raison, exposée en `expired` pour l'affichage. */
export const EXPIRED_SESSION_NOTE = "session de paiement expirée";

/** Note d'une session fermée parce que le client en a ouvert une nouvelle pour
 *  le même montant (reclic, second onglet). Distincte de la précédente : ce
 *  n'est pas le temps qui l'a tuée, c'est le client lui-même. */
export const SUPERSEDED_SESSION_NOTE = "session remplacée par une nouvelle";

export interface PaymentRow {
  id: number;
  bookingId: number;
  kind: string;
  method: string;
  amountCents: number;
  currency: string;
  stripeSessionId: string | null;
  stripePaymentIntent: string | null;
  status: string;
  /** Pourquoi ce paiement est `failed`. `null` = un vrai échec de paiement
   *  (carte refusée) ; sinon la session a été abandonnée ou remplacée, ce qui
   *  ne se lit pas du tout pareil dans la vue Paiements. */
  outcome: "expired" | "superseded" | null;
  note: string | null;
  receivedAt: string | null;
  createdAt: string;
  bookingReference?: string;
}

function paymentOutcome(status: string, note: string | null): PaymentRow["outcome"] {
  if (status !== "failed") return null;
  if (note === EXPIRED_SESSION_NOTE) return "expired";
  if (note === SUPERSEDED_SESSION_NOTE) return "superseded";
  return null;
}

function mapPayment(r: Raw): PaymentRow {
  const note = strOrNull(r.note);
  return {
    id: num(r.id), bookingId: num(r.booking_id), kind: str(r.kind), method: str(r.method),
    amountCents: num(r.amount_cents), currency: str(r.currency),
    stripeSessionId: strOrNull(r.stripe_session_id), stripePaymentIntent: strOrNull(r.stripe_payment_intent),
    status: str(r.status), outcome: paymentOutcome(str(r.status), note),
    note, receivedAt: strOrNull(r.received_at), createdAt: str(r.created_at),
    bookingReference: strOrNull(r.booking_reference) ?? undefined,
  };
}

export async function listPayments(db: D1Database, f: { bookingId?: number; propertyId?: number } = {}): Promise<PaymentRow[]> {
  const base = "SELECT p.*, b.reference AS booking_reference FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id";
  let stmt: D1PreparedStatement;
  if (f.bookingId) {
    stmt = db.prepare(`${base} WHERE p.booking_id = ?1 ORDER BY p.created_at DESC`).bind(f.bookingId);
  } else if (f.propertyId) {
    stmt = db.prepare(`${base} WHERE u.property_id = ?1 ORDER BY p.created_at DESC LIMIT 500`).bind(f.propertyId);
  } else {
    stmt = db.prepare(`${base} ORDER BY p.created_at DESC LIMIT 500`);
  }
  const { results } = await stmt.all();
  return (results as Raw[]).map(mapPayment);
}

export async function findPaymentBySession(db: D1Database, sessionId: string): Promise<PaymentRow | null> {
  const row = await db.prepare("SELECT * FROM payments WHERE stripe_session_id = ?1").bind(sessionId).first();
  return row ? mapPayment(row as Raw) : null;
}

export async function markPaymentStatus(
  db: D1Database,
  paymentId: number,
  status: "pending" | "succeeded" | "failed" | "refunded",
  opts: { receivedAt?: string | null; stripePaymentIntent?: string | null; note?: string | null } = {},
): Promise<void> {
  const payment = await db.prepare("SELECT booking_id FROM payments WHERE id = ?1").bind(paymentId).first<{ booking_id: number }>();
  await db
    .prepare(
      `UPDATE payments SET status = ?2, received_at = COALESCE(?3, received_at),
                           stripe_payment_intent = COALESCE(?4, stripe_payment_intent),
                           note = COALESCE(?5, note)
        WHERE id = ?1`,
    )
    .bind(paymentId, status, opts.receivedAt ?? null, opts.stripePaymentIntent ?? null, opts.note ?? null)
    .run();
  if (payment) await recomputePaid(db, payment.booking_id);
}

/** Sessions de checkout restées « en attente » au-delà de leur durée de vie
 *  (issue #69). Filet de sécurité du webhook `checkout.session.expired`, qui
 *  n'existe pas en mode stub et qui peut se perdre : sans ça, chaque tunnel
 *  abandonné laisse une ligne « en attente » indéfiniment dans la vue Paiements.
 *
 *  Deux garde-fous :
 *  - seuls les paiements `stripe` en `pending` sont touchés — un encaissement
 *    manuel est créé directement en `succeeded`, il ne peut pas tomber ici ;
 *  - `recomputePaid` n'est pas nécessaire : ces paiements n'ont jamais été
 *    comptés (`paid_cents` ne somme que les `succeeded`).
 *
 *  Un webhook tardif reste honoré : `handlePaymentSuccess` ne sort par le haut
 *  que sur un paiement DÉJÀ `succeeded`, jamais sur un `failed`. */
export async function expireStalePaymentSessions(
  db: D1Database,
  olderThan: string,
): Promise<{ id: number; bookingId: number; amountCents: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, booking_id, amount_cents FROM payments
        WHERE status = 'pending' AND method = 'stripe' AND created_at <= ?1`,
    )
    .bind(olderThan)
    .all();
  const candidates = (results as Raw[]).map((r) => ({
    id: num(r.id), bookingId: num(r.booking_id), amountCents: num(r.amount_cents),
  }));
  // `meta.changes` fait foi, pas le SELECT : un webhook qui aboutit entre les
  // deux requêtes fait passer le paiement en `succeeded`, l'UPDATE conditionnel
  // ne le touche pas — et il ne doit pas non plus être journalisé « expiré »
  // (contre-review 2026-08-28).
  const expired: { id: number; bookingId: number; amountCents: number }[] = [];
  for (const p of candidates) {
    const res = await db
      .prepare("UPDATE payments SET status = 'failed', note = COALESCE(note, ?2) WHERE id = ?1 AND status = 'pending'")
      .bind(p.id, EXPIRED_SESSION_NOTE)
      .run();
    if (res.meta.changes > 0) expired.push(p);
  }
  return expired;
}

/** Déplace une résa iCal sur de nouvelles dates, avec le MÊME garde-fou
 *  atomique que la création (en s'excluant elle-même du test de conflit).
 *  meta.changes === 0 ⇒ conflit, les dates existantes sont conservées. */
/** Change les dates d'une réservation SANS la déplacer. `AND unit_id = ?1`
 *  n'est pas décoratif : sans lui, un appelant qui se tromperait d'unité ferait
 *  tester le conflit sur une unité et écrire sur une autre — la garde
 *  s'appliquerait au mauvais calendrier (contre-review Gemini, 2026-08-28).
 *  Pour changer d'unité, c'est `moveBookingAtomic`. */
export async function updateBookingDatesAtomic(
  db: D1Database,
  id: number,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`updateBookingDatesAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings SET checkin = ?3, checkout = ?4, updated_at = ?5
        WHERE id = ?2
          AND unit_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )
          AND ${manualBlockConflictSql("?1", "?3", "?4")}`,
    )
    .bind(unitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

/** Déplace une résa vers un AUTRE logement (et éventuellement d'autres dates),
 *  avec le MÊME garde-fou atomique que la création — la disponibilité est
 *  vérifiée sur le logement de DESTINATION, liaisons comprises.
 *
 *  Sans cette opération, une réservation déplacée d'une maison à l'autre côté
 *  canal restait chez nous sur l'ancienne : les deux calendriers devenaient
 *  faux d'un coup (l'ancien bloqué à tort, le nouveau vendu deux fois) et rien
 *  ne le signalait, la comparaison ne portant que sur les dates (issue #19).
 *
 *  false ⇒ le créneau de destination est déjà pris : on ne force RIEN, la résa
 *  reste où elle est et l'appelant remonte une alerte. */
export async function moveBookingAtomic(
  db: D1Database,
  id: number,
  toUnitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`moveBookingAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings SET unit_id = ?1, checkin = ?3, checkout = ?4, updated_at = ?5
        WHERE id = ?2
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )
          AND ${manualBlockConflictSql("?1", "?3", "?4")}`,
    )
    .bind(toUnitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

export interface BookingStayPatch {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  totalCents: number;
  depositCents: number;
  balanceDueDate: IsoDate | null;
  quoteJson: string | null;
  optionsJson: string | null;
  promoCode: string | null;
}

export type UpdateStayResult = "updated" | "conflict" | "not_modifiable";

/** Modifier un séjour (dates ET/OU logement) sans annuler-recréer — issue #73.
 *
 *  Une SEULE instruction : l'ancien créneau est libéré et le nouveau pris par
 *  le même `UPDATE`, sous le MÊME garde-fou que la création (réservations
 *  actives + blocages manuels, liaisons comprises). Il n'existe donc à aucun
 *  instant un état où la réservation occupe les deux créneaux, ni aucun où
 *  elle n'en occupe aucun — et deux modifications concurrentes vers le même
 *  créneau ne peuvent pas passer toutes les deux.
 *
 *  Annuler puis recréer aurait rouvert le créneau d'origine le temps de la
 *  bascule : un autre client pouvait le prendre, et la réservation modifiée se
 *  retrouvait sans logement — en ayant perdu au passage ses paiements et sa
 *  preuve d'acceptation des CGV.
 *
 *  Ce qui n'est PAS touché, et c'est le point : `paid_cents`, les lignes de
 *  `payments`, `cgv_version` / `cgv_accepted_at` / `cgv_ip`, `reference`,
 *  `guest_id`, `status`, `source`, `external_uid`.
 *
 *  'conflict' ⇒ le créneau visé est pris : RIEN n'a bougé, la réservation
 *  d'origine reste intacte sur ses dates.
 *
 *  'not_modifiable' ⇒ annulée, ou option de paiement expirée. Déplacer une
 *  réservation qui n'occupe plus rien donnerait à l'admin l'illusion d'un
 *  créneau tenu, alors que le premier venu peut le prendre (contre-review
 *  Gemini, 2026-08-28). */
export async function updateBookingStayAtomic(
  db: D1Database,
  id: number,
  patch: BookingStayPatch,
  now: string = sqlNow(),
): Promise<UpdateStayResult> {
  if (!isIsoDate(patch.checkin) || !isIsoDate(patch.checkout) || patch.checkin >= patch.checkout) {
    throw new Error(`updateBookingStayAtomic: dates invalides ${patch.checkin} → ${patch.checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings
          SET unit_id = ?1, checkin = ?3, checkout = ?4, adults = ?6, children = ?7,
              total_cents = ?8, deposit_cents = ?9, balance_due_date = ?10,
              quote_json = ?11, options_json = ?12, promo_code = ?13, updated_at = ?5
        WHERE id = ?2
          AND (status = 'confirmed' OR (status = 'pending' AND hold_expires_at > ?5))
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )
          AND ${manualBlockConflictSql("?1", "?3", "?4")}`,
    )
    .bind(
      patch.unitId,           // ?1
      id,                     // ?2
      patch.checkin,          // ?3
      patch.checkout,         // ?4
      now,                    // ?5
      patch.adults,           // ?6
      patch.children,         // ?7
      patch.totalCents,       // ?8
      patch.depositCents,     // ?9
      patch.balanceDueDate,   // ?10
      patch.quoteJson,        // ?11
      patch.optionsJson,      // ?12
      patch.promoCode,        // ?13
    )
    .run();
  if (res.meta.changes === 1) return "updated";
  const row = await db
    .prepare("SELECT status, hold_expires_at FROM bookings WHERE id = ?1")
    .bind(id)
    .first<{ status: string; hold_expires_at: string | null }>();
  const occupies =
    row?.status === "confirmed" || (row?.status === "pending" && !!row.hold_expires_at && row.hold_expires_at > now);
  return occupies ? "conflict" : "not_modifiable";
}

/** Réservations ACTIVES qui occupent un créneau sur un logement (liaisons
 *  comprises) — la même condition que le garde-fou d'insertion, mais en
 *  lecture. Sert à nommer le coupable quand une synchronisation échoue :
 *  « conflit » est inexploitable, « conflit avec la résa directe MDS-2026-014 »
 *  se tranche. */
export async function blockingBookings(
  db: D1Database,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
  excludeId?: number,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `${BOOKING_JOIN}
        WHERE b.id != ?5
          AND b.checkin < ?3
          AND b.checkout > ?2
          AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?4))
          AND b.unit_id IN (
            SELECT ?1
            UNION ALL
            SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
          )
        ORDER BY b.checkin`,
    )
    .bind(unitId, checkin, checkout, now, excludeId ?? -1)
    .all();
  return (results as Raw[]).map(mapBooking);
}

/** Réactive une résa externe annulée (le canal l'a rouverte), sur ses dates ou
 *  sur de nouvelles, avec le MÊME garde-fou atomique que la création.
 *  false ⇒ le créneau a été repris entre-temps : on ne force rien, l'appelant
 *  journalise une alerte. Réactiver au lieu de ré-insérer est ce qui évite la
 *  violation de l'unicité d'external_uid (issue #18). */
export async function reactivateBookingAtomic(
  db: D1Database,
  id: number,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`reactivateBookingAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings
          SET status = 'confirmed', checkin = ?3, checkout = ?4, hold_expires_at = NULL,
              cancelled_at = NULL, cancel_reason = NULL, updated_at = ?5
        WHERE id = ?2
          AND unit_id = ?1
          AND status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )
          AND ${manualBlockConflictSql("?1", "?3", "?4")}`,
    )
    .bind(unitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Blocages manuels (issue #74) — travaux, usage personnel, entretien.
//
// Ce n'est PAS une réservation : rien dans `bookings`, donc rien dans les
// statistiques de vente, les exports comptables ni les relances de solde, qui
// ne lisent que cette table-là. Mais c'est la même occupation de stock : la
// clause `manualBlockConflictSql` est consultée par les cinq écritures
// atomiques, avec la même expansion par `unit_links`.
// ---------------------------------------------------------------------------

export interface ManualBlockRow {
  id: number;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  checkin: IsoDate;
  checkout: IsoDate;
  reason: string;
  createdBy: string;
  active: boolean;
  releasedAt: string | null;
  releasedBy: string | null;
  createdAt: string;
  /** Événement d'agenda externe que ce blocage représente (« feed<id>:<UID> »),
   *  posé par l'import des agendas Google (migration 0028). */
  externalUid: string | null;
}

function mapManualBlock(r: Raw): ManualBlockRow {
  return {
    id: num(r.id),
    unitId: num(r.unit_id),
    unitName: strOrNull(r.unit_name) ?? undefined,
    propertyId: r.property_id == null ? undefined : num(r.property_id),
    checkin: str(r.checkin),
    checkout: str(r.checkout),
    reason: str(r.reason),
    createdBy: str(r.created_by),
    active: num(r.active) === 1,
    releasedAt: strOrNull(r.released_at),
    releasedBy: strOrNull(r.released_by),
    createdAt: str(r.created_at),
    externalUid: strOrNull(r.external_uid),
  };
}

const MANUAL_BLOCK_JOIN = `
  SELECT k.*, u.name AS unit_name, u.property_id AS property_id
    FROM manual_blocks k
    JOIN units u ON u.id = k.unit_id`;

export interface CreateManualBlockInput {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  reason: string;
  createdBy: string;
  /** Événement d'agenda externe représenté (import agenda Google). */
  externalUid?: string | null;
  /** Réservation que ce blocage REMPLACE (import agenda : la « Busy » du même
   *  événement) : ignorée par le garde, puis annulée par l'appelant. */
  replacesBookingId?: number | null;
  now?: Date;
}

export type CreateManualBlockResult =
  | { ok: true; id: number }
  | { ok: false; reason: "conflict" };

/** Pose un blocage manuel avec LE MÊME garde-fou atomique que la création
 *  d'une réservation : un seul `INSERT … SELECT … WHERE NOT EXISTS`, qui
 *  vérifie d'un coup les réservations actives ET les blocages déjà posés,
 *  liaisons comprises. Aucune fenêtre entre « est-ce libre ? » et « je pose ».
 *
 *  C'est ce qui fait qu'une course entre un blocage et une réservation sur le
 *  même créneau ne laisse jamais passer les deux. */
export async function createManualBlockAtomic(
  db: D1Database,
  input: CreateManualBlockInput,
): Promise<CreateManualBlockResult> {
  if (!isIsoDate(input.checkin) || !isIsoDate(input.checkout) || input.checkin >= input.checkout) {
    throw new Error(`createManualBlockAtomic: dates invalides ${input.checkin} → ${input.checkout}`);
  }
  const now = sqlNow(input.now ?? new Date());
  const res = await db
    .prepare(
      `INSERT INTO manual_blocks (unit_id, checkin, checkout, reason, created_by, active, created_at, updated_at, external_uid)
       SELECT ?1, ?2, ?3, ?5, ?6, 1, ?4, ?4, ?7
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.checkin < ?3
            AND b.checkout > ?2
            AND b.id != ?8
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?4))
            AND b.unit_id IN (
              SELECT ?1
              UNION ALL
              SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
            )
       )
         AND ${manualBlockConflictSql("?1", "?2", "?3")}`,
    )
    .bind(input.unitId, input.checkin, input.checkout, now, input.reason, input.createdBy, input.externalUid ?? null, input.replacesBookingId ?? -1)
    .run();
  if (res.meta.changes !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, id: res.meta.last_row_id };
}

/** Déplace un blocage actif (l'événement d'agenda qu'il représente a bougé),
 *  avec le même garde-fou que sa pose — lui-même exclu. false ⇒ conflit. */
export async function moveManualBlockAtomic(
  db: D1Database,
  id: number,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`moveManualBlockAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE manual_blocks SET checkin = ?3, checkout = ?4, updated_at = ?5
        WHERE id = ?2 AND unit_id = ?1 AND active = 1
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.checkin < ?4 AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (SELECT ?1 UNION ALL SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1)
          )
          AND NOT EXISTS (
            SELECT 1 FROM manual_blocks k
             WHERE k.id != ?2 AND k.active = 1 AND k.checkin < ?4 AND k.checkout > ?3
               AND k.unit_id IN (SELECT ?1 UNION ALL SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1)
          )`,
    )
    .bind(unitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

/** Blocage (actif OU levé) qui représente cet événement d'agenda externe. */
export async function getManualBlockByExternalUid(db: D1Database, externalUid: string): Promise<ManualBlockRow | null> {
  const row = await db.prepare(`${MANUAL_BLOCK_JOIN} WHERE k.external_uid = ?1`).bind(externalUid).first();
  return row ? mapManualBlock(row as Raw) : null;
}

export async function getManualBlock(db: D1Database, id: number): Promise<ManualBlockRow | null> {
  const row = await db.prepare(`${MANUAL_BLOCK_JOIN} WHERE k.id = ?1`).bind(id).first();
  return row ? mapManualBlock(row as Raw) : null;
}

/** Blocages actifs d'un domaine qui intersectent une fenêtre — planning,
 *  disponibilité publique, export iCal, push Beds24. */
export async function manualBlocksInWindow(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  to: IsoDate,
): Promise<ManualBlockRow[]> {
  const { results } = await db
    .prepare(
      `${MANUAL_BLOCK_JOIN}
        WHERE u.property_id = ?1 AND k.active = 1 AND k.checkin < ?3 AND k.checkout > ?2
        ORDER BY k.checkin`,
    )
    .bind(propertyId, from, to)
    .all();
  return (results as Raw[]).map(mapManualBlock);
}

/** Blocages actifs qui ferment un créneau sur une unité, liaisons comprises —
 *  la même condition que le garde-fou d'insertion, mais en lecture. Sert à
 *  NOMMER le motif : « travaux salle de bains » se dit au téléphone,
 *  « indisponible » se subit. */
export async function blockingManualBlocks(
  db: D1Database,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
): Promise<ManualBlockRow[]> {
  const { results } = await db
    .prepare(
      `${MANUAL_BLOCK_JOIN}
        WHERE k.active = 1
          AND k.checkin < ?3
          AND k.checkout > ?2
          AND k.unit_id IN (
            SELECT ?1
            UNION ALL
            SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
          )
        ORDER BY k.checkin`,
    )
    .bind(unitId, checkin, checkout)
    .all();
  return (results as Raw[]).map(mapManualBlock);
}

/** Lève un blocage. Jamais de DELETE (convention du schéma) : on garde qui
 *  avait fermé quoi, pourquoi, et qui a rouvert. */
export async function releaseManualBlock(
  db: D1Database,
  id: number,
  releasedBy: string,
  now: string = sqlNow(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE manual_blocks SET active = 0, released_at = ?2, released_by = ?3, updated_at = ?2
        WHERE id = ?1 AND active = 1`,
    )
    .bind(id, now, releasedBy)
    .run();
  return res.meta.changes === 1;
}

export async function setPaymentSession(db: D1Database, paymentId: number, sessionId: string): Promise<void> {
  await db.prepare("UPDATE payments SET stripe_session_id = ?2 WHERE id = ?1").bind(paymentId, sessionId).run();
}

export async function incrementPromoUse(db: D1Database, propertyId: number, code: string): Promise<void> {
  await db
    .prepare("UPDATE promotions SET uses = uses + 1 WHERE property_id = ?1 AND kind = 'code' AND lower(code) = lower(?2)")
    .bind(propertyId, code)
    .run();
}

// ---------------------------------------------------------------------------
// CRUD référentiel (saisons, règles tarifaires, promotions, options, flux iCal)
// ---------------------------------------------------------------------------

export async function listSeasons(db: D1Database, propertyId: number): Promise<Season[]> {
  const { results } = await db
    .prepare("SELECT * FROM seasons WHERE property_id = ?1 ORDER BY date_start")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapSeason);
}

export async function createSeason(
  db: D1Database,
  propertyId: number,
  s: { name: string; dateStart: IsoDate; dateEnd: IsoDate; priority: number },
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO seasons (property_id, name, date_start, date_end, priority) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(propertyId, s.name, s.dateStart, s.dateEnd, s.priority)
    .run();
  return res.meta.last_row_id;
}

export async function updateSeason(
  db: D1Database,
  id: number,
  s: Partial<{ name: string; dateStart: IsoDate; dateEnd: IsoDate; priority: number }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE seasons SET name = COALESCE(?2, name), date_start = COALESCE(?3, date_start),
                          date_end = COALESCE(?4, date_end), priority = COALESCE(?5, priority)
        WHERE id = ?1`,
    )
    .bind(id, s.name ?? null, s.dateStart ?? null, s.dateEnd ?? null, s.priority ?? null)
    .run();
}

/** Supprime une saison ET ses règles tarifaires (sinon violation de FK). */
export async function deleteSeason(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rate_rules WHERE season_id = ?1").bind(id),
    db.prepare("DELETE FROM seasons WHERE id = ?1").bind(id),
  ]);
}

export async function listRateRules(db: D1Database, propertyId: number): Promise<(RateRule & { unitName: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, u.name AS unit_name FROM rate_rules r JOIN units u ON u.id = r.unit_id
        WHERE u.property_id = ?1 ORDER BY u.sort_order, r.season_id`,
    )
    .bind(propertyId)
    .all();
  return (results as Raw[]).map((r) => ({ ...mapRateRule(r), unitName: str(r.unit_name) }));
}

/** Une règle par son id — sert à retrouver l'unité (donc ses bornes de prix)
 *  avant d'autoriser une modification tarifaire. */
export async function getRateRule(db: D1Database, id: number): Promise<RateRule | null> {
  const row = await db.prepare("SELECT * FROM rate_rules WHERE id = ?1").bind(id).first();
  return row ? mapRateRule(row as Raw) : null;
}

export interface RateRuleInput {
  unitId: number;
  seasonId: number | null;
  priceWeekCents: number;
  priceWeekendCents: number;
  holidayPct: number;
  minNights: number;
  checkinDays: number[] | null;
}

export async function createRateRule(db: D1Database, r: RateRuleInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights, checkin_days)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      r.unitId, r.seasonId, r.priceWeekCents, r.priceWeekendCents, r.holidayPct, r.minNights,
      r.checkinDays && r.checkinDays.length > 0 ? r.checkinDays.join(",") : null,
    )
    .run();
  return res.meta.last_row_id;
}

export async function updateRateRule(db: D1Database, id: number, r: Partial<RateRuleInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE rate_rules SET
         price_week_cents = COALESCE(?2, price_week_cents),
         price_weekend_cents = COALESCE(?3, price_weekend_cents),
         holiday_pct = COALESCE(?4, holiday_pct),
         min_nights = COALESCE(?5, min_nights),
         checkin_days = ?6
        WHERE id = ?1`,
    )
    .bind(
      id, r.priceWeekCents ?? null, r.priceWeekendCents ?? null, r.holidayPct ?? null, r.minNights ?? null,
      r.checkinDays === undefined ? null : r.checkinDays && r.checkinDays.length > 0 ? r.checkinDays.join(",") : null,
    )
    .run();
}

export async function deleteRateRule(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM rate_rules WHERE id = ?1").bind(id).run();
}

// ---------------------------------------------------------------------------
// Surcharges par jour (rate_overrides — migration 0014, issue #23)
// ---------------------------------------------------------------------------

function mapRateOverride(r: Raw): RateOverride {
  return {
    unitId: num(r.unit_id),
    date: str(r.date),
    priceCents: numOrNull(r.price_cents),
    minNights: numOrNull(r.min_nights),
  };
}

/** Surcharges de plusieurs unités sur [from, toExclusive). */
export async function listRateOverrides(
  db: D1Database,
  unitIds: number[],
  from: IsoDate,
  toExclusive: IsoDate,
): Promise<RateOverride[]> {
  if (unitIds.length === 0) return [];
  const ids = [...new Set(unitIds)];
  const placeholders = ids.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM rate_overrides
        WHERE date >= ?1 AND date < ?2 AND unit_id IN (${placeholders})
        ORDER BY unit_id, date`,
    )
    .bind(from, toExclusive, ...ids)
    .all();
  return (results as Raw[]).map(mapRateOverride);
}

/** Surcharges de toutes les unités d'un domaine sur [from, toExclusive) —
 *  une seule requête pour la vue année et pour le push vers Beds24. */
export async function listRateOverridesForProperty(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  toExclusive: IsoDate,
): Promise<RateOverride[]> {
  const { results } = await db
    .prepare(
      `SELECT o.* FROM rate_overrides o JOIN units u ON u.id = o.unit_id
        WHERE u.property_id = ?1 AND o.date >= ?2 AND o.date < ?3
        ORDER BY o.unit_id, o.date`,
    )
    .bind(propertyId, from, toExclusive)
    .all();
  return (results as Raw[]).map(mapRateOverride);
}

/** Patch d'une surcharge : `undefined` laisse la valeur en place, `null` la
 *  retire. Une ligne dont les deux valeurs finissent à null est SUPPRIMÉE —
 *  retirer un prix fait revenir la saison, jamais un 0 fantôme. */
export interface RateOverridePatch {
  priceCents?: number | null;
  minNights?: number | null;
}

export interface RateOverrideWriteResult {
  /** jours effectivement porteurs d'une surcharge après l'écriture */
  written: number;
  /** jours dont la surcharge a disparu (retour à la saison) */
  cleared: number;
}

/** Applique un patch de surcharge sur une liste de jours d'UNE unité.
 *  Écriture par jour, en un seul batch : D1 sérialise, l'ensemble part groupé. */
export async function setRateOverrides(
  db: D1Database,
  unitId: number,
  dates: IsoDate[],
  patch: RateOverridePatch,
): Promise<RateOverrideWriteResult> {
  const days = [...new Set(dates)].sort();
  if (days.length === 0) return { written: 0, cleared: 0 };

  // État courant, pour distinguer « laisser en place » de « retirer ».
  const placeholders = days.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM rate_overrides WHERE unit_id = ?1 AND date IN (${placeholders})`)
    .bind(unitId, ...days)
    .all();
  const current = new Map<string, RateOverride>();
  for (const row of results as Raw[]) {
    const o = mapRateOverride(row);
    current.set(o.date, o);
  }

  const stmts: D1PreparedStatement[] = [];
  let written = 0;
  let cleared = 0;
  for (const date of days) {
    const existing = current.get(date) ?? null;
    const price = patch.priceCents === undefined ? (existing?.priceCents ?? null) : patch.priceCents;
    const minNights = patch.minNights === undefined ? (existing?.minNights ?? null) : patch.minNights;
    if (price == null && minNights == null) {
      if (existing) {
        stmts.push(db.prepare("DELETE FROM rate_overrides WHERE unit_id = ?1 AND date = ?2").bind(unitId, date));
        cleared += 1;
      }
      continue;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO rate_overrides (unit_id, date, price_cents, min_nights)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (unit_id, date) DO UPDATE SET
             price_cents = excluded.price_cents,
             min_nights = excluded.min_nights,
             updated_at = datetime('now')`,
        )
        .bind(unitId, date, price, minNights),
    );
    written += 1;
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { written, cleared };
}

/** Retire toute surcharge sur une liste de jours — retour au tarif de saison. */
export async function deleteRateOverrides(db: D1Database, unitId: number, dates: IsoDate[]): Promise<number> {
  const days = [...new Set(dates)];
  if (days.length === 0) return 0;
  const placeholders = days.map((_, i) => `?${i + 2}`).join(", ");
  const res = await db
    .prepare(`DELETE FROM rate_overrides WHERE unit_id = ?1 AND date IN (${placeholders})`)
    .bind(unitId, ...days)
    .run();
  return res.meta.changes ?? 0;
}

export async function listPromotions(db: D1Database, propertyId: number): Promise<Promotion[]> {
  const { results } = await db
    .prepare("SELECT * FROM promotions WHERE property_id = ?1 ORDER BY kind, id")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapPromotion);
}

export interface PromotionInput {
  kind: Promotion["kind"];
  code: string | null;
  label: string;
  discountPct: number | null;
  discountCents: number | null;
  threshold: number | null;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
  maxUses: number | null;
  active: boolean;
}

export async function createPromotion(db: D1Database, propertyId: number, p: PromotionInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO promotions (property_id, kind, code, label, discount_pct, discount_cents, threshold, valid_from, valid_until, max_uses, active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      propertyId, p.kind, p.code, p.label, p.discountPct, p.discountCents, p.threshold,
      p.validFrom, p.validUntil, p.maxUses, p.active ? 1 : 0,
    )
    .run();
  return res.meta.last_row_id;
}

export async function updatePromotion(db: D1Database, id: number, p: Partial<PromotionInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE promotions SET
         code = COALESCE(?2, code), label = COALESCE(?3, label),
         discount_pct = COALESCE(?4, discount_pct), discount_cents = COALESCE(?5, discount_cents),
         threshold = COALESCE(?6, threshold),
         valid_from = COALESCE(?7, valid_from), valid_until = COALESCE(?8, valid_until),
         max_uses = COALESCE(?9, max_uses),
         active = COALESCE(?10, active)
        WHERE id = ?1`,
    )
    .bind(
      id, p.code ?? null, p.label ?? null, p.discountPct ?? null, p.discountCents ?? null,
      p.threshold ?? null, p.validFrom ?? null, p.validUntil ?? null, p.maxUses ?? null,
      p.active === undefined ? null : p.active ? 1 : 0,
    )
    .run();
}

export async function deletePromotion(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM promotions WHERE id = ?1").bind(id).run();
}

export type OptionRow = OptionDef & { active: boolean; sortOrder: number; propertyId: number };

export async function listOptionsAdmin(db: D1Database, propertyId: number): Promise<OptionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM options WHERE property_id = ?1 ORDER BY sort_order, id")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapOption);
}

export interface OptionInput {
  name: string;
  pricingMode: OptionDef["pricingMode"];
  priceCents: number;
  unitLabel: string | null;
  maxQty: number | null;
  active: boolean;
  sortOrder: number;
}

export async function createOption(db: D1Database, propertyId: number, o: OptionInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO options (property_id, name, pricing_mode, price_cents, unit_label, max_qty, active, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(propertyId, o.name, o.pricingMode, o.priceCents, o.unitLabel, o.maxQty, o.active ? 1 : 0, o.sortOrder)
    .run();
  return res.meta.last_row_id;
}

export async function updateOption(db: D1Database, id: number, o: Partial<OptionInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE options SET
         name = COALESCE(?2, name), pricing_mode = COALESCE(?3, pricing_mode),
         price_cents = COALESCE(?4, price_cents), unit_label = COALESCE(?5, unit_label),
         max_qty = COALESCE(?6, max_qty), active = COALESCE(?7, active), sort_order = COALESCE(?8, sort_order)
        WHERE id = ?1`,
    )
    .bind(
      id, o.name ?? null, o.pricingMode ?? null, o.priceCents ?? null, o.unitLabel ?? null,
      o.maxQty ?? null, o.active === undefined ? null : o.active ? 1 : 0, o.sortOrder ?? null,
    )
    .run();
}

export async function deleteOption(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM options WHERE id = ?1").bind(id).run();
}

// ---------------------------------------------------------------------------
// Flux iCal entrants
// ---------------------------------------------------------------------------

export interface FeedRow {
  id: number;
  unitId: number;
  unitName?: string;
  name: string;
  url: string;
  active: boolean;
  /** Le calendrier bloque aussi le jour du départ (convention de papa) :
   *  la lecture retire un jour aux événements « journée entière ». */
  departureDayIncluded: boolean;
  lastSyncAt: string | null;
  lastStatus: string | null;
}

function mapFeed(r: Raw): FeedRow {
  return {
    id: num(r.id), unitId: num(r.unit_id), unitName: strOrNull(r.unit_name) ?? undefined,
    name: str(r.name), url: str(r.url), active: num(r.active) === 1,
    departureDayIncluded: num(r.departure_day_included ?? 0) === 1,
    lastSyncAt: strOrNull(r.last_sync_at), lastStatus: strOrNull(r.last_status),
  };
}

export async function listFeeds(db: D1Database, onlyActive = false): Promise<FeedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, u.name AS unit_name FROM ical_feeds f JOIN units u ON u.id = f.unit_id
        ${onlyActive ? "WHERE f.active = 1" : ""} ORDER BY f.id`,
    )
    .all();
  return (results as Raw[]).map(mapFeed);
}

export async function getFeed(db: D1Database, id: number): Promise<FeedRow | null> {
  const row = await db
    .prepare("SELECT f.*, u.name AS unit_name FROM ical_feeds f JOIN units u ON u.id = f.unit_id WHERE f.id = ?1")
    .bind(id)
    .first();
  return row ? mapFeed(row as Raw) : null;
}

export async function createFeed(
  db: D1Database,
  f: { unitId: number; name: string; url: string; departureDayIncluded?: boolean },
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO ical_feeds (unit_id, name, url, departure_day_included) VALUES (?1, ?2, ?3, ?4)")
    .bind(f.unitId, f.name, f.url, f.departureDayIncluded ? 1 : 0)
    .run();
  return res.meta.last_row_id;
}

export async function updateFeed(
  db: D1Database,
  id: number,
  f: Partial<{ name: string; url: string; active: boolean; departureDayIncluded: boolean }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ical_feeds SET name = COALESCE(?2, name), url = COALESCE(?3, url), active = COALESCE(?4, active),
         departure_day_included = COALESCE(?5, departure_day_included) WHERE id = ?1`,
    )
    .bind(
      id, f.name ?? null, f.url ?? null, f.active === undefined ? null : f.active ? 1 : 0,
      f.departureDayIncluded === undefined ? null : f.departureDayIncluded ? 1 : 0,
    )
    .run();
}

export async function deleteFeed(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM ical_feeds WHERE id = ?1").bind(id).run();
}

export async function setFeedStatus(db: D1Database, id: number, status: string, at: string = sqlNow()): Promise<void> {
  await db.prepare("UPDATE ical_feeds SET last_sync_at = ?2, last_status = ?3 WHERE id = ?1").bind(id, at, status).run();
}

/** Résas iCal actives d'un flux (pour la réconciliation import). */
export async function listFeedBookings(db: D1Database, feedId: number): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.source = 'ical' AND b.external_uid LIKE ?1 AND b.status != 'cancelled'`)
    .bind(`feed${feedId}:%`)
    .all();
  return (results as Raw[]).map(mapBooking);
}

/** Résa portant cet external_uid, ANNULÉES COMPRISES (la contrainte d'unicité
 *  rend le résultat unique). Les listes de réconciliation ci-dessus filtrent
 *  les annulées : sans cette recherche, une résa externe rouverte par le canal
 *  repartait sur une création et cassait l'unicité (issue #18). */
export async function getBookingByExternalUid(db: D1Database, externalUid: string): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.external_uid = ?1`).bind(externalUid).first();
  return row ? mapBooking(row as Raw) : null;
}

/** Résas rapatriées de Beds24 (canaux OTA) — external_uid 'beds24:<id>'. */
export async function listBeds24Bookings(db: D1Database): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.external_uid LIKE 'beds24:%' AND b.status != 'cancelled'`)
    .all();
  return (results as Raw[]).map(mapBooking);
}

// ---------------------------------------------------------------------------
// Messages — les échanges clients vivent dans la plateforme.
// direction 'in' (client) / 'out' (équipe) · channel 'email' / 'form' / 'beds24'
// ('beds24' = message d'un canal OTA relevé par le cron, cf. services/beds24-messages.ts)
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: number;
  propertyId: number | null;
  messageId: string | null;
  direction: "in" | "out";
  channel: "email" | "form" | "beds24";
  /** Canal d'origine d'un message 'beds24' (« Airbnb », « Booking.com »…), sinon null. */
  canal: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string;
  bodyText: string;
  bookingId: number | null;
  bookingReference: string | null;
  guestId: number | null;
  status: "nouveau" | "traité";
  autoReplied: boolean;
  forwarded: boolean;
  delivery: string | null;
  receivedAt: string;
  /** Message-ID auquel ce mail répond (relève IMAP). */
  inReplyTo: string | null;
  /** En-tête References (fil), identifiants <…> séparés par une espace. */
  refs: string | null;
  /** Pièces jointes listées à la relève (jamais stockées). */
  attachments: { name: string; size: number | null }[];
  /** Le mail prétend venir de l'adresse des gîtes sans que le serveur de réception l'atteste. */
  spoofed: boolean;
}

function parseAttachments(raw: unknown): { name: string; size: number | null }[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((a): a is { name: unknown; size?: unknown } => !!a && typeof a === "object")
      .map((a) => ({ name: String(a.name ?? "").slice(0, 200), size: typeof a.size === "number" ? a.size : null }));
  } catch {
    return [];
  }
}

function mapMessage(r: Raw): MessageRow {
  return {
    id: num(r.id), propertyId: numOrNull(r.property_id), messageId: strOrNull(r.message_id),
    direction: str(r.direction) === "out" ? "out" : "in",
    channel: str(r.channel) === "form" ? "form" : str(r.channel) === "beds24" ? "beds24" : "email",
    canal: str(r.channel) === "beds24" ? strOrNull(r.canal) ?? "Canal Beds24" : null,
    fromEmail: str(r.from_email), fromName: strOrNull(r.from_name), toEmail: strOrNull(r.to_email),
    subject: str(r.subject), bodyText: str(r.body_text),
    bookingId: numOrNull(r.booking_id), bookingReference: strOrNull(r.booking_reference),
    guestId: numOrNull(r.guest_id),
    status: str(r.status) === "traité" ? "traité" : "nouveau",
    autoReplied: num(r.auto_replied) === 1, forwarded: num(r.forwarded) === 1,
    delivery: strOrNull(r.delivery),
    receivedAt: str(r.received_at),
    inReplyTo: strOrNull(r.in_reply_to),
    refs: strOrNull(r.refs),
    attachments: parseAttachments(r.attachments),
    spoofed: num(r.spoofed) === 1,
  };
}

const MESSAGE_JOIN = `SELECT e.*, b.reference AS booking_reference,
           (SELECT cm.channel_label FROM channel_messages cm WHERE cm.message_id = e.id LIMIT 1) AS canal
    FROM messages e LEFT JOIN bookings b ON b.id = e.booking_id`;

export async function listMessages(
  db: D1Database,
  f: { propertyId?: number; status?: string; direction?: string; bookingId?: number; limit?: number } = {},
): Promise<MessageRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };
  if (f.propertyId) push("e.property_id = ?", f.propertyId);
  if (f.status) push("e.status = ?", f.status);
  if (f.direction) push("e.direction = ?", f.direction);
  if (f.bookingId) push("e.booking_id = ?", f.bookingId);
  const sql = `${MESSAGE_JOIN} ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY e.id DESC LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapMessage);
}

/** Fil de conversation : tous les messages du même client OU de la même résa,
 *  du plus ancien au plus récent. */
export async function getThread(
  db: D1Database,
  ref: { bookingId?: number | null; guestId?: number | null; email?: string | null },
): Promise<MessageRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (ref.bookingId) {
    binds.push(ref.bookingId);
    clauses.push(`e.booking_id = ?${binds.length}`);
  }
  if (ref.guestId) {
    binds.push(ref.guestId);
    clauses.push(`e.guest_id = ?${binds.length}`);
  }
  if (ref.email) {
    binds.push(ref.email.toLowerCase());
    clauses.push(`lower(e.from_email) = ?${binds.length}`);
    binds.push(ref.email.toLowerCase());
    clauses.push(`lower(e.to_email) = ?${binds.length}`);
  }
  if (clauses.length === 0) return [];
  const sql = `${MESSAGE_JOIN} WHERE ${clauses.join(" OR ")} ORDER BY e.id ASC LIMIT 300`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapMessage);
}

export interface InboundMessageInput {
  propertyId: number;
  messageId?: string | null;
  channel: "email" | "form";
  fromEmail: string;
  fromName?: string | null;
  toEmail?: string | null;
  subject: string;
  bodyText: string;
  bookingId?: number | null;
  guestId?: number | null;
  receivedAt?: string;
  /** Relève IMAP : fil, UID, pièces listées, expéditeur douteux. */
  inReplyTo?: string | null;
  references?: string | null;
  imapUid?: number | null;
  attachments?: { name: string; size: number | null }[];
  spoofed?: boolean;
}

/** Insère un message entrant. Retourne null si doublon (Message-ID). */
export async function insertInboundMessage(db: D1Database, m: InboundMessageInput): Promise<number | null> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO messages (property_id, message_id, direction, channel, from_email, from_name,
                               to_email, subject, body_text, booking_id, guest_id, received_at,
                               in_reply_to, refs, imap_uid, attachments, spoofed)
         VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, datetime('now')),
                 ?12, ?13, ?14, ?15, ?16)`,
      )
      .bind(
        m.propertyId, m.messageId ?? null, m.channel, m.fromEmail, m.fromName ?? null,
        m.toEmail ?? null, m.subject, m.bodyText, m.bookingId ?? null, m.guestId ?? null,
        m.receivedAt ?? null,
        m.inReplyTo ?? null, m.references ?? null, m.imapUid ?? null,
        m.attachments && m.attachments.length ? JSON.stringify(m.attachments) : null,
        m.spoofed ? 1 : 0,
      )
      .run();
    return res.meta.last_row_id;
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) return null;
    throw e;
  }
}

/** Insère une réponse de l'équipe (direction 'out', déjà « traitée »). */
export async function insertOutboundMessage(
  db: D1Database,
  m: {
    propertyId: number;
    toEmail: string | null;
    fromEmail: string | null;
    subject: string;
    bodyText: string;
    bookingId?: number | null;
    guestId?: number | null;
    delivery: string; // 'aucune' | 'stub' | 'sent' | 'failed'
    /** 'email' : réponse à un mail (reste dans le fil de la boîte de contact), sinon 'form'. */
    channel?: "email" | "form";
    /** Message-ID SMTP du mail parti : la réponse du client (In-Reply-To) le retrouve. */
    messageId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
  },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO messages (property_id, message_id, direction, channel, from_email, to_email, subject,
                             body_text, booking_id, guest_id, status, delivery, in_reply_to, refs)
       VALUES (?1, ?9, 'out', ?10, ?2, ?3, ?4, ?5, ?6, ?7, 'traité', ?8, ?11, ?12)`,
    )
    .bind(
      m.propertyId, m.fromEmail ?? "équipe", m.toEmail, m.subject, m.bodyText,
      m.bookingId ?? null, m.guestId ?? null, m.delivery,
      m.messageId ?? null, m.channel ?? "form", m.inReplyTo ?? null, m.references ?? null,
    )
    .run();
  return res.meta.last_row_id;
}

export async function markMessage(db: D1Database, id: number, status: "nouveau" | "traité"): Promise<void> {
  await db.prepare("UPDATE messages SET status = ?2 WHERE id = ?1").bind(id, status).run();
}

export async function getMessage(db: D1Database, id: number): Promise<MessageRow | null> {
  const row = await db.prepare(`${MESSAGE_JOIN} WHERE e.id = ?1`).bind(id).first();
  return row ? mapMessage(row as Raw) : null;
}

export async function countNewMessages(db: D1Database, propertyId?: number): Promise<number> {
  const stmt = propertyId
    ? db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau' AND direction = 'in' AND property_id = ?1").bind(propertyId)
    : db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau' AND direction = 'in'");
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Journaux (emails, audit)
// ---------------------------------------------------------------------------

export interface EmailLogRow {
  id: number;
  bookingId: number | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  kind: string;
  status: string;
  /** Message d'erreur du fournisseur quand `status = 'failed'` (migration 0011).
   *  Affiché sur la fiche réservation : « échoué » sans motif n'aide personne. */
  errorDetail: string | null;
  /** Pièces jointes du message, nom et taille (migration 0030). Vide = aucune. */
  attachments: { filename: string; bytes: number }[];
  createdAt: string;
}

function parseAttachmentsLog(v: unknown): { filename: string; bytes: number }[] {
  if (typeof v !== "string" || v === "") return [];
  try {
    const list = JSON.parse(v) as { filename?: unknown; bytes?: unknown }[];
    return list.map((a) => ({ filename: String(a.filename ?? ""), bytes: Number(a.bytes ?? 0) }));
  } catch {
    return [];
  }
}

export async function listEmailLog(db: D1Database, bookingId?: number, limit = 100): Promise<EmailLogRow[]> {
  const stmt = bookingId
    ? db.prepare("SELECT * FROM email_log WHERE booking_id = ?1 ORDER BY id DESC LIMIT ?2").bind(bookingId, limit)
    : db.prepare("SELECT * FROM email_log ORDER BY id DESC LIMIT ?1").bind(limit);
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), bookingId: numOrNull(r.booking_id), toEmail: str(r.to_email), subject: str(r.subject),
    bodyText: str(r.body_text), kind: str(r.kind), status: str(r.status),
    errorDetail: r.error_detail == null ? null : str(r.error_detail),
    attachments: parseAttachmentsLog(r.attachments),
    createdAt: str(r.created_at),
  }));
}

export async function hasEmailOfKind(db: D1Database, bookingId: number, kind: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM email_log WHERE booking_id = ?1 AND kind = ?2 LIMIT 1")
    .bind(bookingId, kind)
    .first();
  return !!row;
}

/** Un mail de l'un de ces types a-t-il déjà été journalisé pour la réservation,
 *  hors envois échoués (un envoi qui a échoué peut être retenté) ? */
export async function hasEmailOfKinds(db: D1Database, bookingId: number, kinds: string[]): Promise<boolean> {
  const marks = kinds.map((_, i) => `?${i + 2}`).join(", ");
  const row = await db
    .prepare(`SELECT 1 AS one FROM email_log WHERE booking_id = ?1 AND kind IN (${marks}) AND status != 'failed' LIMIT 1`)
    .bind(bookingId, ...kinds)
    .first();
  return !!row;
}

/** Preuve d'acceptation des CGV d'une réservation (posée à la réservation en ligne). */
export async function getCgvAcceptance(
  db: D1Database,
  bookingId: number,
): Promise<{ version: string | null; acceptedAt: string | null; ip: string | null }> {
  const row = (await db
    .prepare("SELECT cgv_version, cgv_accepted_at, cgv_ip FROM bookings WHERE id = ?1")
    .bind(bookingId)
    .first()) as Raw | null;
  return { version: strOrNull(row?.cgv_version), acceptedAt: strOrNull(row?.cgv_accepted_at), ip: strOrNull(row?.cgv_ip) };
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  detail: string | null;
  createdAt: string;
}

export async function listAudit(db: D1Database, limit = 200): Promise<AuditRow[]> {
  const { results } = await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), actor: str(r.actor), action: str(r.action),
    entity: strOrNull(r.entity), detail: strOrNull(r.detail), createdAt: str(r.created_at),
  }));
}

/** Journal d'une entité précise (ex. 'booking:42') — historique de la fiche
 *  réservation du back-office (issue #69 : « la relance doit être visible dans
 *  l'historique, avec sa date et son auteur »). */
export async function listAuditByEntity(db: D1Database, entity: string, limit = 50): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM audit_log WHERE entity = ?1 ORDER BY id DESC LIMIT ?2")
    .bind(entity, limit)
    .all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), actor: str(r.actor), action: str(r.action),
    entity: strOrNull(r.entity), detail: strOrNull(r.detail), createdAt: str(r.created_at),
  }));
}

/** Journal filtré par préfixe d'action (ex. 'beds24.') — vue Canaux. */
export async function listAuditByAction(db: D1Database, prefix: string, limit = 20): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM audit_log WHERE action LIKE ?1 ORDER BY id DESC LIMIT ?2")
    .bind(`${prefix}%`, limit)
    .all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), actor: str(r.actor), action: str(r.action),
    entity: strOrNull(r.entity), detail: strOrNull(r.detail), createdAt: str(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Checklist de mise en route (page unique du back-office)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  id: number;
  section: string;
  label: string;
  owner: "papa" | "julien" | "claude";
  status: "a_faire" | "en_cours" | "fait" | "verifie" | "n_a";
  note: string | null;
  url: string | null;
  sortOrder: number;
  updatedAt: string;
}

export async function listChecklist(db: D1Database): Promise<ChecklistItem[]> {
  const { results } = await db.prepare("SELECT * FROM checklist_items ORDER BY sort_order, id").all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), section: str(r.section), label: str(r.label),
    owner: str(r.owner) as ChecklistItem["owner"],
    status: str(r.status) as ChecklistItem["status"],
    note: strOrNull(r.note), url: strOrNull(r.url),
    sortOrder: num(r.sort_order), updatedAt: str(r.updated_at),
  }));
}

export async function updateChecklistItem(
  db: D1Database,
  id: number,
  fields: { status?: ChecklistItem["status"]; note?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE checklist_items SET status = COALESCE(?2, status), note = COALESCE(?3, note),
                                  updated_at = datetime('now') WHERE id = ?1`,
    )
    .bind(id, fields.status ?? null, fields.note ?? null)
    .run();
}

// ---------------------------------------------------------------------------
// Signaux de santé (carte « Santé » du tableau de bord)
// ---------------------------------------------------------------------------

export interface HealthSignals {
  /** Paiements encaissés dont la réservation n'est PAS confirmée : le client a
   *  payé et n'a pas son séjour. À traiter dans l'heure (rembourser/reloger). */
  orphanPayments: { reference: string; bookingId: number; amountCents: number; bookingStatus: string; receivedAt: string | null }[];
  /** Réservations encaissées AU-DELÀ du total dû. Le trop-perçu ne se corrige
   *  pas tout seul : il faut rembourser. Sans ce signal, un double paiement du
   *  solde (deux sessions ouvertes, les deux payées) ne se voyait que dans le
   *  journal d'audit, que personne ne lit (contre-review 2026-08-28). */
  overpaidBookings: { reference: string; bookingId: number; overpaidCents: number; bookingStatus: string }[];
  /** Emails dont l'envoi a échoué (voucher jamais reçu, personne ne le sait).
   *  Bornés au domaine interrogé, sauf les envois sans réservation rattachée
   *  (digest quotidien) qui n'appartiennent à aucun domaine.
   *  `bookingId` porte le lien vers la fiche concernée : sans lui, l'alerte du
   *  tableau de bord nomme un échec sans dire où le rattraper (issue #48). */
  failedEmails: { bookingId: number | null; reference: string | null; kind: string; toEmail: string; createdAt: string; errorDetail: string | null }[];
  /** Erreurs techniques journalisées dans les dernières 24 h. */
  recentErrors: { action: string; entity: string | null; createdAt: string; detail: string | null }[];
  /** Dernier rapatriement Beds24 réussi — figé = calendriers OTA à la dérive. */
  beds24LastPull: string | null;
  beds24StaleHours: number | null;
  /** Dernier rapatriement COMPLET quotidien (réconciliation, issue #19), au
   *  format 'AAAA-MM-JJ' de Bruxelles. Facultatifs : la carte « Santé » sait
   *  vivre sans, et le repli neutre du back-office reste valide. */
  reconcileLastRun?: string | null;
  /** Écarts du dernier rapatriement complet qui demandent un arbitrage humain
   *  (conflit avec une résa directe, source injoignable, garde de sanité). */
  reconcileAlerts?: string[];
}

export async function healthSignals(db: D1Database, propertyId: number, now: Date = new Date()): Promise<HealthSignals> {
  const since = sqlNow(new Date(now.getTime() - 24 * 3600 * 1000));

  const orphans = await db
    .prepare(
      `SELECT b.id AS booking_id, b.reference, b.status AS booking_status, p.amount_cents, p.received_at
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN units u ON u.id = b.unit_id
        WHERE p.status = 'succeeded' AND b.status != 'confirmed' AND u.property_id = ?1
          AND p.kind != 'refund'
          AND NOT (b.status = 'cancelled' AND b.cancelled_at IS NOT NULL AND b.cancel_reason NOT IN ('hold_expired', 'hold_replaced')
                   AND COALESCE(p.received_at, p.created_at) <= b.cancelled_at)
        ORDER BY p.id DESC LIMIT 20`,
    )
    .bind(propertyId)
    .all();

  const overpaid = await db
    .prepare(
      `SELECT b.id AS booking_id, b.reference, b.status AS booking_status,
              b.paid_cents - b.total_cents AS overpaid_cents
         FROM bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE b.paid_cents > b.total_cents AND b.status != 'cancelled' AND u.property_id = ?1
        ORDER BY b.id DESC LIMIT 20`,
    )
    .bind(propertyId)
    .all();

  const emails = await db
    .prepare(
      `SELECT e.booking_id, b.reference, e.kind, e.to_email, e.created_at, e.error_detail
         FROM email_log e
         LEFT JOIN bookings b ON b.id = e.booking_id
         LEFT JOIN units u ON u.id = b.unit_id
        WHERE e.status = 'failed' AND e.created_at >= ?1
          AND (e.booking_id IS NULL OR u.property_id = ?2)
        ORDER BY e.id DESC LIMIT 20`,
    )
    .bind(since, propertyId)
    .all();

  const errors = await db
    .prepare(
      `SELECT action, entity, created_at, detail FROM audit_log
        WHERE action LIKE '%.error' AND created_at >= ?1 ORDER BY id DESC LIMIT 10`,
    )
    .bind(since)
    .all();

  const pull = await db
    .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
    .bind(propertyId)
    .first<{ value: string }>();
  const lastPull = pull?.value ?? null;
  const staleHours = lastPull ? (now.getTime() - Date.parse(lastPull.replace(" ", "T") + "Z")) / 3_600_000 : null;

  // Rapatriement complet quotidien (issue #19) : la date du dernier passage et
  // les écarts qu'il n'a pas pu résoudre seul. Lecture défensive — la carte
  // « Santé » ne doit pas tomber parce qu'un compte-rendu est illisible.
  let reconcileLastRun: string | null = null;
  let reconcileAlerts: string[] = [];
  try {
    const run = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'reconcile_last_run'")
      .first<{ value: string }>();
    reconcileLastRun = run?.value ?? null;
    const report = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?1")
      .bind(`reconcile_last_report:${propertyId}`)
      .first<{ value: string }>();
    if (report?.value) {
      const parsed = JSON.parse(report.value) as { alerts?: unknown };
      if (Array.isArray(parsed.alerts)) reconcileAlerts = parsed.alerts.map((a) => String(a));
    }
  } catch {
    reconcileLastRun = null;
    reconcileAlerts = [];
  }

  return {
    reconcileLastRun,
    reconcileAlerts,
    orphanPayments: (orphans.results as Raw[]).map((r) => ({
      bookingId: num(r.booking_id),
      reference: str(r.reference),
      bookingStatus: str(r.booking_status),
      amountCents: num(r.amount_cents),
      receivedAt: r.received_at == null ? null : str(r.received_at),
    })),
    overpaidBookings: (overpaid.results as Raw[]).map((r) => ({
      bookingId: num(r.booking_id),
      reference: str(r.reference),
      bookingStatus: str(r.booking_status),
      overpaidCents: num(r.overpaid_cents),
    })),
    failedEmails: (emails.results as Raw[]).map((r) => ({
      bookingId: numOrNull(r.booking_id),
      reference: r.reference == null ? null : str(r.reference),
      kind: str(r.kind),
      toEmail: str(r.to_email),
      createdAt: str(r.created_at),
      errorDetail: r.error_detail == null ? null : str(r.error_detail),
    })),
    recentErrors: (errors.results as Raw[]).map((r) => ({
      action: str(r.action),
      entity: r.entity == null ? null : str(r.entity),
      createdAt: str(r.created_at),
      detail: r.detail == null ? null : str(r.detail),
    })),
    beds24LastPull: lastPull,
    beds24StaleHours: staleHours == null || Number.isNaN(staleHours) ? null : Math.round(staleHours * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Signaux de dérive lente (carte « Santé », issue #71)
// ---------------------------------------------------------------------------

/** Rassemble ce dont les quatre détecteurs de `src/core/drift.ts` ont besoin.
 *  Tout se calcule à partir des tables existantes — aucune migration.
 *
 *  Les fenêtres sont volontairement bornées : 90 jours de tarifs, les messages
 *  d'un mois. Cette lecture tourne à chaque ouverture du tableau de bord. */
export async function collectDriftInput(
  db: D1Database,
  propertyId: number,
  now: Date = new Date(),
): Promise<DriftInput> {
  const today = todayInZone(now);
  const horizonEnd = addDays(today, RATE_HORIZON_DAYS);

  // 1. Flux iCal du domaine. `created_at` sert de point de départ aux flux
  //    jamais relevés : un flux ajouté il y a dix minutes n'est pas en dérive.
  const feedRows = await db
    .prepare(
      `SELECT f.id, f.name, f.active, f.last_sync_at, f.created_at, u.name AS unit_name
         FROM ical_feeds f JOIN units u ON u.id = f.unit_id
        WHERE u.property_id = ?1 ORDER BY f.id`,
    )
    .bind(propertyId)
    .all();
  const feeds: FeedState[] = (feedRows.results as Raw[]).map((r) => ({
    id: num(r.id),
    name: str(r.name),
    unitName: strOrNull(r.unit_name),
    active: num(r.active) === 1,
    lastSyncAt: strOrNull(r.last_sync_at),
    createdAt: strOrNull(r.created_at),
  }));

  // 1 bis. Conflits de synchronisation encore ouverts (issue #72) : un compte
  //    exact et l'ancienneté du plus vieux, en une requête agrégée — la vue
  //    Canaux, elle, en dresse la liste.
  const openConflicts = await summarizeOpenSyncConflicts(db, propertyId);

  // 2. Couverture tarifaire des unités actives. Le composite « somme » tire son
  //    prix de ses composantes : il lui faut la même vue que le calendrier admin.
  const [units, links, seasons, rules] = await Promise.all([
    listUnits(db, propertyId),
    listLinks(db, propertyId),
    listSeasons(db, propertyId),
    listRateRules(db, propertyId),
  ]);
  const activeUnits = units.filter((u) => u.active);
  // Composantes d'un composite : les unités physiques qu'il bloque, ACTIVES OU
  // NON — exactement ce que fait `getQuoteContext`, donc exactement ce qui sera
  // facturé. Filtrer les inactives ferait additionner un domaine amputé : un
  // prix valide, mais minoré, et aucun signal pour le dire.
  const driftUnits: UnitRateTarget[] = activeUnits.map((u) => ({
    active: true,
    pricingUnit: {
      id: u.id,
      name: u.name,
      compositePricing: u.isComposite ? u.compositePricing : "own",
      cleaningFeeCents: u.cleaningFeeCents,
      components: u.isComposite
        ? links
            .filter((l) => l.unitId === u.id && units.some((x) => x.id === l.blocksUnitId && !x.isComposite))
            .map((l) => {
              const c = units.find((x) => x.id === l.blocksUnitId);
              return { id: l.blocksUnitId, name: c?.name ?? "", cleaningFeeCents: c?.cleaningFeeCents ?? 0 };
            })
        : [],
    } satisfies UnitPricingInfo,
  }));
  const rateOverrides = await listRateOverrides(
    db,
    activeUnits.map((u) => u.id),
    today,
    horizonEnd,
  );

  // 3. Messages : un fil se juge sur son dernier échange, donc on lit large
  //    autour du seuil (un mois) plutôt que la seule fenêtre de 48 h — sinon la
  //    réponse de l'équipe, plus ancienne que la question, sortirait du cadre.
  //    Tri DESCENDANT sous le plafond : si le mois dépasse 500 messages, ce sont
  //    les PLUS RÉCENTS qu'il faut garder. Trier à l'endroit ferait deux dégâts
  //    d'un coup — la question d'hier jamais vue, et la réponse d'hier hors
  //    cadre, donc un fil clos annoncé en souffrance. Le détecteur retrie.
  const since = sqlNow(new Date(now.getTime() - Math.max(30 * 24, MESSAGE_UNANSWERED_HOURS * 4) * 3_600_000));
  const messageRows = await db
    .prepare(
      `SELECT m.id, m.direction, m.status, m.received_at, m.from_name, m.from_email, m.to_email,
              m.booking_id, m.guest_id, b.reference AS booking_reference
         FROM messages m LEFT JOIN bookings b ON b.id = m.booking_id
        WHERE m.property_id = ?1 AND m.received_at >= ?2
        ORDER BY m.id DESC LIMIT 500`,
    )
    .bind(propertyId, since)
    .all();
  const messages: MessageState[] = (messageRows.results as Raw[]).map((r) => ({
    id: num(r.id),
    direction: str(r.direction) === "out" ? "out" : "in",
    status: str(r.status) === "traité" ? "traité" : "nouveau",
    receivedAt: str(r.received_at),
    fromName: strOrNull(r.from_name),
    fromEmail: strOrNull(r.from_email),
    toEmail: strOrNull(r.to_email),
    bookingId: numOrNull(r.booking_id),
    bookingReference: strOrNull(r.booking_reference),
    guestId: numOrNull(r.guest_id),
  }));

  // 4. Battement de cœur du traitement planifié — la clé écrite en tête de
  //    chaque tick (services/health.ts, issue #21), lue aussi par /api/public/health.
  const heartbeat = await db
    .prepare("SELECT value FROM app_settings WHERE key = 'cron_last_run'")
    .first<{ value: string }>();

  return {
    feeds,
    openConflicts,
    units: driftUnits,
    today,
    seasons,
    rateRules: rules,
    rateOverrides,
    messages,
    lastCronAt: heartbeat?.value ?? null,
  };
}

// ---------------------------------------------------------------------------
// Conflits de synchronisation (issue #72) — ce que les canaux nous demandent
// et que nous n'avons pas pu refléter, gardé jusqu'à ce qu'il disparaisse ou
// qu'un humain le tranche. Identité et libellés : src/core/sync-conflicts.ts.
// ---------------------------------------------------------------------------

export interface SyncConflictRow {
  id: number;
  propertyId: number;
  unitId: number;
  unitName: string;
  source: SyncConflictSource;
  scope: string;
  kind: SyncConflictKind;
  fingerprint: string;
  checkin: IsoDate;
  checkout: IsoDate;
  externalUid: string | null;
  bookingReference: string | null;
  channelLabel: string | null;
  label: string;
  status: SyncConflictStatus;
  ignoreReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

function mapSyncConflict(r: Raw): SyncConflictRow {
  return {
    id: num(r.id),
    propertyId: num(r.property_id),
    unitId: num(r.unit_id),
    unitName: str(r.unit_name),
    source: str(r.source) === "beds24" ? "beds24" : "ical",
    scope: str(r.scope),
    kind: str(r.kind) as SyncConflictKind,
    fingerprint: str(r.fingerprint),
    checkin: str(r.checkin) as IsoDate,
    checkout: str(r.checkout) as IsoDate,
    externalUid: strOrNull(r.external_uid),
    bookingReference: strOrNull(r.booking_reference),
    channelLabel: strOrNull(r.channel_label),
    label: str(r.label),
    status: str(r.status) as SyncConflictStatus,
    ignoreReason: strOrNull(r.ignore_reason),
    firstSeenAt: str(r.first_seen_at),
    lastSeenAt: str(r.last_seen_at),
    resolvedAt: strOrNull(r.resolved_at),
  };
}

/** Enregistre une détection. Premier passage : la ligne naît « open ».
 *  Passages suivants sur le MÊME conflit : seule `last_seen_at` bouge — c'est
 *  toute la raison d'être de la table (avant, chaque tick écrasait le
 *  précédent et personne ne savait depuis quand ça durait).
 *
 *  Un conflit IGNORÉ le reste : il est redétecté 96 fois par jour, le
 *  repasser en « open » annulerait la décision au premier tick suivant.
 *  Un conflit RÉSOLU qui réapparaît se rouvre, en gardant sa première
 *  détection — c'est le même écart qui revient, pas un nouveau.
 *
 *  Le domaine se déduit de l'hébergement : aucun appelant n'a à le porter. */
export async function recordSyncConflict(
  db: D1Database,
  c: SyncConflictInput,
  seenAt: string = sqlNow(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_conflicts
         (property_id, unit_id, source, scope, kind, fingerprint, checkin, checkout,
          external_uid, booking_reference, channel_label, label, status, first_seen_at, last_seen_at)
       SELECT u.property_id, u.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', ?12, ?12
         FROM units u WHERE u.id = ?1
       ON CONFLICT (fingerprint) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         scope = excluded.scope,
         label = excluded.label,
         booking_reference = excluded.booking_reference,
         channel_label = excluded.channel_label,
         status = CASE WHEN sync_conflicts.status = 'ignored' THEN 'ignored' ELSE 'open' END,
         resolved_at = CASE WHEN sync_conflicts.status = 'ignored' THEN sync_conflicts.resolved_at ELSE NULL END`,
    )
    .bind(
      c.unitId,
      c.source,
      c.scope,
      c.kind,
      conflictFingerprint(c),
      c.checkin,
      c.checkout,
      c.externalUid ?? null,
      c.bookingReference ?? null,
      c.channelLabel ?? null,
      c.label,
      seenAt,
    )
    .run();
}

/** Referme les conflits d'un passage de synchro qui n'ont PAS été revus.
 *
 *  Le repère est l'horodatage du passage : `recordSyncConflict` vient de poser
 *  `last_seen_at = seenAt` sur tout ce qui a été redétecté, donc tout ce qui
 *  reste en deçà a disparu de la source (événement retiré, créneau libéré).
 *  Pas de liste d'empreintes à transporter, pas de SQL construit à la volée.
 *
 *  Les conflits IGNORÉS ne sont pas touchés : la décision humaine prime, et
 *  elle n'a pas à être reprise parce que la source s'est tue un passage.
 *
 *  À n'appeler que sur un passage qui a réellement balayé son périmètre : un
 *  flux illisible ou un lot vide n'apporte aucune information sur ce qui a
 *  disparu (même prudence que la garde de sanité de l'import iCal). */
export async function resolveUnseenSyncConflicts(
  db: D1Database,
  scope: string,
  seenAt: string,
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?2
        WHERE scope = ?1 AND status = 'open' AND last_seen_at < ?2`,
    )
    .bind(scope, seenAt)
    .run();
  return res.meta.changes ?? 0;
}

/** Referme les conflits d'un périmètre dont la source vient de REPARLER sans
 *  reproduire l'écart.
 *
 *  C'est la fermeture des passages PARTIELS (pull incrémental Beds24) : on ne
 *  peut y conclure que sur ce que la fenêtre a effectivement rapporté. Refermer
 *  tout ce qui n'a pas été revu y serait faux — après un déblocage forcé du
 *  curseur (MAX_CURSOR_HOLD_DAYS), la résa fautive sort de la fenêtre alors que
 *  le conflit tient toujours, et la première résa sans rapport suffirait à
 *  effacer l'alerte (contre-review 2026-08-28). */
export async function resolveSeenSyncConflicts(
  db: D1Database,
  scope: string,
  externalUids: readonly string[],
  seenAt: string,
): Promise<number> {
  const uids = [...new Set(externalUids)];
  if (uids.length === 0) return 0;
  const placeholders = uids.map((_, i) => `?${i + 3}`).join(", ");
  const res = await db
    .prepare(
      `UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?2
        WHERE scope = ?1 AND status = 'open' AND last_seen_at < ?2
          AND external_uid IN (${placeholders})`,
    )
    .bind(scope, seenAt, ...uids)
    .run();
  return res.meta.changes ?? 0;
}

/** Compte et ancienneté des conflits ouverts d'un domaine — ce dont la carte
 *  « Santé » a besoin, sans charger les lignes. Une lecture bornée aurait
 *  annoncé « 50 conflits » à partir du cinquante-et-unième, et daté la dérive
 *  sur le mauvais (contre-review 2026-08-28). */
export async function summarizeOpenSyncConflicts(
  db: D1Database,
  propertyId: number,
): Promise<OpenConflictSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(first_seen_at) AS oldest,
              (SELECT label FROM sync_conflicts
                WHERE property_id = ?1 AND status = 'open'
                ORDER BY first_seen_at, id LIMIT 1) AS oldest_label
         FROM sync_conflicts WHERE property_id = ?1 AND status = 'open'`,
    )
    .bind(propertyId)
    .first<Raw>();
  return {
    count: num(row?.n),
    oldestFirstSeenAt: strOrNull(row?.oldest),
    oldestLabel: strOrNull(row?.oldest_label),
  };
}

/** Conflits d'un domaine, les ouverts d'abord puis les plus récents. */
export async function listSyncConflicts(
  db: D1Database,
  propertyId: number,
  filter: { status?: SyncConflictStatus; limit?: number } = {},
): Promise<SyncConflictRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, u.name AS unit_name FROM sync_conflicts c JOIN units u ON u.id = c.unit_id
        WHERE c.property_id = ?1 AND (?2 IS NULL OR c.status = ?2)
        ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'ignored' THEN 1 ELSE 2 END,
                 c.last_seen_at DESC, c.id DESC
        LIMIT ?3`,
    )
    .bind(propertyId, filter.status ?? null, filter.limit ?? 100)
    .all();
  return (results as Raw[]).map(mapSyncConflict);
}

export async function getSyncConflict(db: D1Database, id: number): Promise<SyncConflictRow | null> {
  const row = await db
    .prepare("SELECT c.*, u.name AS unit_name FROM sync_conflicts c JOIN units u ON u.id = c.unit_id WHERE c.id = ?1")
    .bind(id)
    .first();
  return row ? mapSyncConflict(row as Raw) : null;
}

/** Décision humaine : ignorer (avec motif) ou rouvrir. Le motif est conservé
 *  même après réouverture — savoir ce qu'on avait décidé la dernière fois vaut
 *  mieux que repartir d'une page blanche. */
export async function setSyncConflictStatus(
  db: D1Database,
  id: number,
  status: SyncConflictStatus,
  reason: string | null,
  at: string = sqlNow(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sync_conflicts
          SET status = ?2,
              ignore_reason = COALESCE(?3, ignore_reason),
              resolved_at = CASE WHEN ?2 = 'open' THEN NULL ELSE ?4 END
        WHERE id = ?1`,
    )
    .bind(id, status, reason, at)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Registre des personnes hébergées (issue #84)
//
// Journal APPEND-ONLY. Aucune fonction de ce bloc ne fait d'UPDATE ni de DELETE
// de contenu : corriger une ligne, c'est en insérer une nouvelle qui la
// remplace (`supersedes_id`). Le seul DELETE est la purge de conservation, en
// fin de bloc, appelée par le traitement planifié.
//
// Cloisonnement : ces lignes ne sont lues QUE par la fiche réservation du
// back-office et par l'export CSV admin. Aucune autre fonction de ce fichier
// ne joint cette table, donc ni les e-mails, ni les canaux OTA, ni l'export
// iCal, ni les statistiques, ni le voucher ne peuvent la voir.
// ---------------------------------------------------------------------------

export interface GuestRegisterRow {
  id: number;
  bookingId: number;
  supersedesId: number | null;
  /** Id de la ligne qui remplace celle-ci, s'il en existe une (lecture seule). */
  supersededById: number | null;
  lastName: string;
  firstName: string;
  birthDate: IsoDate;
  nationality: string;
  idType: GuestIdType;
  idNumber: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  recordedBy: string;
  recordedAt: string;
  bookingReference?: string;
  unitName?: string;
}

function mapGuestRegister(r: Raw): GuestRegisterRow {
  return {
    id: num(r.id),
    bookingId: num(r.booking_id),
    supersedesId: numOrNull(r.supersedes_id),
    supersededById: numOrNull(r.superseded_by_id),
    lastName: str(r.last_name),
    firstName: str(r.first_name),
    birthDate: str(r.birth_date),
    nationality: str(r.nationality),
    idType: str(r.id_type) as GuestIdType,
    idNumber: str(r.id_number),
    arrivalDate: str(r.arrival_date),
    departureDate: str(r.departure_date),
    recordedBy: str(r.recorded_by),
    recordedAt: str(r.recorded_at),
    bookingReference: strOrNull(r.booking_reference) ?? undefined,
    unitName: strOrNull(r.unit_name) ?? undefined,
  };
}

/** `superseded_by_id` est calculé à la lecture (auto-jointure) plutôt que
 *  stocké : une colonne dénormalisée demanderait un UPDATE de la ligne
 *  remplacée, ce que l'append-only interdit. */
const GUEST_REGISTER_SELECT = `
  SELECT r.*, (SELECT s.id FROM guest_register s WHERE s.supersedes_id = r.id) AS superseded_by_id
    FROM guest_register r`;

export type InsertGuestEntryResult =
  | { ok: true; id: number }
  | { ok: false; reason: "supersedes" };

/** Ajoute UNE déclaration d'occupant.
 *
 *  Quand `supersedesId` est fourni, l'insertion est conditionnée dans la MÊME
 *  instruction : la ligne corrigée doit exister, appartenir à cette
 *  réservation, et ne pas être déjà remplacée. Aucune fenêtre entre la
 *  vérification et l'écriture — deux corrections simultanées de la même ligne
 *  ne peuvent pas passer toutes les deux (l'index UNIQUE partiel de la
 *  migration 0020 est la seconde ceinture). */
export async function insertGuestEntry(
  db: D1Database,
  input: {
    bookingId: number;
    entry: GuestRegisterEntry;
    recordedBy: string;
    now?: Date;
  },
): Promise<InsertGuestEntryResult> {
  const e = input.entry;
  const res = await db
    .prepare(
      `INSERT INTO guest_register
         (booking_id, supersedes_id, last_name, first_name, birth_date, nationality,
          id_type, id_number, arrival_date, departure_date, recorded_by, recorded_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        WHERE ?2 IS NULL
           OR EXISTS (
                SELECT 1 FROM guest_register o
                 WHERE o.id = ?2
                   AND o.booking_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM guest_register s WHERE s.supersedes_id = o.id)
              )`,
    )
    .bind(
      input.bookingId,
      e.supersedesId,
      e.lastName,
      e.firstName,
      e.birthDate,
      e.nationality,
      e.idType,
      e.idNumber,
      e.arrivalDate,
      e.departureDate,
      input.recordedBy,
      sqlNow(input.now ?? new Date()),
    )
    .run();
  if (res.meta.changes !== 1) return { ok: false, reason: "supersedes" };
  return { ok: true, id: res.meta.last_row_id };
}

/** Toutes les lignes d'une réservation, corrections comprises, dans l'ordre de
 *  saisie. Le back-office distingue « en vigueur » et « remplacée » avec
 *  `supersededById`. */
export async function listGuestRegister(db: D1Database, bookingId: number): Promise<GuestRegisterRow[]> {
  const { results } = await db
    .prepare(`${GUEST_REGISTER_SELECT} WHERE r.booking_id = ?1 ORDER BY r.id`)
    .bind(bookingId)
    .all();
  return (results as Raw[]).map(mapGuestRegister);
}

/** Lignes dont le SÉJOUR croise [from, to] (bornes incluses) — la question
 *  que pose une autorité est « qui était hébergé pendant cette période », pas
 *  « qui est arrivé pendant cette période » : une personne présente le 2
 *  juillet et arrivée le 28 juin doit sortir dans un export de juillet.
 *
 *  Le chevauchement rattrape aussi le cas d'une correction qui rectifie une
 *  date : filtrer sur la seule arrivée pouvait sortir la ligne d'origine sans
 *  sa correction, donc un CSV portant un renvoi vers une ligne absente
 *  (contre-review du 2026-08-28).
 *
 *  `propertyId` restreint au domaine demandé ; absent, l'export les couvre
 *  tous. Jointure à la réservation pour situer le séjour (référence,
 *  hébergement) — `bookings.unit_id` est NOT NULL et aucune unité n'est
 *  jamais supprimée, la jointure interne ne peut donc rien perdre. */
export async function listGuestRegisterBetween(
  db: D1Database,
  from: IsoDate,
  to: IsoDate,
  propertyId?: number,
): Promise<GuestRegisterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, (SELECT s.id FROM guest_register s WHERE s.supersedes_id = r.id) AS superseded_by_id,
              b.reference AS booking_reference, u.name AS unit_name
         FROM guest_register r
         JOIN bookings b ON b.id = r.booking_id
         JOIN units u ON u.id = b.unit_id
        WHERE r.arrival_date <= ?2 AND r.departure_date >= ?1
          AND (?3 IS NULL OR u.property_id = ?3)
        ORDER BY r.arrival_date, r.booking_id, r.id`,
    )
    .bind(from, to, propertyId ?? null)
    .all();
  return (results as Raw[]).map(mapGuestRegister);
}

/** Purge de conservation — LE SEUL DELETE du projet sur cette table.
 *
 *  Le tri se fait par RÉSERVATION et non ligne par ligne : une correction peut
 *  porter une date de départ différente de la ligne qu'elle remplace, et
 *  effacer la ligne d'origine sans sa correction laisserait une référence
 *  `supersedes_id` orpheline. Un séjour ne sort donc qu'entier, et seulement
 *  quand sa date de départ la PLUS RÉCENTE est antérieure à la butoir. */
export async function purgeGuestRegisterBefore(db: D1Database, cutoff: IsoDate): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM guest_register
        WHERE booking_id IN (
          SELECT booking_id FROM guest_register
           GROUP BY booking_id
          HAVING MAX(departure_date) < ?1
        )`,
    )
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------

export async function audit(
  db: D1Database,
  actor: "public" | "admin" | "cron" | "stripe" | "event" | "webhook",
  action: string,
  entity?: string | null,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)")
    .bind(actor, action, entity ?? null, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
