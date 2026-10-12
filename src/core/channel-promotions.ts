// Promotions Airbnb et prix dérivés par canal (lot 3, Réglages › Plateformes).
//
// Deux réglages, une seule source de chiffres :
//  1. Les PROMOTIONS AIRBNB, transmises par Beds24 (`POST /channels/settings`,
//     canal airbnb) : remise 7 / 14 / 28 nuits, réservation tôt (early bird),
//     dernière minute, tarif non remboursable. Bornes du schéma Beds24 v2
//     (apiV2.yaml, airbnbSettingsPost) : durée 0-90 %, autres 0-50 %, jours
//     d'avance de l'early bird dans une liste fixe, dernière minute 0-28 jours.
//  2. Les PRIX DÉRIVÉS (`priceRules[].priceLinking` d'une chambre Beds24) : le
//     calendrier part au prix de vente directe (ligne de prix 1) et Beds24
//     calcule le prix de chaque plateforme (Booking = base × 1,18…). Les
//     multiplicateurs viennent des MAJORATIONS EXISTANTES (pricing.channel_markups) :
//     un seul endroit où l'on règle « + 18 % sur Booking ». Tant que les prix
//     dérivés sont actifs, le calendrier n'applique plus la majoration du
//     « canal de référence » (sinon la commission serait comptée deux fois).
//
// Fonctions pures : aucune lecture de base, aucun appel réseau.

import type { ChannelMarkup } from "./price-guardrails";

export interface AirbnbPromotions {
  weeklyPct: number; // 7 nuits et plus
  biweeklyPct: number; // 14 nuits et plus
  monthlyPct: number; // 28 nuits et plus
  earlyBirdDays: number | null; // null = pas d'early bird
  earlyBirdPct: number;
  lastMinuteDays: number | null; // null = pas de dernière minute
  lastMinutePct: number;
  nonRefundablePct: number;
}

export const AIRBNB_PROMOTIONS_KEY = "channels.airbnb_promotions";
export const AIRBNB_PROMOTIONS_SENT_KEY = "channels.airbnb_promotions_sent";
export const PRICE_LINKING_KEY = "channels.price_linking";

export const NO_AIRBNB_PROMOTIONS: AirbnbPromotions = {
  weeklyPct: 0,
  biweeklyPct: 0,
  monthlyPct: 0,
  earlyBirdDays: null,
  earlyBirdPct: 0,
  lastMinuteDays: null,
  lastMinutePct: 0,
  nonRefundablePct: 0,
};

/** Jours d'avance admis par Airbnb pour l'early bird (schéma Beds24). */
export const EARLY_BIRD_DAYS = [28, 30, 56, 60, 84, 90, 112, 120, 140, 150, 168, 180, 196, 210, 224, 240, 252, 270, 280, 300, 308, 330, 336, 360] as const;

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Valide une saisie ; rend le message d'erreur en clair au lieu de corriger en silence. */
export function normalizeAirbnbPromotions(raw: unknown): { ok: true; value: AirbnbPromotions } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "promotions attendues" };
  const r = raw as Record<string, unknown>;
  const pct = (k: string, max: number) => int(r[k] ?? 0, 0, max);
  const weeklyPct = pct("weeklyPct", 90);
  const biweeklyPct = pct("biweeklyPct", 90);
  const monthlyPct = pct("monthlyPct", 90);
  if (weeklyPct == null || biweeklyPct == null || monthlyPct == null) return { ok: false, message: "remise de durée : un nombre entier de 0 à 90 %" };
  const earlyBirdPct = pct("earlyBirdPct", 50);
  const lastMinutePct = pct("lastMinutePct", 50);
  const nonRefundablePct = pct("nonRefundablePct", 50);
  if (earlyBirdPct == null || lastMinutePct == null || nonRefundablePct == null) return { ok: false, message: "réservation tôt, dernière minute, non remboursable : un nombre entier de 0 à 50 %" };
  let earlyBirdDays: number | null = null;
  if (r.earlyBirdDays != null) {
    if (!EARLY_BIRD_DAYS.includes(r.earlyBirdDays as (typeof EARLY_BIRD_DAYS)[number])) return { ok: false, message: `réservation tôt : ${EARLY_BIRD_DAYS.join(", ")} jours seulement (règle Airbnb)` };
    earlyBirdDays = r.earlyBirdDays as number;
  }
  let lastMinuteDays: number | null = null;
  if (r.lastMinuteDays != null) {
    lastMinuteDays = int(r.lastMinuteDays, 1, 28);
    if (lastMinuteDays == null) return { ok: false, message: "dernière minute : de 1 à 28 jours avant l'arrivée" };
  }
  // Une remise plus longue plus faible qu'une plus courte n'a pas de sens :
  // Airbnb applique la remise du palier atteint, pas la meilleure.
  if ((biweeklyPct && biweeklyPct < weeklyPct) || (monthlyPct && monthlyPct < Math.max(weeklyPct, biweeklyPct))) {
    return { ok: false, message: "la remise d'un séjour plus long doit être au moins égale à celle d'un séjour plus court" };
  }
  if (earlyBirdPct > 0 && earlyBirdDays == null) return { ok: false, message: "réservation tôt : choisir le nombre de jours d'avance" };
  if (lastMinutePct > 0 && lastMinuteDays == null) return { ok: false, message: "dernière minute : choisir le nombre de jours avant l'arrivée" };
  return { ok: true, value: { weeklyPct, biweeklyPct, monthlyPct, earlyBirdDays, earlyBirdPct, lastMinuteDays, lastMinutePct, nonRefundablePct } };
}

export function parseAirbnbPromotions(stored: string | null): AirbnbPromotions {
  if (!stored) return NO_AIRBNB_PROMOTIONS;
  try {
    const r = normalizeAirbnbPromotions(JSON.parse(stored));
    return r.ok ? r.value : NO_AIRBNB_PROMOTIONS;
  } catch {
    return NO_AIRBNB_PROMOTIONS;
  }
}

/** Corps de `POST /channels/settings` pour une propriété Beds24 et ses chambres. */
export function airbnbSettingsBody(beds24PropertyId: number, roomIds: number[], p: AirbnbPromotions): unknown[] {
  return [
    {
      channel: "airbnb",
      properties: [
        {
          id: beds24PropertyId,
          roomTypes: roomIds.map((id) => ({
            id,
            "7DayDiscountPercent": p.weeklyPct,
            "14DayDiscountPercent": p.biweeklyPct,
            "28DayDiscountPercent": p.monthlyPct,
            // Sans palier choisi, la remise est remise à 0 (Beds24 garde sinon l'ancienne).
            ...(p.earlyBirdDays != null ? { earlyBirdDaysToCheckin: p.earlyBirdDays } : {}),
            earlyBirdDiscountPercent: p.earlyBirdDays != null ? p.earlyBirdPct : 0,
            lastMinuteDaysToCheckin: p.lastMinuteDays ?? 0,
            lastMinuteDiscountPercent: p.lastMinuteDays != null ? p.lastMinutePct : 0,
            nonRefundableDiscountPercent: p.nonRefundablePct,
          })),
        },
      ],
    },
  ];
}

/** Remise de durée qu'Airbnb applique à un séjour de `nights` nuits (palier atteint). */
export function lengthDiscountPct(p: AirbnbPromotions, nights: number): number {
  if (nights >= 28 && p.monthlyPct) return p.monthlyPct;
  if (nights >= 14 && p.biweeklyPct) return p.biweeklyPct;
  if (nights >= 7 && p.weeklyPct) return p.weeklyPct;
  return 0;
}

const off = (cents: number, pct: number) => Math.round(cents * (1 - pct / 100));

export interface AirbnbPreview {
  stayCents: number;
  nights: number;
  markupPct: number;
  /** Prix du séjour sur Airbnb, majoration comprise, avant remise. */
  airbnbCents: number;
  lengthPct: number;
  /** Avec la remise de durée (le cas courant). */
  withLengthCents: number;
  /** Autres cas, chacun calculé SEUL à partir du prix avec remise de durée :
   *  Airbnb décide du cumul (Beds24 transmet les remises telles quelles). */
  nonRefundableCents: number | null;
  earlyBirdCents: number | null;
  lastMinuteCents: number | null;
}

/** « Un séjour de 7 nuits à 1 400 € part à … sur Airbnb. » */
export function airbnbPreview(stayCents: number, nights: number, markupPct: number, p: AirbnbPromotions): AirbnbPreview {
  const airbnbCents = Math.round(stayCents * (1 + markupPct / 100));
  const lengthPct = lengthDiscountPct(p, nights);
  const withLengthCents = off(airbnbCents, lengthPct);
  return {
    stayCents,
    nights,
    markupPct,
    airbnbCents,
    lengthPct,
    withLengthCents,
    nonRefundableCents: p.nonRefundablePct ? off(withLengthCents, p.nonRefundablePct) : null,
    earlyBirdCents: p.earlyBirdDays != null && p.earlyBirdPct ? off(withLengthCents, p.earlyBirdPct) : null,
    lastMinuteCents: p.lastMinuteDays != null && p.lastMinutePct ? off(withLengthCents, p.lastMinutePct) : null,
  };
}

// --- prix dérivés -------------------------------------------------------------

/** Nos canaux → nom du canal chez Beds24 (`priceRules[].channels.<nom>`). */
export const BEDS24_CHANNEL_OF: Record<string, string> = { airbnb: "airbnb", booking: "booking", abritel: "vrbo", vrbo: "vrbo", expedia: "expedia" };

/** Ligne de prix FIXE de chaque canal Beds24 (contrôle Codex 10/10/2026) :
 *  retirer ou réordonner une majoration ne réaffecte jamais une ligne à un autre canal. */
export const BEDS24_PRICE_ID_OF: Record<string, number> = { airbnb: 2, booking: 3, vrbo: 4, expedia: 5 };

export interface PriceLinkingState {
  enabled: boolean;
  /** Majorations envoyées au dernier envoi réussi (pour dire si Beds24 est à jour). */
  sentMarkups: Record<string, number> | null;
  sentAt: string | null;
}

export function parsePriceLinking(stored: string | null): PriceLinkingState {
  try {
    const r = stored ? (JSON.parse(stored) as Partial<PriceLinkingState>) : {};
    return { enabled: r.enabled === true, sentMarkups: r.sentMarkups ?? null, sentAt: r.sentAt ?? null };
  } catch {
    return { enabled: false, sentMarkups: null, sentAt: null };
  }
}

/** Multiplicateur Beds24 d'une majoration : + 18 % → 1,18 (borné à 0,1-9,99 par Beds24). */
export function linkMultiplier(markupPct: number): number {
  return Math.round((1 + markupPct / 100) * 10000) / 10000;
}

export interface DerivedLine {
  channel: string;
  label: string;
  beds24Channel: string;
  markupPct: number;
  multiplier: number;
  /** Ligne de prix Beds24 (2 à 16) qui porte ce canal. */
  priceId: number;
}

/** Une ligne de prix dérivée par canal relié (Airbnb, Booking, Vrbo…), dans l'ordre des majorations. */
export function derivedLines(markups: readonly ChannelMarkup[]): DerivedLine[] {
  const out: DerivedLine[] = [];
  const used = new Set<string>();
  for (const m of markups) {
    const b = BEDS24_CHANNEL_OF[m.channel];
    if (!b || used.has(b) || out.length >= 15) continue;
    used.add(b);
    out.push({ channel: m.channel, label: m.label, beds24Channel: b, markupPct: m.markupPct, multiplier: linkMultiplier(m.markupPct), priceId: BEDS24_PRICE_ID_OF[b]! });
  }
  return out;
}

// --- règles de prix d'une chambre Beds24 (priceRules) ------------------------
//
// Contrôle du 10/10/2026 (502 en production sur la propriété 359805) : le
// premier envoi recréait les lignes 2 à 4 « à l'aveugle », sans lire ce que
// Beds24 avait déjà, et le retour arrière renvoyait des lignes neuves avec un
// lien nul — refusé à son tour. Désormais tout part de l'état LU chez Beds24
// (GET /properties?includePriceRules=true) :
//  - activer : ligne 1 fermée aux canaux reliés, une ligne par canal liée à la
//    ligne 1 de la MÊME chambre (roomId explicite) ; une ligne créée reprend
//    l'occupation et les séjours min./max. de la ligne 1 ;
//  - désactiver : ligne 1 rouverte, et seules les lignes dérivées QUI EXISTENT
//    sont déliées et fermées — jamais de ligne créée pour être aussitôt défaite ;
//  - retour arrière : on relit, et on ne renvoie que l'écart à l'état d'avant.
// Une ligne 2 à 16 qui n'est pas à nous (autre nom, pas liée à la ligne 1)
// n'est jamais écrasée : refus avant tout envoi.

/** Une ligne de prix telle que Beds24 la renvoie, réduite à ce qui nous sert. */
export interface LiveRule {
  id: number;
  name: string | null;
  link: { roomId: number | null; priceId: number; offsetMultiplier: number | null; offsetAmount: number | null } | null;
  /** canal Beds24 → ouvert ou non (seuls les canaux présents dans la réponse). */
  channels: Record<string, boolean>;
  bookingPage: { direct?: boolean; agent?: boolean } | null;
  /** Champs recopiés sur une ligne créée (occupation, séjours, suppléments). */
  copy: Record<string, unknown>;
}

const COPIED_FIELDS = ["priceFor", "minimumStay", "maximumStay", "extraPerson", "extraChild"] as const;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Lignes de prix d'une chambre lues dans `GET /properties` (roomTypes[].priceRules).
 *  `null` si la réponse n'en porte pas de liste lisible : on n'écrit rien à l'aveugle. */
export function parseLiveRules(raw: unknown): LiveRule[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LiveRule[] = [];
  for (const r of raw) {
    // Une entrée illisible rend toute la liste suspecte : une ligne mal lue
    // passerait pour libre et serait écrasée.
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const id = num(o.id);
    if (id == null || !Number.isInteger(id) || id < 1 || id > 16) return null;
    const pl = (o.priceLinking && typeof o.priceLinking === "object" ? o.priceLinking : null) as Record<string, unknown> | null;
    const linkedId = pl ? num(pl.priceId) : null;
    const channels: Record<string, boolean> = {};
    if (o.channels && typeof o.channels === "object") {
      for (const [k, v] of Object.entries(o.channels as Record<string, unknown>)) {
        if (v && typeof v === "object" && typeof (v as Record<string, unknown>).enabled === "boolean") channels[k] = (v as { enabled: boolean }).enabled;
      }
    }
    const bp = o.bookingPage && typeof o.bookingPage === "object" ? (o.bookingPage as Record<string, unknown>) : null;
    const bookingPage = bp ? { ...(typeof bp.direct === "boolean" ? { direct: bp.direct } : {}), ...(typeof bp.agent === "boolean" ? { agent: bp.agent } : {}) } : null;
    const copy: Record<string, unknown> = {};
    for (const f of COPIED_FIELDS) if (o[f] != null) copy[f] = o[f];
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : null,
      link: linkedId != null && pl ? { roomId: num(pl.roomId), priceId: linkedId, offsetMultiplier: num(pl.offsetMultiplier), offsetAmount: num(pl.offsetAmount) } : null,
      channels,
      bookingPage,
      copy,
    });
  }
  return out;
}

// « × » du premier envoi (10/10/2026) reconnu ; le nom envoyé est en ASCII,
// un caractère de moins que Beds24 pourrait refuser dans un nom de ligne.
// Beds24 limite le nom d'une ligne de prix à 20 caractères (refus « Text too long (Max 20 char) »
// lu le 11/10/2026 sur la réponse brute) : nom court « Airbnb x1,18 ». L'ancienne forme longue
// reste reconnue pour nettoyer une ligne qu'un ancien envoi aurait laissée.
const OUR_NAME = /^(?:[A-Za-z. ]+ x[\d,]+|.*\(prix direct [×x] [\d,]+\))$/;
const SHORT_LABEL: Record<string, string> = { airbnb: "Airbnb", booking: "Booking", vrbo: "Vrbo", expedia: "Expedia" };

/** Ligne posée par nous : sur une des lignes fixes des canaux, avec le nom que
 *  nous lui donnons. Un simple lien vers la ligne 1 ne suffit pas (une ligne
 *  faite à la main peut être liée aussi) : elle n'est alors jamais touchée. */
export function isOurRule(rule: LiveRule, _roomId: number): boolean {
  if (!Object.values(BEDS24_PRICE_ID_OF).includes(rule.id)) return false;
  return rule.name != null && OUR_NAME.test(rule.name);
}

/** Ligne vide : Beds24 crée d'office les lignes 1 à 16 sur chaque chambre,
 *  sans nom, sans lien, sans canal (constaté le 11/10/2026 sur #741844 : le
 *  premier essai refusait la ligne 2 « déjà utilisée » alors qu'elle était
 *  vierge). Une ligne vide est libre : on peut la prendre. */
export function isEmptyRule(rule: LiveRule): boolean {
  if (rule.name != null && rule.name.trim() !== "") return false;
  if (rule.link) return false;
  if (Object.values(rule.channels).some(Boolean)) return false;
  // bookingPage n'entre pas en compte : Beds24 pose « direct » par défaut sur ses lignes vierges
  // (constaté le 11/10/2026 sur #741844 : refus « déjà utilisée («  ») » malgré une ligne sans nom,
  // sans lien ni canal). Une ligne sans nom, sans lien et sans canal ouvert est libre.
  return true;
}

export function derivedRuleName(l: DerivedLine): string {
  const name = `${SHORT_LABEL[l.beds24Channel] ?? l.beds24Channel} x${String(l.multiplier).replace(".", ",")}`;
  return name.slice(0, 20);
}

export type RulesPlan = { ok: true; rules: Record<string, unknown>[] } | { ok: false; message: string };

/** `priceRules` à envoyer pour une chambre, à partir de son état lu chez Beds24. */
export function priceRulesFor(lines: readonly DerivedLine[], enabled: boolean, roomId: number, live: readonly LiveRule[]): RulesPlan {
  const byId = new Map(live.map((r) => [r.id, r]));
  const base = byId.get(1);
  if (enabled) {
    if (!base) return { ok: false, message: `chambre Beds24 #${roomId} : pas de ligne de prix 1 chez Beds24 — rien n'est envoyé` };
    for (const l of lines) {
      const existing = byId.get(l.priceId);
      if (existing && !isOurRule(existing, roomId) && !isEmptyRule(existing)) {
        return { ok: false, message: `chambre Beds24 #${roomId} : la ligne de prix ${l.priceId} est déjà utilisée (« ${existing.name ?? "sans nom"} ») — rien n'est envoyé, libérer cette ligne dans Beds24 d'abord` };
      }
    }
    const closed: Record<string, { enabled: boolean }> = {};
    for (const l of lines) closed[l.beds24Channel] = { enabled: false };
    const wanted = new Set(lines.map((l) => l.priceId));
    // Une de nos lignes qui ne sert plus (canal retiré, ordre changé) est
    // déliée et fermée : jamais deux lignes ouvertes au même canal.
    const stale = live.filter((r) => isOurRule(r, roomId) && !wanted.has(r.id));
    // Un canal que portait une ligne retirée revient sur la ligne 1 : jamais un canal sans prix.
    const linkedChannels = new Set(lines.map((l) => l.beds24Channel));
    for (const r of stale) for (const [ch, on] of Object.entries(r.channels)) if (on && !linkedChannels.has(ch)) closed[ch] = { enabled: true };
    return {
      ok: true,
      rules: [
        { id: 1, channels: closed },
        ...lines.map((l) => {
          const channels: Record<string, { enabled: boolean }> = {};
          for (const [ch, on] of Object.entries(byId.get(l.priceId)?.channels ?? {})) if (on && ch !== l.beds24Channel) channels[ch] = { enabled: false };
          channels[l.beds24Channel] = { enabled: true };
          return {
            id: l.priceId,
            ...(byId.has(l.priceId) ? {} : (base?.copy ?? {})),
            name: derivedRuleName(l),
            priceLinking: { roomId, priceId: 1, offsetMultiplier: l.multiplier, offsetAmount: 0 },
            // Hors page de réservation, posé à la création seulement : une ligne
            // existante garde le sien (le retour arrière n'a rien à deviner).
            ...(byId.has(l.priceId) ? {} : { bookingPage: { direct: false, agent: false } }),
            channels,
          };
        }),
        ...stale.map((r) => {
          const shut: Record<string, { enabled: boolean }> = {};
          for (const [ch, on] of Object.entries(r.channels)) if (on) shut[ch] = { enabled: false };
          return { id: r.id, priceLinking: { priceId: null }, ...(Object.keys(shut).length ? { channels: shut } : {}) };
        }),
      ],
    };
  }
  // Désactiver : « prix direct sur tous les canaux ».
  if (!base) return { ok: false, message: `chambre Beds24 #${roomId} : pas de ligne de prix 1 chez Beds24, le prix direct ne peut pas être rouvert — rien n'est envoyé` };
  const ours = live.filter((r) => isOurRule(r, roomId));
  const open: Record<string, { enabled: boolean }> = {};
  for (const l of lines) open[l.beds24Channel] = { enabled: true };
  for (const r of ours) for (const [ch, on] of Object.entries(r.channels)) if (on) open[ch] = { enabled: true };
  return {
    ok: true,
    rules: [
      { id: 1, channels: open },
      ...ours.map((r) => {
        const shut: Record<string, { enabled: boolean }> = {};
        for (const [ch, on] of Object.entries(r.channels)) if (on) shut[ch] = { enabled: false };
        return { id: r.id, priceLinking: { priceId: null }, ...(Object.keys(shut).length ? { channels: shut } : {}) };
      }),
    ],
  };
}

function sameLink(a: LiveRule["link"], b: LiveRule["link"]): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.priceId === b.priceId && (a.roomId ?? null) === (b.roomId ?? null) && (a.offsetMultiplier ?? 1) === (b.offsetMultiplier ?? 1) && (a.offsetAmount ?? 0) === (b.offsetAmount ?? 0);
}

/** Retour arrière : ce qu'il faut renvoyer pour que `current` redevienne
 *  `before` sur les lignes `ids` (lien, canaux, nom, page de réservation).
 *  Vide si rien n'a bougé : rejouable à volonté. */
export function restoreRules(before: readonly LiveRule[], current: readonly LiveRule[], ids: readonly number[]): Record<string, unknown>[] {
  const was = new Map(before.map((r) => [r.id, r]));
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const now = current.find((r) => r.id === id);
    if (!now) continue; // jamais créée : rien à défaire
    const old = was.get(id);
    const rule: Record<string, unknown> = { id };
    const channels: Record<string, { enabled: boolean }> = {};
    for (const ch of new Set([...Object.keys(now.channels), ...Object.keys(old?.channels ?? {})])) {
      // Absent avant : fermé sur une ligne dérivée (créée ou ouverte par nous),
      // laissé tel quel sur la ligne 1 (prix direct, jamais fermé par défaut).
      const target = old?.channels[ch] ?? (id === 1 ? undefined : false);
      const cur = now.channels[ch];
      if (target !== undefined && target !== (cur ?? (id === 1 ? true : false))) channels[ch] = { enabled: target };
    }
    if (Object.keys(channels).length) rule.channels = channels;
    if (id !== 1) {
      const targetLink = old ? old.link : null;
      if (!sameLink(now.link, targetLink)) {
        rule.priceLinking = targetLink
          ? { roomId: targetLink.roomId, priceId: targetLink.priceId, offsetMultiplier: targetLink.offsetMultiplier ?? 1, offsetAmount: targetLink.offsetAmount ?? 0 }
          : { priceId: null };
      }
      if (old && old.name != null && old.name !== now.name) rule.name = old.name;
      const bpOld = old?.bookingPage;
      if (bpOld && (Object.keys(bpOld) as Array<keyof typeof bpOld>).some((k) => now.bookingPage?.[k] !== bpOld[k])) rule.bookingPage = bpOld;
    }
    if (Object.keys(rule).length > 1) out.push(rule);
  }
  return out;
}

export interface RoomRulesState {
  roomId: number;
  /** direct : prix direct partout ; derive : prix dérivés en place ; partiel : entre les deux (à remettre). */
  etat: "direct" | "derive" | "partiel";
  lignes: Array<{ id: number; nom: string | null; lieeA: number | null; multiplicateur: number | null; canauxOuverts: string[] }>;
}

/** Ce que Beds24 a réellement pour une chambre, comparé aux lignes attendues. */
export function describeRoomRules(roomId: number, live: readonly LiveRule[], lines: readonly DerivedLine[]): RoomRulesState {
  const base = live.find((r) => r.id === 1);
  const ours = live.filter((r) => isOurRule(r, roomId));
  const linkOk = (r: LiveRule | undefined, l: DerivedLine) =>
    r?.link != null && r.link.priceId === 1 && (r.link.roomId == null || r.link.roomId === roomId) && r.link.offsetMultiplier === l.multiplier && (r.link.offsetAmount ?? 0) === 0;
  // Chaque canal observé doit avoir au moins une ligne ouverte (la 1, ou une ligne liée à la 1).
  const observed = new Set([...Object.keys(base?.channels ?? {}), ...ours.flatMap((r) => Object.keys(r.channels)), ...lines.map((l) => l.beds24Channel)]);
  const orphan = [...observed].some((ch) => base?.channels[ch] === false && !ours.some((r) => r.link?.priceId === 1 && r.channels[ch] === true));
  const ourOpen = ours.filter((r) => Object.values(r.channels).some(Boolean) || r.link != null);
  const baseOpenAll = lines.every((l) => base?.channels[l.beds24Channel] !== false);
  const derivedComplete = lines.every((l) => {
    const r = live.find((x) => x.id === l.priceId);
    return linkOk(r, l) && r!.channels[l.beds24Channel] === true && base?.channels[l.beds24Channel] === false;
  });
  const extraOurs = ours.some((r) => !lines.some((l) => l.priceId === r.id) && (r.link != null || Object.values(r.channels).some(Boolean)));
  const etat = !base || orphan ? "partiel" : ourOpen.length === 0 && baseOpenAll ? "direct" : lines.length > 0 && derivedComplete && !extraOurs ? "derive" : "partiel";
  return {
    roomId,
    etat,
    lignes: live.map((r) => ({
      id: r.id,
      nom: r.name,
      lieeA: r.link?.priceId ?? null,
      multiplicateur: r.link?.offsetMultiplier ?? null,
      canauxOuverts: Object.entries(r.channels).filter(([, on]) => on).map(([ch]) => ch),
    })),
  };
}

/** Corps de `POST /properties` qui pose (ou défait) des lignes de prix d'une propriété. */
export function priceLinkingBody(beds24PropertyId: number, rooms: ReadonlyArray<{ id: number; priceRules: Record<string, unknown>[] }>): unknown[] {
  return [{ id: beds24PropertyId, roomTypes: rooms.map((r) => ({ id: r.id, priceRules: r.priceRules })) }];
}

/** Majoration effective sur Airbnb : sa ligne dérivée si les prix dérivés sont
 *  actifs, sinon la majoration du canal de référence (le même prix partout). */
export function airbnbMarkupPct(linking: boolean, markups: readonly ChannelMarkup[], pushPct: number): number {
  if (!linking) return pushPct;
  return markups.find((m) => BEDS24_CHANNEL_OF[m.channel] === "airbnb")?.markupPct ?? 0;
}
