// Routes du lot 3 du back-office (/admin2/), Réglages › Plateformes :
//  - promotions Airbnb transmises par Beds24 (POST /channels/settings) ;
//  - prix dérivés par canal (priceRules.priceLinking des chambres Beds24),
//    calculés sur les majorations existantes (pricing.channel_markups) ;
//  - avis Airbnb et Booking relevés au cron (migration 0025), lus par la carte
//    « Avis » d'Aujourd'hui.
// Toute écriture vers Beds24 exige BEDS24_WRITE_ENABLED=true : sinon 409 en
// clair, et le réglage reste enregistré ici sans partir.
import { apiError, json, readJson, type Router } from "./router";
import { currentUser, guard } from "./admin";
import { audit, getProperty, listProperties, listUnits } from "../db/repo";
import { getSetting, setSetting } from "../services/settings";
import { Beds24Error, beds24Configured, beds24Fetch, beds24WritesAllowed, rawForAudit } from "../services/beds24";
import { triggerBeds24PushAll } from "../services/beds24-sync";
import { CHANNEL_MARKUPS_KEY, PUSH_CHANNEL_KEY, parseChannelMarkups, parsePushChannel, pushMarkupPct } from "../core/price-guardrails";
import {
  AIRBNB_PROMOTIONS_KEY,
  AIRBNB_PROMOTIONS_SENT_KEY,
  EARLY_BIRD_DAYS,
  PRICE_LINKING_KEY,
  airbnbMarkupPct,
  airbnbPreview,
  airbnbSettingsBody,
  derivedLines,
  describeRoomRules,
  normalizeAirbnbPromotions,
  parseAirbnbPromotions,
  parseLiveRules,
  parsePriceLinking,
  priceLinkingBody,
  priceRulesFor,
  restoreRules,
  type LiveRule,
} from "../core/channel-promotions";
import { REVIEWS_LOW_SCORE, reviewsSummary } from "../services/beds24-reviews";

/** Exemple affiché tant que la personne n'a rien saisi : 7 nuits à 1 400 €. */
const EXAMPLE = { stayCents: 140_000, nights: 7 };

function intOrZero(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Ce qui permet (ou non) d'écrire chez Beds24, dit en clair à l'écran. */
async function writeState(env: Env): Promise<{ configured: boolean; writesAllowed: boolean; reason: string | null }> {
  const configured = await beds24Configured(env);
  const writesAllowed = beds24WritesAllowed(env);
  const reason = !configured
    ? "la liaison Beds24 n'est pas en place (code d'invitation à coller plus haut)"
    : !writesAllowed
      ? "les écritures vers Beds24 sont fermées sur ce serveur (BEDS24_WRITE_ENABLED n'est pas à true) : rien ne part, le réglage est gardé ici"
      : null;
  return { configured, writesAllowed: configured && writesAllowed, reason };
}

/** Propriétés Beds24 reliées et leurs chambres (le Domaine entier n'en a pas). */
async function linkedRooms(db: D1Database, propertyId?: number): Promise<Array<{ propertyId: number; name: string; beds24PropertyId: number; roomIds: number[] }>> {
  const props = propertyId ? [await getProperty(db, propertyId)].filter((p) => p != null) : await listProperties(db);
  const out = [];
  for (const p of props) {
    if (p.beds24PropertyId == null) continue;
    const roomIds = (await listUnits(db, p.id)).filter((u) => u.active && u.beds24RoomId != null).map((u) => u.beds24RoomId as number);
    if (roomIds.length) out.push({ propertyId: p.id, name: p.name, beds24PropertyId: p.beds24PropertyId, roomIds });
  }
  return out;
}

function parseSent(raw: string | null): { at: string; by: string; promotions: unknown } | null {
  try {
    return raw ? (JSON.parse(raw) as { at: string; by: string; promotions: unknown }) : null;
  } catch {
    return null;
  }
}

function beds24Failure(e: unknown, extra?: Record<string, unknown>): Response {
  if (e instanceof Beds24Error) {
    return apiError(502, e.issue === "inconnu" ? `${e.message} — l'envoi a pu passer en partie : vérifier dans Beds24, puis renvoyer` : e.message, {
      code: e.issue === "inconnu" ? "beds24_unknown" : "beds24_refused",
      // La réponse Beds24 telle quelle : le motif exact d'un refus.
      ...(e.response !== undefined ? { beds24: e.response } : {}),
      ...extra,
    });
  }
  throw e;
}

async function markupContext(db: D1Database) {
  const markups = parseChannelMarkups(await getSetting(db, CHANNEL_MARKUPS_KEY));
  const pushChannel = parsePushChannel(await getSetting(db, PUSH_CHANNEL_KEY), markups);
  const linking = parsePriceLinking(await getSetting(db, PRICE_LINKING_KEY));
  return { markups, pushChannel, pushPct: pushMarkupPct(markups, pushChannel), linking };
}

/** Une étape de l'envoi, gardée pour l'audit et rendue en cas d'échec :
 *  ce qui est parti chez Beds24 et ce qu'il a répondu (ids, noms de lignes de
 *  prix et multiplicateurs : aucune donnée de voyageur). */
export interface LinkingStep {
  beds24PropertyId: number;
  etape: "lecture" | "envoi" | "retour";
  envoi?: unknown;
  reponse?: unknown;
  erreur?: string;
}

type Linked = Awaited<ReturnType<typeof linkedRooms>>[number];

/** Lignes de prix actuelles de chaque chambre reliée, lues chez Beds24 (lecture seule). */
async function readLiveRules(env: Env, l: Linked, journal: LinkingStep[]): Promise<Map<number, LiveRule[]>> {
  let data: { data?: Array<{ id?: number; roomTypes?: Array<{ id?: number; priceRules?: unknown }> }> };
  try {
    data = await beds24Fetch(env, "/properties", { query: { id: String(l.beds24PropertyId), includePriceRules: "true", includeAllRooms: "true" } });
  } catch (e) {
    journal.push({ beds24PropertyId: l.beds24PropertyId, etape: "lecture", erreur: e instanceof Error ? e.message : String(e), ...(e instanceof Beds24Error ? { reponse: e.response } : {}) });
    throw e;
  }
  const prop = (data.data ?? []).find((p) => p.id === l.beds24PropertyId);
  const out = new Map<number, LiveRule[]>();
  for (const roomId of l.roomIds) {
    const room = prop?.roomTypes?.find((r) => r.id === roomId);
    if (!room) throw new Beds24Error(`Beds24 GET /properties : la chambre #${roomId} de la propriété #${l.beds24PropertyId} est absente de la réponse — rien n'est envoyé`);
    const rules = parseLiveRules(room.priceRules);
    if (!rules) throw new Beds24Error(`Beds24 GET /properties : pas de liste priceRules lisible pour la chambre #${roomId} — rien n'est envoyé`, undefined, "refus", rawForAudit(room));
    out.set(roomId, rules);
  }
  return out;
}

export interface LinkingPlan {
  beds24PropertyId: number;
  name: string;
  avant: Map<number, LiveRule[]>;
  body: unknown[];
}

/** Lit l'état de chaque propriété et prépare les envois, sans rien écrire.
 *  Une ligne de prix occupée par autre chose arrête tout avant le premier envoi. */
async function planPriceLinking(env: Env, enabled: boolean, journal: LinkingStep[]): Promise<{ plans: LinkingPlan[]; rooms: number }> {
  const { markups } = await markupContext(env.DB);
  const lines = derivedLines(markups);
  const plans: LinkingPlan[] = [];
  let rooms = 0;
  for (const l of await linkedRooms(env.DB)) {
    const avant = await readLiveRules(env, l, journal);
    const roomRules: Array<{ id: number; priceRules: Record<string, unknown>[] }> = [];
    for (const roomId of l.roomIds) {
      const plan = priceRulesFor(lines, enabled, roomId, avant.get(roomId) ?? []);
      if (!plan.ok) throw new Beds24Error(plan.message);
      roomRules.push({ id: roomId, priceRules: plan.rules });
    }
    rooms += l.roomIds.length;
    plans.push({ beds24PropertyId: l.beds24PropertyId, name: l.name, avant, body: priceLinkingBody(l.beds24PropertyId, roomRules) });
  }
  return { plans, rooms };
}

/** Remet une propriété dans l'état lu avant l'envoi : relit, et ne renvoie
 *  que l'écart. Rejouable : une seconde passe n'envoie rien. */
async function restoreProperty(env: Env, p: LinkingPlan, journal: LinkingStep[]): Promise<void> {
  const now = await readLiveRules(env, { propertyId: 0, name: p.name, beds24PropertyId: p.beds24PropertyId, roomIds: [...p.avant.keys()] }, journal);
  const rooms: Array<{ id: number; priceRules: Record<string, unknown>[] }> = [];
  for (const [roomId, before] of p.avant) {
    const current = now.get(roomId) ?? [];
    const ids = [...new Set([...before.map((r) => r.id), ...current.map((r) => r.id)])].sort((a, b) => a - b);
    const rules = restoreRules(before, current, ids);
    if (rules.length) rooms.push({ id: roomId, priceRules: rules });
  }
  if (!rooms.length) return;
  const body = priceLinkingBody(p.beds24PropertyId, rooms);
  try {
    const reponse = await beds24Fetch(env, "/properties", { method: "POST", body });
    journal.push({ beds24PropertyId: p.beds24PropertyId, etape: "retour", envoi: body, reponse: rawForAudit(reponse) });
  } catch (e) {
    journal.push({ beds24PropertyId: p.beds24PropertyId, etape: "retour", envoi: body, erreur: e instanceof Error ? e.message : String(e), ...(e instanceof Beds24Error ? { reponse: e.response } : {}) });
    throw e;
  }
}

export class PriceLinkingError extends Beds24Error {
  constructor(message: string, status: number | undefined, issue: "refus" | "inconnu", response: unknown, public journal: LinkingStep[]) {
    super(message, status, issue, response);
  }
}

/** Pose (ou défait) les prix dérivés sur toutes les chambres reliées.
 *
 *  Tout ou rien (contrôle Codex) : si une propriété refuse, toutes celles
 *  touchées — celle qui a refusé comprise, un refus pouvant être partiel —
 *  sont remises dans l'état LU avant l'envoi. Si ce retour arrière échoue
 *  aussi, l'erreur le dit avec le motif de Beds24 : `{"enabled":false}` le rejoue.
 *  `essai` : lit et prépare, n'écrit rien. */
export async function sendPriceLinking(
  env: Env,
  enabled: boolean,
  opts: { essai?: boolean } = {},
): Promise<{ properties: number; rooms: number; journal: LinkingStep[]; envois: unknown[] }> {
  const journal: LinkingStep[] = [];
  let planned: Awaited<ReturnType<typeof planPriceLinking>>;
  try {
    planned = await planPriceLinking(env, enabled, journal);
  } catch (e) {
    if (e instanceof Beds24Error) throw new PriceLinkingError(`${e.message} (lecture de l'état Beds24, rien n'a été envoyé)`, e.status, "refus", e.response, journal);
    throw e;
  }
  const envois = planned.plans.map((p) => p.body);
  if (opts.essai) return { properties: planned.plans.length, rooms: planned.rooms, journal, envois };
  const touched: LinkingPlan[] = [];
  for (const p of planned.plans) {
    try {
      const reponse = await beds24Fetch(env, "/properties", { method: "POST", body: p.body });
      journal.push({ beds24PropertyId: p.beds24PropertyId, etape: "envoi", envoi: p.body, reponse: rawForAudit(reponse) });
      touched.push(p);
    } catch (e) {
      // Refus certain : rien n'a été appliqué ici, on n'y touche pas. Issue
      // inconnue (réseau, 5xx, élément refusé à côté d'un `modified`) : la
      // propriété a pu changer en partie, elle est remise aussi.
      if (!(e instanceof Beds24Error) || e.issue === "inconnu") touched.push(p);
      journal.push({ beds24PropertyId: p.beds24PropertyId, etape: "envoi", envoi: p.body, erreur: e instanceof Error ? e.message : String(e), ...(e instanceof Beds24Error ? { reponse: e.response } : {}) });
      const failed: string[] = [];
      for (const d of touched) {
        try {
          await restoreProperty(env, d, journal);
        } catch (re) {
          failed.push(`#${d.beds24PropertyId} (${re instanceof Error ? re.message : String(re)})`);
        }
      }
      if (!(e instanceof Beds24Error)) throw e;
      const suite = failed.length
        ? ` — et le retour arrière a échoué sur la propriété Beds24 ${failed.join(", ")} : relancer POST /api/admin/channels/price-linking {"enabled":false}, qui relit Beds24 et remet le prix direct partout`
        : " — retour arrière fait : l'état lu avant l'envoi est remis";
      throw new PriceLinkingError(`${e.message}${suite}`, e.status, failed.length ? "inconnu" : "refus", e.response, journal);
    }
  }
  return { properties: planned.plans.length, rooms: planned.rooms, journal, envois };
}

/** État réel des lignes de prix chez Beds24, chambre par chambre (lecture seule). */
async function liveLinkingState(env: Env) {
  const { markups } = await markupContext(env.DB);
  const lines = derivedLines(markups);
  const journal: LinkingStep[] = [];
  const out = [];
  for (const l of await linkedRooms(env.DB)) {
    try {
      const live = await readLiveRules(env, l, journal);
      out.push({ beds24PropertyId: l.beds24PropertyId, name: l.name, rooms: [...live].map(([roomId, rules]) => describeRoomRules(roomId, rules, lines)) });
    } catch (e) {
      out.push({ beds24PropertyId: l.beds24PropertyId, name: l.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export function registerLot3AdminRoutes(router: Router): void {
  // --- promotions Airbnb ----------------------------------------------------------
  async function promotionsState(env: Env, propertyId: number) {
    const { markups, pushPct, linking } = await markupContext(env.DB);
    const promotions = parseAirbnbPromotions(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`));
    const sent = parseSent(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_SENT_KEY}.${propertyId}`));
    const linked = await linkedRooms(env.DB, propertyId);
    const markupPct = airbnbMarkupPct(linking.enabled, markups, pushPct);
    return {
      propertyId,
      promotions,
      earlyBirdDays: EARLY_BIRD_DAYS,
      markupPct,
      markupSource: linking.enabled ? "prix dérivé Airbnb" : pushPct ? "majoration de référence" : "aucune majoration",
      preview: airbnbPreview(EXAMPLE.stayCents, EXAMPLE.nights, markupPct, promotions),
      beds24: { ...(await writeState(env)), linked: linked.length > 0, rooms: linked[0]?.roomIds.length ?? 0 },
      lastSent: sent ? { at: sent.at, by: sent.by } : null,
      // Vrai si Airbnb a reçu exactement ce qui est enregistré ici.
      sentSame: sent != null && JSON.stringify(sent.promotions) === JSON.stringify(promotions),
    };
  }

  router.get("/api/admin/channels/airbnb-promotions", guard(async (_req, env, _p, url) => {
    const propertyId = intOrZero(url.searchParams.get("property"));
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu (?property=)");
    return json(await promotionsState(env, propertyId));
  }));

  // Aperçu d'une saisie pas encore enregistrée : un séjour donné, les remises saisies.
  router.post("/api/admin/channels/airbnb-promotions/preview", guard(async (_req, env, _p, _url) => {
    const body = await readJson<{ promotions?: unknown; stayCents?: unknown; nights?: unknown }>(_req);
    const p = normalizeAirbnbPromotions(body?.promotions);
    if (!p.ok) return apiError(400, p.message);
    const stayCents = Math.round(Number(body?.stayCents ?? EXAMPLE.stayCents));
    const nights = Math.floor(Number(body?.nights ?? EXAMPLE.nights));
    if (!Number.isFinite(stayCents) || stayCents < 100 || stayCents > 10_000_000) return apiError(400, "montant du séjour : de 1 € à 100 000 €");
    if (!Number.isFinite(nights) || nights < 1 || nights > 365) return apiError(400, "nombre de nuits : de 1 à 365");
    const { markups, pushPct, linking } = await markupContext(env.DB);
    return json(airbnbPreview(stayCents, nights, airbnbMarkupPct(linking.enabled, markups, pushPct), p.value));
  }));

  router.put("/api/admin/channels/airbnb-promotions", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: unknown; promotions?: unknown }>(req);
    const propertyId = intOrZero(body?.propertyId);
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu");
    const p = normalizeAirbnbPromotions(body?.promotions);
    if (!p.ok) return apiError(400, p.message);
    await setSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`, JSON.stringify(p.value));
    await audit(env.DB, "admin", "channels.airbnb_promotions", `property:${propertyId}`, { ...p.value, par: currentUser(req) });
    return json(await promotionsState(env, propertyId));
  }));

  router.post("/api/admin/channels/airbnb-promotions/send", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: unknown }>(req);
    const propertyId = intOrZero(body?.propertyId);
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu");
    const w = await writeState(env);
    if (!w.writesAllowed) return apiError(409, `rien n'est parti : ${w.reason}`, { code: "beds24_writes_closed" });
    const linked = await linkedRooms(env.DB, propertyId);
    if (!linked[0]) return apiError(409, "ce domaine n'est relié à aucune annonce Beds24", { code: "beds24_not_linked" });
    const promotions = parseAirbnbPromotions(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`));
    try {
      await beds24Fetch(env, "/channels/settings", { method: "POST", body: airbnbSettingsBody(linked[0].beds24PropertyId, linked[0].roomIds, promotions) });
    } catch (e) {
      await audit(env.DB, "admin", "beds24.airbnb_promotions_failed", `property:${propertyId}`, { error: e instanceof Error ? e.message : String(e), par: currentUser(req) });
      return beds24Failure(e);
    }
    await setSetting(env.DB, `${AIRBNB_PROMOTIONS_SENT_KEY}.${propertyId}`, JSON.stringify({ at: new Date().toISOString(), by: currentUser(req), promotions }));
    await audit(env.DB, "admin", "beds24.airbnb_promotions", `property:${propertyId}`, { ...promotions, rooms: linked[0].roomIds, par: currentUser(req) });
    return json(await promotionsState(env, propertyId));
  }));

  // --- prix dérivés par canal -------------------------------------------------------
  async function linkingState(env: Env) {
    const { markups, pushChannel, pushPct, linking } = await markupContext(env.DB);
    const lines = derivedLines(markups);
    const current = Object.fromEntries(lines.map((l) => [l.channel, l.markupPct]));
    const example = 10_000; // une nuit à 100 €
    return {
      enabled: linking.enabled,
      lines: lines.map((l) => ({ ...l, exampleCents: Math.round(example * l.multiplier) })),
      // Majorations sans équivalent chez Beds24 : affichées, jamais envoyées.
      unlinked: markups.filter((m) => !lines.some((l) => l.channel === m.channel)).map((m) => m.label),
      exampleDirectCents: example,
      // Avec les prix dérivés, la majoration « de référence » n'est plus appliquée au calendrier.
      pushChannel,
      pushPct,
      upToDate: linking.enabled && JSON.stringify(linking.sentMarkups) === JSON.stringify(current),
      sentAt: linking.sentAt,
      beds24: { ...(await writeState(env)), linked: (await linkedRooms(env.DB)).length },
    };
  }

  // `?beds24=1` : ajoute l'état RÉEL lu chez Beds24 (lignes de prix de chaque
  // chambre, « direct », « derive » ou « partiel » à remettre). Lecture seule.
  router.get("/api/admin/channels/price-linking", guard(async (_req, env, _p, url) => {
    const state = await linkingState(env);
    if (url.searchParams.get("beds24") !== "1") return json(state);
    if (!(await beds24Configured(env))) return json({ ...state, live: null, liveError: "liaison Beds24 absente" });
    return json({ ...state, live: await liveLinkingState(env) });
  }));

  // `{"enabled":true|false}` : envoie. `{"enabled":…, "essai":true}` : lit l'état
  // Beds24 et rend ce qui partirait, sans rien écrire (diagnostic).
  router.post("/api/admin/channels/price-linking", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{ enabled?: unknown; essai?: unknown }>(req);
    if (typeof body?.enabled !== "boolean") return apiError(400, "enabled (vrai ou faux) attendu");
    if (body.essai !== undefined && typeof body.essai !== "boolean") return apiError(400, "essai : vrai ou faux attendu (rien n'est parti)");
    const essai = body.essai === true;
    const w = await writeState(env);
    if (essai ? !w.configured : !w.writesAllowed) return apiError(409, `rien n'est parti : ${w.reason}`, { code: "beds24_writes_closed" });
    if ((await linkedRooms(env.DB)).length === 0) return apiError(409, "aucune annonce Beds24 reliée", { code: "beds24_not_linked" });
    if (essai) {
      try {
        const r = await sendPriceLinking(env, body.enabled, { essai: true });
        return json({ essai: true, enabled: body.enabled, properties: r.properties, rooms: r.rooms, envois: r.envois, live: await liveLinkingState(env) });
      } catch (e) {
        return beds24Failure(e, e instanceof PriceLinkingError ? { journal: e.journal } : undefined);
      }
    }
    const { markups } = await markupContext(env.DB);
    let sent;
    try {
      // Les règles d'abord, le calendrier ensuite : jamais un prix direct
      // envoyé sans la ligne qui le majore chez la plateforme.
      sent = await sendPriceLinking(env, body.enabled);
    } catch (e) {
      const journal = e instanceof PriceLinkingError ? e.journal : undefined;
      await audit(env.DB, "admin", "beds24.price_linking_failed", "app", { enabled: body.enabled, error: e instanceof Error ? e.message : String(e), journal, par: currentUser(req) });
      return beds24Failure(e, journal ? { journal } : undefined);
    }
    const lines = derivedLines(markups);
    await setSetting(env.DB, PRICE_LINKING_KEY, JSON.stringify({
      enabled: body.enabled,
      sentMarkups: body.enabled ? Object.fromEntries(lines.map((l) => [l.channel, l.markupPct])) : null,
      sentAt: new Date().toISOString(),
    }));
    await audit(env.DB, "admin", "beds24.price_linking", "app", { enabled: body.enabled, properties: sent.properties, rooms: sent.rooms, lines: lines.map((l) => `${l.beds24Channel}×${l.multiplier}`), journal: sent.journal, par: currentUser(req) });
    // Le prix du calendrier change (direct ↔ majoré) : renvoi immédiat.
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json(await linkingState(env));
  }));

  // --- avis (relevés au cron) --------------------------------------------------------
  router.get("/api/admin/reviews", guard(async (_req, env, _p, url) => {
    const propertyId = intOrZero(url.searchParams.get("property")) || null;
    return json({ ...(await reviewsSummary(env.DB, propertyId)), lowScore: REVIEWS_LOW_SCORE });
  }));
}
