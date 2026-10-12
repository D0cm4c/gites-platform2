// Création de la propriété Beds24 depuis NOTRE base (10/10/2026).
//
// Contexte : en juillet, la propriété #344555 et ses deux rooms avaient été
// créées à la main par l'API (migration 0010). Le compte d'alors est résilié ;
// le nouveau compte (`gites-premore`) est vide et le mapping en base pointe
// sur des identifiants qui n'existent plus. Ce module refait la création
// depuis le back-office, sans jamais ouvrir Beds24, et la veut COMPLÈTE dès le
// départ (consigne Julien : « reprends ce qu'on avait déjà fait ») :
//   - propriété : nom, adresse, commune, pays, devise, contact, heures
//     d'arrivée et de départ, description et règlement intérieur ;
//   - un roomType par hébergement VENDABLE sur les canaux (unités physiques
//     actives : Scieur, Scierie) : nom, capacité, min-nuits, prix de base,
//     frais de ménage, description, équipements (featureCodes).
//   Le Domaine entier (unité composite) reste en vente directe : sa liaison est
//   déjà reflétée dans les calendriers des deux rooms (beds24-sync.ts).
//   Ce que l'API ne couvre pas (photos : aucun champ image en écriture dans
//   apiV2.yaml) ou que nos données ne disent pas (coordonnées GPS, code postal,
//   wifi, lits…) est rendu sous « à compléter dans Beds24 ».
//
// Deux temps : (1) création du squelette (propriété + rooms, champs simples),
// puis écriture du mapping ; (2) enrichissement (textes, équipements), au mieux :
// un refus de la Beta y est rapporté, il ne défait ni la création ni le mapping.
//
// Garde-fous :
//   - écriture interdite hors production (beds24WritesAllowed) ;
//   - refus si la propriété mappée en base existe ENCORE dans le compte ;
//   - refus si le jeton est restreint à une propriété (il ne voit pas le
//     reste du compte : un homonyme lui échapperait) ;
//   - idempotence : une propriété du compte portant notre nom est reprise (et
//     complétée des rooms manquantes) au lieu d'être recréée ;
//   - marqueur de tentative posé AVANT le POST de création : si la relecture
//     échoue (réponse perdue, nom transformé par Beds24), l'appel suivant
//     reprend la propriété apparue depuis au lieu d'en créer une seconde ;
//   - le mapping n'est écrit qu'après RELECTURE du compte ;
//   - verrou en base contre le double clic : jeton aléatoire, bail de 5 min
//     renouvelé avant chaque écriture (abandon si perdu) ;
//   - après une écriture à l'issue inconnue (réseau, 5xx), aucune nouvelle
//     écriture pendant 30 min si rien n'est apparu dans le compte.

import {
  audit,
  getProperty,
  getSettings,
  listRateRules,
  listUnitPhotos,
  listUnits,
  type PropertyRow,
  type UnitRow,
} from "../db/repo";
import { pushedPriceCents } from "../core/price-guardrails";
import { ADRESSE_VITRINE, HOUSE_RULES, PROPERTY_DESCRIPTION, PROPERTY_FEATURE_CODES, unitContent } from "../core/beds24-contenu";
import { resolvePushMarkup } from "./beds24-sync";
import {
  Beds24Error,
  beds24Fetch,
  motifText,
  beds24ListProperties,
  beds24Status,
  beds24WritesAllowed,
  type Beds24Compte,
  type Beds24PropertySummary,
} from "./beds24";
import { getSetting } from "./settings";

/** Tous nos domaines sont en Belgique ; la base n'a pas de colonne pays.
 *  Beds24 attend un code ISO à 2 lettres (maxLength 2 dans le schéma). */
const PAYS = "BE";
/** Un gîte rural = « cottage » dans l'énumération propertyType de l'API. */
const PROPERTY_TYPE = "cottage";
const ROOM_TYPE = "holidayHome";
const LANGUE = "fr";

export class CreationRefusee extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message);
  }
}

export interface PhotoPlan {
  url: string;
  legende: string;
}

export interface RoomPlan {
  unitId: number;
  name: string;
  qty: 1;
  roomType: string;
  maxPeople: number;
  minStay?: number;
  /** Prix nuit de base (semaine, hors saison), majoration canal comprise —
   *  repli seulement : le push quotidien fixe le vrai prix jour par jour. */
  rackRate?: number;
  /** Frais de ménage (« frais généraux ») de l'hébergement, en euros. */
  cleaningFee?: number;
  description?: string;
  featureCodes: string[][];
  photos: PhotoPlan[];
  aCompleter: string[];
}

export interface PropertyPlan {
  propertyId: number;
  name: string;
  propertyType: string;
  currency: string;
  address?: string;
  postcode?: string;
  city?: string;
  state?: string;
  country: string;
  email?: string;
  phone?: string;
  checkInStart?: string;
  checkOutEnd?: string;
  description: string;
  houseRules: string;
  rooms: RoomPlan[];
  /** Unités actives laissées en vente directe (non créées chez Beds24). */
  directOnly: { unitId: number; name: string; raison: string }[];
  /** featureCodes de la propriété (une ligne par tableau). */
  featureCodes: string[][];
  /** Ce que l'API ne prend pas ou que nos données ne disent pas. */
  aCompleter: string[];
}

const clean = (v: string | null | undefined): string | undefined => {
  const t = (v ?? "").trim();
  // Les valeurs de seed « TODO_… » ne doivent pas partir chez un tiers.
  return t && !/TODO/i.test(t) ? t : undefined;
};

const ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", quot: '"', rsquo: "'", lsquo: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
  icirc: "î", iuml: "ï", ocirc: "ô", ugrave: "ù", ucirc: "û", ccedil: "ç",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Comparaison de noms tolérante : casse, espaces, Unicode, entités HTML
 *  (Beds24 peut rendre « G&icirc;tes »). */
export const sameName = (a: string, b: string): boolean => {
  const n = (s: string) => decodeEntities(s).normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr");
  return n(a) === n(b);
};

/** Le contenu éditorial (adresse, textes, équipements) existe-t-il pour ce domaine ? */
const contenuPrepare = (property: PropertyRow): boolean => ADRESSE_VITRINE[property.slug] != null;

const sellable = (units: UnitRow[]): UnitRow[] => units.filter((u) => u.active && !u.isComposite);

/** HH:MM au quart d'heure — les seules valeurs de l'énumération Beds24. */
const quarterHour = (v: string | undefined): string | undefined =>
  v && /^(([01]\d|2[0-3]):(00|15|30|45)|24:00)$/.test(v.trim()) ? v.trim() : undefined;

const euros = (cents: number | null | undefined): number | undefined =>
  cents != null && cents > 0 ? Math.round(cents) / 100 : undefined;

/** Ce qui serait créé chez Beds24 — lecture de notre base, aucun réseau. */
export async function buildPropertyPlan(db: D1Database, propertyId: number, publicBaseUrl: string): Promise<PropertyPlan> {
  const property = await getProperty(db, propertyId);
  if (!property) throw new CreationRefusee("domaine introuvable", 404);
  if (!contenuPrepare(property)) {
    // Textes, adresse et équipements sont propres au Pré Moré : les envoyer
    // pour un autre domaine créerait une annonce réelle au contenu faux.
    throw new CreationRefusee(
      `contenu Beds24 non préparé pour « ${property.name} » (src/core/beds24-contenu.ts) — création réservée au Pré Moré pour l'instant`,
      400,
    );
  }
  const [units, rules, markup, settings] = await Promise.all([
    listUnits(db, propertyId),
    listRateRules(db, propertyId),
    resolvePushMarkup(db),
    getSettings(db, propertyId),
  ]);
  const vendables = sellable(units);
  const photos = await listUnitPhotos(db, vendables.map((u) => u.id));
  const base = publicBaseUrl.replace(/\/+$/, "");
  const aCompleter: string[] = [];

  const rooms: RoomPlan[] = vendables.map((u) => {
    const rule = rules.find((r) => r.unitId === u.id && r.seasonId == null);
    const content = unitContent(u.slug, u.description);
    const roomPhotos = photos
      .filter((p) => p.unitId === u.id)
      .map((p) => ({ url: `${base}${p.path.startsWith("/") ? "" : "/"}${p.path}`, legende: p.caption ?? p.alt }));
    const todo = [...(content?.aCompleter ?? [])];
    if (!content) todo.push("Description : ni page vitrine connue ni description en base");
    if (roomPhotos.length > 0) {
      todo.unshift(`Photos (${roomPhotos.length}) : l'API Beds24 n'a pas de champ image en écriture — à importer par URL dans Beds24, dans l'ordre de la liste`);
    }
    if (!rule) todo.push("Min-nuits et prix de base : aucun tarif hors saison en base");
    const rack = rule && rule.priceWeekCents > 0 ? pushedPriceCents(rule.priceWeekCents, markup.pct) : null;
    return {
      unitId: u.id,
      name: u.name,
      qty: 1,
      roomType: ROOM_TYPE,
      maxPeople: Math.max(1, content?.capacite ?? u.capacityMax),
      ...(rule && rule.minNights >= 1 ? { minStay: Math.min(rule.minNights, 365) } : {}),
      ...(euros(rack) != null ? { rackRate: euros(rack) } : {}),
      ...(euros(u.cleaningFeeCents) != null ? { cleaningFee: euros(u.cleaningFeeCents) } : {}),
      ...(content ? { description: content.description } : {}),
      featureCodes: content?.featureCodes ?? [],
      photos: roomPhotos,
      aCompleter: todo,
    };
  });

  const vitrine = ADRESSE_VITRINE[property.slug];
  const address = vitrine?.address ?? clean(property.address);
  const phone = clean(property.contactPhone) ?? vitrine?.phone;
  const checkInStart = quarterHour(settings.checkinTime);
  const checkOutEnd = quarterHour(settings.checkoutTime);
  aCompleter.push(
    "Coordonnées GPS (latitude, longitude) : absentes de notre base et de nos pages",
    "Heure limite d'arrivée (checkInEnd) : non définie chez nous",
  );
  if (!vitrine) aCompleter.push("Code postal et rue exacte : notre base n'a qu'une adresse libre" + (address ? ` (« ${address} »)` : ""));
  if (!checkInStart || !checkOutEnd) aCompleter.push("Heures d'arrivée/départ : réglage absent ou hors quart d'heure");
  if (!clean(property.contactEmail)) aCompleter.push("E-mail de contact : absent ou provisoire (TODO) dans notre base");
  if (!phone) aCompleter.push("Téléphone de contact : absent de notre base");

  return {
    propertyId: property.id,
    name: property.name,
    propertyType: PROPERTY_TYPE,
    currency: property.currency || "EUR",
    address,
    postcode: vitrine?.postcode,
    city: vitrine?.city ?? clean(property.commune),
    state: vitrine?.state,
    country: PAYS,
    email: clean(property.contactEmail),
    phone,
    checkInStart,
    checkOutEnd,
    description: PROPERTY_DESCRIPTION,
    houseRules: HOUSE_RULES,
    featureCodes: PROPERTY_FEATURE_CODES.map((l) => [...l]),
    rooms,
    directOnly: units
      .filter((u) => u.active && u.isComposite)
      .map((u) => ({
        unitId: u.id,
        name: u.name,
        raison: "vente directe uniquement — la liaison ferme les rooms des maisons qui le composent",
      })),
    aCompleter,
  };
}

export type MappingEtat = "absent" | "actif" | "perime" | "inconnu";

export interface MappingStatus {
  propertyId: number;
  propertyName: string;
  beds24PropertyId: number | null;
  etat: MappingEtat;
  rooms: { unitId: number; unitName: string; beds24RoomId: number | null; etat: MappingEtat }[];
  /** Propriété du compte qui porte notre nom (reprise idempotente). */
  homonyme: { id: number; name: string } | null;
}

function mappingStatus(
  property: PropertyRow,
  units: UnitRow[],
  accountProps: Beds24PropertySummary[] | null,
): MappingStatus {
  const mapped = property.beds24PropertyId;
  const found = accountProps && mapped != null ? accountProps.find((p) => p.id === mapped) ?? null : null;
  const etat: MappingEtat = mapped == null ? "absent" : accountProps == null ? "inconnu" : found ? "actif" : "perime";
  const roomIds = new Set((found?.roomTypes ?? []).map((r) => r.id));
  const homonyme = accountProps?.find((p) => sameName(p.name, property.name)) ?? null;
  return {
    propertyId: property.id,
    propertyName: property.name,
    beds24PropertyId: mapped,
    etat,
    rooms: sellable(units).map((u) => ({
      unitId: u.id,
      unitName: u.name,
      beds24RoomId: u.beds24RoomId,
      etat:
        u.beds24RoomId == null ? "absent" : accountProps == null ? "inconnu" : found && roomIds.has(u.beds24RoomId) ? "actif" : "perime",
    })),
    homonyme: homonyme ? { id: homonyme.id, name: homonyme.name } : null,
  };
}

/** Le jeton a-t-il le droit d'écrire les propriétés ? null = on ne sait pas
 *  (aucun scope remonté). Avertissement seulement : les noms de scopes ne
 *  sont pas listés dans la doc. */
function canWriteProperties(compte: Beds24Compte | undefined): boolean | null {
  if (!compte || compte.scopes.length === 0) return null;
  // Formes rencontrées : « properties » (liste de l'invite code dans la doc),
  // « write:properties » / « all:properties ». « read:properties » seul = non.
  return compte.scopes.some((s) => /^((write|all):)?properties$/i.test(s.trim()));
}

/** Diagnostic complet pour l'écran Canaux : compte relié, propriétés du
 *  compte, état du mapping en base, et si la création est proposée. */
export async function beds24Liaison(env: Env, propertyId: number) {
  const status = await beds24Status(env);
  const property = await getProperty(env.DB, propertyId);
  const units = property ? await listUnits(env.DB, propertyId) : [];
  const mapping = property ? mappingStatus(property, units, status.connected ? status.properties ?? [] : null) : null;
  const ecritureAutorisee = beds24WritesAllowed(env);
  const jetonRestreint = status.compte?.limiteAPropriete != null;
  const mappingARefaire = Boolean(mapping && (mapping.etat === "absent" || mapping.etat === "perime"));
  const prepare = property ? contenuPrepare(property) : false;
  // Mapping écrit mais textes/équipements jamais partis (arrêt entre les deux).
  const contenuEnAttente = Boolean(
    mapping?.etat === "actif" && (await getSetting(env.DB, contentKey(propertyId))) != null,
  );
  return {
    ...status,
    ecritureAutorisee,
    ecriturePropriete: canWriteProperties(status.compte),
    jetonRestreint,
    mapping,
    mappingARefaire,
    contenuPrepare: prepare,
    contenuEnAttente,
    // Bouton « Créer la propriété » : liaison active, mapping absent ou
    // périmé, écriture permise sur ce serveur, jeton qui voit tout le compte.
    creationPossible: Boolean(
      status.connected && (mappingARefaire || contenuEnAttente) && prepare && ecritureAutorisee && !jetonRestreint &&
        canWriteProperties(status.compte) !== false,
    ),
  };
}

const LOCK_KEY = "beds24_creation_verrou";
const LOCK_TTL_SECONDS = 300;
const attemptKey = (propertyId: number) => `beds24_creation_tentative:${propertyId}`;
/** Posé avec le mapping, levé quand textes et équipements sont partis. */
const contentKey = (propertyId: number) => `beds24_contenu_a_envoyer:${propertyId}`;
/** Après une écriture à l'issue inconnue, on n'en refait pas avant ce délai :
 *  Beds24 peut montrer la propriété avec retard. */
const ATTEMPT_QUIET_MS = 30 * 60 * 1000;
/** Une tentative plus vieille qu'un jour est oubliée (rien n'est apparu). */
const ATTEMPT_FORGET_MS = 24 * 3600 * 1000;

async function takeLock(db: D1Database): Promise<string | null> {
  // Un verrou dont le bail n'a pas été renouvelé depuis le TTL (Worker tué en
  // plein appel) est repris. Le détenteur renouvelle son bail avant chaque
  // écriture (renewLock) : un appel lent ne se fait pas voler le verrou.
  await db
    .prepare(`DELETE FROM app_settings WHERE key = ?1 AND updated_at < datetime('now', ?2)`)
    .bind(LOCK_KEY, `-${LOCK_TTL_SECONDS} seconds`)
    .run();
  const owner = crypto.randomUUID();
  const res = await db
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO NOTHING`)
    .bind(LOCK_KEY, owner)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? owner : null;
}

/** Renouvelle le bail ; s'il a été perdu, on abandonne AVANT d'écrire. */
async function renewLock(db: D1Database, owner: string): Promise<void> {
  const res = await db
    .prepare("UPDATE app_settings SET updated_at = datetime('now') WHERE key = ?1 AND value = ?2")
    .bind(LOCK_KEY, owner)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    throw new CreationRefusee("verrou de création perdu (appel trop long) — rien n'a été écrit après sa perte, relancer", 409);
  }
}

async function releaseLock(db: D1Database, owner: string): Promise<void> {
  // Seul le détenteur libère : un verrou repris par un autre appel reste à lui.
  await db.prepare("DELETE FROM app_settings WHERE key = ?1 AND value = ?2").bind(LOCK_KEY, owner).run();
}

interface Attempt {
  /** Ids des propriétés du compte AVANT l'écriture. */
  beforeIds: number[];
  /** Propriété visée quand l'écriture mettait à jour une existante. */
  targetId?: number;
  /** Ids de ses rooms AVANT l'écriture. */
  beforeRoomIds?: number[];
  at: number;
  issue: "en_cours" | "inconnu";
}

async function writeAttempt(db: D1Database, propertyId: number, a: Attempt): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(attemptKey(propertyId), JSON.stringify(a))
    .run();
}

async function clearAttempt(db: D1Database, propertyId: number): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(attemptKey(propertyId)).run();
}

/** POST d'écriture encadré : marqueur posé avant, levé si Beds24 a refusé
 *  pour de bon, passé à « inconnu » si l'issue l'est (réseau, 5xx). */
async function guardedPost(
  env: Env,
  propertyId: number,
  owner: string,
  attempt: Omit<Attempt, "at" | "issue">,
  body: unknown,
): Promise<unknown> {
  await renewLock(env.DB, owner);
  await writeAttempt(env.DB, propertyId, { ...attempt, at: Date.now(), issue: "en_cours" });
  try {
    return await beds24Fetch(env, "/properties", { method: "POST", body });
  } catch (e) {
    if (e instanceof Beds24Error && e.issue === "refus") await clearAttempt(env.DB, propertyId);
    else await writeAttempt(env.DB, propertyId, { ...attempt, at: Date.now(), issue: "inconnu" });
    throw e;
  }
}

/** Id de la propriété créée, s'il figure dans la réponse au POST. */
function newIdFromResponse(data: unknown): number | null {
  if (!Array.isArray(data)) return null;
  const item = data[0] as Record<string, unknown> | undefined;
  const n = item && typeof item.new === "object" && item.new ? (item.new as Record<string, unknown>).id : undefined;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const heure = (ms: number) =>
  new Date(ms).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });

function roomCore(r: RoomPlan): Record<string, unknown> {
  return {
    name: r.name,
    roomType: r.roomType,
    qty: r.qty,
    maxPeople: r.maxPeople,
    ...(r.minStay != null ? { minStay: r.minStay } : {}),
    ...(r.rackRate != null ? { rackRate: r.rackRate } : {}),
    ...(r.cleaningFee != null ? { cleaningFee: r.cleaningFee } : {}),
  };
}

function propertyCore(plan: PropertyPlan, rooms: RoomPlan[]): Record<string, unknown> {
  return {
    name: plan.name,
    propertyType: plan.propertyType,
    currency: plan.currency,
    ...(plan.address ? { address: plan.address } : {}),
    ...(plan.postcode ? { postcode: plan.postcode } : {}),
    ...(plan.city ? { city: plan.city } : {}),
    ...(plan.state ? { state: plan.state } : {}),
    country: plan.country,
    ...(plan.email ? { email: plan.email } : {}),
    ...(plan.phone ? { phone: plan.phone } : {}),
    ...(plan.checkInStart ? { checkInStart: plan.checkInStart } : {}),
    ...(plan.checkOutEnd ? { checkOutEnd: plan.checkOutEnd } : {}),
    roomTypes: rooms.map(roomCore),
  };
}

/** Messages d'une réponse d'écriture v2 (multiplePostResponse) qui ne sont
 *  pas des échecs : `errors` sur un élément réussi, `warnings`, `info`. */
function responseMessages(data: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    for (const key of ["errors", "warnings", "info"] as const) {
      const list = (item as Record<string, unknown>)[key];
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
        const text = motifText(m);
        const label = key === "errors" ? "erreur" : key === "warnings" ? "avertissement" : "info";
        out.push(`${label} Beds24${typeof o.field === "string" && o.field ? ` (${o.field})` : ""} : ${text}`);
      }
    }
  }
  return out;
}

/** Ce que la création envoie, en clair, pour le récapitulatif. */
function sentSummary(plan: PropertyPlan) {
  return {
    propriete: [
      "nom", "type (cottage)", `devise ${plan.currency}`, `pays ${plan.country}`,
      ...(plan.address ? ["adresse"] : []), ...(plan.postcode ? ["code postal"] : []), ...(plan.city ? ["localité"] : []),
      ...(plan.email ? ["e-mail"] : []), ...(plan.phone ? ["téléphone"] : []),
      ...(plan.checkInStart ? [`arrivée dès ${plan.checkInStart}`] : []),
      ...(plan.checkOutEnd ? [`départ avant ${plan.checkOutEnd}`] : []),
      "description", "règlement intérieur",
      ...(plan.featureCodes.length ? ["équipements (featureCodes)"] : []),
    ],
    rooms: plan.rooms.map((r) => ({
      unitId: r.unitId,
      name: r.name,
      champs: [
        `capacité ${r.maxPeople}`,
        ...(r.minStay != null ? [`${r.minStay} nuit(s) min.`] : []),
        ...(r.rackRate != null ? [`prix de base ${r.rackRate} ${plan.currency}`] : []),
        ...(r.cleaningFee != null ? [`ménage ${r.cleaningFee} ${plan.currency}`] : []),
        ...(r.description ? ["description"] : []),
        ...(r.featureCodes.length ? [`équipements : ${r.featureCodes.map((l) => l.join(" ")).filter(Boolean).join(" | ")}`] : []),
      ],
    })),
  };
}

export interface CreationResult {
  ok: true;
  propriete: { beds24PropertyId: number; name: string; creee: boolean };
  rooms: { unitId: number; name: string; beds24RoomId: number; creee: boolean }[];
  directOnly: PropertyPlan["directOnly"];
  ancienMapping: { beds24PropertyId: number | null; rooms: { unitId: number; beds24RoomId: number | null }[] };
  envoye: ReturnType<typeof sentSummary>;
  /** Textes et équipements : envoyés et acceptés, ou le refus de Beds24. */
  contenu: { ok: boolean; erreur?: string };
  /** « À compléter dans Beds24 » : propriété, puis par hébergement. */
  aCompleter: { propriete: string[]; rooms: { unitId: number; name: string; points: string[]; photos: PhotoPlan[] }[] };
  avertissements: string[];
}

/** Crée (ou retrouve et met à jour) la propriété et ses rooms chez Beds24,
 *  écrit le mapping, puis envoie textes et équipements. Lève CreationRefusee
 *  (garde-fou) ou Beds24Error (refus de l'API, message en clair). */
export async function createBeds24Property(env: Env, propertyId: number, actor: string): Promise<CreationResult> {
  const db = env.DB;
  if (!beds24WritesAllowed(env)) {
    throw new CreationRefusee("écriture Beds24 bloquée sur ce serveur — la création se fait depuis le site en ligne", 403);
  }
  const plan = await buildPropertyPlan(db, propertyId, env.PUBLIC_BASE_URL);
  if (plan.rooms.length === 0) throw new CreationRefusee("aucun hébergement vendable sur les canaux dans ce domaine", 400);
  const property = (await getProperty(db, propertyId))!;
  const units = await listUnits(db, propertyId);

  const owner = await takeLock(db);
  if (!owner) throw new CreationRefusee("une création Beds24 est déjà en cours — réessaie dans cinq minutes", 409);
  try {
    const status = await beds24Status(env);
    if (!status.connected) throw new Beds24Error(`liaison Beds24 inactive : ${status.error ?? "inconnue"}`);
    if (status.compte?.limiteAPropriete != null) {
      throw new CreationRefusee(
        `le jeton Beds24 est restreint à la propriété #${status.compte.limiteAPropriete} : il ne voit pas le reste du compte — générer un code d'invitation sans restriction`,
        409,
      );
    }
    if (canWriteProperties(status.compte) === false) {
      throw new CreationRefusee(
        `le jeton Beds24 n'a pas le droit d'écrire les propriétés (droits : ${status.compte?.scopes.join(", ")}) — générer un code d'invitation avec « properties »`,
        409,
      );
    }
    const before = status.properties ?? [];
    const mapping = mappingStatus(property, units, before);
    if (mapping.etat === "actif" && (await getSetting(db, contentKey(propertyId))) != null) {
      // Reprise : mapping écrit, textes et équipements jamais partis.
      const mappedRooms = plan.rooms.map((r) => {
        const u = units.find((x) => x.id === r.unitId);
        return { unitId: r.unitId, name: r.name, beds24RoomId: u?.beds24RoomId ?? 0, creee: false };
      });
      if (mappedRooms.some((r) => !r.beds24RoomId)) {
        throw new CreationRefusee("mapping incomplet pour reprendre l'envoi des textes — vérifier la correspondance des hébergements", 409);
      }
      return await finishContent(env, owner, plan, propertyId, actor, {
        propriete: { beds24PropertyId: property.beds24PropertyId!, name: plan.name, creee: false },
        rooms: mappedRooms,
        ancienMapping: { beds24PropertyId: property.beds24PropertyId, rooms: mappedRooms.map((r) => ({ unitId: r.unitId, beds24RoomId: r.beds24RoomId })) },
        avertissements: ["reprise de l'envoi des textes et équipements (interrompu après l'écriture du mapping)"],
      });
    }
    if (mapping.etat === "actif") {
      throw new CreationRefusee(
        `la propriété Beds24 #${property.beds24PropertyId} est déjà mappée et existe dans le compte — rien à créer (pousser les calendriers suffit)`,
        409,
        { beds24PropertyId: property.beds24PropertyId },
      );
    }

    // Tentative précédente inachevée (marqueur posé avant chaque écriture).
    const avertissements: string[] = [];
    let existing: Beds24PropertySummary | null = null;
    let attempt: Attempt | null = null;
    const attemptRaw = await getSetting(db, attemptKey(propertyId));
    if (attemptRaw) {
      try {
        attempt = JSON.parse(attemptRaw) as Attempt;
      } catch {
        attempt = null;
      }
      if (!attempt || !Number.isFinite(attempt.at) || Date.now() - attempt.at > ATTEMPT_FORGET_MS) {
        await clearAttempt(db, propertyId);
        attempt = null;
      }
    }
    const quiet = attempt != null && Date.now() - attempt.at < ATTEMPT_QUIET_MS;
    const tooSoon = (what: string) =>
      new CreationRefusee(
        `${what} à ${heure(attempt!.at)} a une issue inconnue (réponse de Beds24 perdue) et rien n'est encore visible dans le compte — Beds24 peut l'afficher avec retard : vérifier dans Beds24, ou relancer après ${heure(attempt!.at + ATTEMPT_QUIET_MS)}`,
        409,
      );
    if (attempt && attempt.targetId == null) {
      const knownIds = new Set<number>((attempt.beforeIds ?? []).map(Number));
      const appeared = before.filter((p) => !knownIds.has(p.id));
      const candidate = appeared[0];
      if (appeared.length > 1) {
        throw new CreationRefusee(
          `une création précédente n'a pas abouti et ${appeared.length} propriétés sont apparues depuis dans le compte (#${appeared.map((p) => p.id).join(", #")}) — vérifier dans Beds24 avant de relancer`,
          409,
        );
      }
      if (appeared.length === 1 && candidate) {
        // On ne reprend d'office que si le nom concorde : une propriété créée
        // à la main entre-temps (autre domaine) ne doit pas être captée.
        if (!sameName(candidate.name, plan.name)) {
          throw new CreationRefusee(
            `une création précédente n'a pas abouti et la propriété #${candidate.id} (« ${candidate.name} ») est apparue depuis dans le compte — si c'est la nôtre, la renommer « ${plan.name} » dans Beds24 puis relancer ; sinon, vérifier avant de relancer`,
            409,
          );
        }
        existing = candidate;
        avertissements.push(`reprise de la propriété #${candidate.id} apparue lors d'une tentative précédente inachevée`);
      } else if (quiet) {
        throw tooSoon("la création précédente");
      }
    }
    if (attempt && attempt.targetId != null) {
      // La tentative précédente mettait à jour une propriété précise : on s'y
      // rattache, et une room apparue sous un autre nom bloque (résolution
      // manuelle) au lieu d'être recréée en double.
      const target = before.find((p) => p.id === attempt!.targetId);
      if (!target) {
        throw new CreationRefusee(
          `la propriété Beds24 #${attempt.targetId} visée par la tentative précédente n'est plus dans le compte — vérifier dans Beds24 avant de relancer`,
          409,
        );
      }
      const knownRooms = new Set<number>((attempt.beforeRoomIds ?? []).map(Number));
      const strangers = (target.roomTypes ?? []).filter(
        (rt) => !knownRooms.has(rt.id) && !plan.rooms.some((r) => sameName(r.name, rt.name)),
      );
      if (strangers.length > 0) {
        throw new CreationRefusee(
          `une mise à jour précédente n'a pas abouti et des rooms inattendues sont apparues dans #${target.id} (${strangers.map((r) => `#${r.id} « ${r.name} »`).join(", ")}) — si ce sont les nôtres, les renommer comme chez nous dans Beds24 puis relancer`,
          409,
        );
      }
      existing = target;
    }
    if (!existing) {
      const homonymes = before.filter((p) => sameName(p.name, plan.name));
      if (homonymes.length > 1) {
        throw new CreationRefusee(
          `plusieurs propriétés « ${plan.name} » dans le compte Beds24 (#${homonymes.map((p) => p.id).join(", #")}) — en supprimer les doublons dans Beds24 avant de relier`,
          409,
          { ids: homonymes.map((p) => p.id) },
        );
      }
      existing = homonymes[0] ?? null;
    }
    const roomOf = (r: RoomPlan) => (existing?.roomTypes ?? []).filter((rt) => sameName(rt.name, r.name));
    const missing = plan.rooms.filter((r) => roomOf(r).length === 0);
    if (existing && attempt?.targetId === existing.id && quiet && missing.length > 0) {
      throw tooSoon("l'ajout de rooms précédent");
    }
    for (const r of plan.rooms) {
      if (roomOf(r).length > 1) {
        throw new CreationRefusee(`room « ${r.name} » en double dans la propriété Beds24 #${existing!.id} — supprimer le doublon dans Beds24`, 409);
      }
    }
    const propertyCreated = existing == null;

    let prop: Beds24PropertySummary;
    if (existing == null) {
      const res = await guardedPost(env, propertyId, owner, { beforeIds: before.map((p) => p.id) }, [propertyCore(plan, plan.rooms)]);
      avertissements.push(...responseMessages(res));
      const after = await beds24ListProperties(env);
      const newId = newIdFromResponse(res);
      const knownIds = new Set(before.map((p) => p.id));
      const appeared = after.filter((p) => !knownIds.has(p.id));
      const byName = after.filter((p) => sameName(p.name, plan.name));
      const found =
        (newId != null ? after.find((p) => p.id === newId) : undefined) ??
        (appeared.length === 1 ? appeared[0] : byName.length === 1 ? byName[0] : undefined);
      if (!found) {
        await writeAttempt(db, propertyId, { beforeIds: before.map((p) => p.id), at: Date.now(), issue: "inconnu" });
        throw new Beds24Error(
          `Beds24 a répondu à la création mais la propriété n'est pas identifiable à la relecture (${appeared.length} nouvelle(s)) — mapping non écrit ; un nouvel essai reprendra la propriété apparue sans en créer une autre`,
          undefined,
          "inconnu",
        );
      }
      prop = found;
    } else {
      // Propriété reprise : on la remet entièrement à nos valeurs (noyau +
      // toutes les rooms, existantes par id, manquantes ajoutées) — le
      // récapitulatif dit alors vrai.
      const target = existing;
      const body = [
        {
          id: target.id,
          ...propertyCore(plan, []),
          roomTypes: plan.rooms.map((r) => {
            const ex = roomOf(r)[0];
            return ex ? { id: ex.id, ...roomCore(r) } : roomCore(r);
          }),
        },
      ];
      const res = await guardedPost(
        env, propertyId, owner,
        { beforeIds: before.map((p) => p.id), targetId: target.id, beforeRoomIds: (target.roomTypes ?? []).map((r) => r.id) },
        body,
      );
      avertissements.push(...responseMessages(res));
      const after = await beds24ListProperties(env);
      const found = after.find((p) => p.id === target.id);
      if (!found) throw new Beds24Error(`propriété Beds24 #${target.id} introuvable à la relecture — mapping non écrit`);
      prop = found;
    }

    const rooms = plan.rooms.map((r) => {
      const rt = (prop.roomTypes ?? []).filter((x) => sameName(x.name, r.name));
      const room = rt[0];
      if (rt.length !== 1 || !room) {
        throw new Beds24Error(
          `room « ${r.name} » ${rt.length === 0 ? "absente" : "en double"} dans la propriété Beds24 #${prop.id} à la relecture — mapping non écrit`,
        );
      }
      return { unitId: r.unitId, name: r.name, beds24RoomId: room.id, creee: missing.some((m) => m.unitId === r.unitId) };
    });

    const ancienMapping = {
      beds24PropertyId: property.beds24PropertyId,
      rooms: units.filter((u) => u.beds24RoomId != null).map((u) => ({ unitId: u.id, beds24RoomId: u.beds24RoomId })),
    };
    const propriete = { beds24PropertyId: prop.id, name: prop.name, creee: propertyCreated };
    // Écriture atomique : propriété, rooms des maisons, effacement de tout
    // ancien room id resté sur une autre unité du domaine, journal, et levée
    // du marqueur de tentative.
    const keep = new Set(rooms.map((r) => r.unitId));
    await renewLock(db, owner);
    await db.batch([
      db.prepare("UPDATE properties SET beds24_property_id = ?1 WHERE id = ?2").bind(prop.id, propertyId),
      ...rooms.map((r) => db.prepare("UPDATE units SET beds24_room_id = ?1 WHERE id = ?2").bind(r.beds24RoomId, r.unitId)),
      ...units
        .filter((u) => !keep.has(u.id) && u.beds24RoomId != null)
        .map((u) => db.prepare("UPDATE units SET beds24_room_id = NULL WHERE id = ?1").bind(u.id)),
      db
        .prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES ('admin', 'beds24.creer_propriete', ?1, ?2)")
        .bind(`property:${propertyId}`, JSON.stringify({
          par: actor,
          propriete,
          rooms: rooms.map((r) => ({ unitId: r.unitId, beds24RoomId: r.beds24RoomId, creee: r.creee })),
          ancienMapping,
          avertissements,
        })),
      db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(attemptKey(propertyId)),
      db
        .prepare(
          "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        )
        .bind(contentKey(propertyId), String(prop.id)),
    ]);

    return await finishContent(env, owner, plan, propertyId, actor, { propriete, rooms, ancienMapping, avertissements });
  } finally {
    await releaseLock(db, owner);
  }
}

/** Second temps : textes et équipements sur des ids connus (modification —
 *  la rejouer ne crée rien), puis le récapitulatif. Un refus est rapporté et
 *  journalisé ; la propriété et le mapping restent en place. */
async function finishContent(
  env: Env,
  owner: string,
  plan: PropertyPlan,
  propertyId: number,
  actor: string,
  done: Pick<CreationResult, "propriete" | "rooms" | "ancienMapping" | "avertissements">,
): Promise<CreationResult> {
  const db = env.DB;
  const { propriete, rooms, ancienMapping, avertissements } = done;
  const prop = { id: propriete.beds24PropertyId };

  // Enrichissement, au mieux : textes et équipements. Un refus est rapporté
  // et journalisé ; la propriété et le mapping restent en place. Écriture
  // sur des ids connus (modification) : la rejouer ne crée rien.
  let contenu: CreationResult["contenu"] = { ok: true };
  try {
    await renewLock(db, owner);
    const res = await beds24Fetch(env, "/properties", {
      method: "POST",
      body: [
        {
          id: prop.id,
          texts: [{ language: LANGUE, propertyDescription: plan.description, houseRules: plan.houseRules }],
          ...(plan.featureCodes.length ? { featureCodes: plan.featureCodes } : {}),
          roomTypes: rooms.map((r) => {
            const p = plan.rooms.find((x) => x.unitId === r.unitId)!;
            return {
              id: r.beds24RoomId,
              ...(p.description ? { texts: [{ language: LANGUE, roomDescription: p.description }] } : {}),
              // featureCodes : tableau de tableaux (apiV2.yaml, schémas property et room).
              // Une ligne par tableau, comme le champ « Features » de l'écran Beds24.
              ...(p.featureCodes.length ? { featureCodes: p.featureCodes } : {}),
            };
          }),
        },
      ],
    });
    avertissements.push(...responseMessages(res));
    await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(contentKey(propertyId)).run();
  } catch (e) {
    if (!(e instanceof Beds24Error) && !(e instanceof CreationRefusee)) throw e;
    contenu = { ok: false, erreur: e.message };
    // Refus certain : le rejouer échouerait pareil, on rend la main (le
    // reste est listé « à compléter »). Issue inconnue : reprise possible.
    if (e instanceof Beds24Error && e.issue === "refus") {
      await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(contentKey(propertyId)).run();
    }
  }
  await audit(db, "admin", contenu.ok ? "beds24.creer_propriete_contenu" : "beds24.creer_propriete_contenu_echec", `property:${propertyId}`, {
    par: actor, beds24PropertyId: prop.id, ...contenu,
  });

  return {
    ok: true,
    propriete,
    rooms,
    directOnly: plan.directOnly,
    ancienMapping,
    envoye: sentSummary(plan),
    contenu,
    aCompleter: {
      propriete: [
        ...(contenu.ok ? [] : [`Textes et équipements refusés par Beds24 (${contenu.erreur}) : à saisir à la main`]),
        ...plan.aCompleter,
      ],
      rooms: plan.rooms.map((r) => ({ unitId: r.unitId, name: r.name, points: r.aCompleter, photos: r.photos })),
    },
    avertissements,
  };
}
