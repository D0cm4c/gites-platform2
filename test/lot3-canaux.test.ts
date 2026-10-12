// Lot 3 : promotions Airbnb et prix dérivés par canal (Réglages › Plateformes),
// avis Airbnb et Booking relevés au cron (migration 0025).
// Aucun appel réseau réel : fetch est remplacé pour api.beds24.com (faux serveur).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { FauxBeds24 } from "./helpers/beds24-faux";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import {
  airbnbPreview, airbnbSettingsBody, derivedLines, linkMultiplier, NO_AIRBNB_PROMOTIONS, normalizeAirbnbPromotions, parseLiveRules, priceRulesFor,
} from "../src/core/channel-promotions";
import { DEFAULT_CHANNEL_MARKUPS } from "../src/core/price-guardrails";
import { fromAirbnb, fromBooking, pullChannelReviews, REVIEWS_STATE_KEY } from "../src/services/beds24-reviews";
import { runLot3Scheduled } from "../src/jobs/scheduled";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "admin:jeton-lot3";
let t: TestDb;

const env = (writes = true): Env => ({
  DB: t.db, ASSETS: undefined as unknown as Fetcher, ADMIN_TOKEN: ADMIN, PUBLIC_BASE_URL: "https://gites.exemple.be",
  BEDS24_REFRESH_TOKEN: "refresh-de-test", EMAILS_ENABLED: "false", ...(writes ? { BEDS24_WRITE_ENABLED: "true" } : {}),
});

interface Call { method: string; path: string; query: URLSearchParams; body: unknown }
let calls: Call[] = [];
let refuse: string | null = null;
/** Refuse seulement l'appel POST /properties qui vise cette propriété Beds24. */
let refuseProperty: number | null = null;
let reviewPages: Record<string, unknown[][]> = {};
let airbnbReviews: Record<string, unknown[]> = {};
let bookingReviews: unknown[] = [];
const realFetch = globalThis.fetch;
/** Lignes de prix des chambres : faux Beds24 à état, qui valide le schéma apiV2.yaml. */
const faux = new FauxBeds24();

beforeAll(async () => {
  t = await createTestDb();
  faux.seed(344555, [711713, 711714]);
  faux.seed(999001, [999101]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.beds24.com") return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, query: url.searchParams, body });
    if (path === "/authentication/token") return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    if (refuse === path) return new Response(JSON.stringify({ success: false, error: "refusé par le faux Beds24" }), { status: 400 });
    if (path === "/properties" && method === "POST" && refuseProperty != null && (body as Array<{ id: number }>)[0]?.id === refuseProperty) {
      return new Response(JSON.stringify({ success: false, error: "propriété refusée" }), { status: 400 });
    }
    if (path === "/properties") return method === "GET" ? faux.get(url.searchParams) : faux.post(body);
    const paged = reviewPages[`${path}?${url.searchParams.get("roomId") ?? url.searchParams.get("propertyId")}`];
    if (paged) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ success: true, data: paged[page - 1] ?? [], pages: { nextPageExists: page < paged.length } }), { status: 200 });
    }
    if (path === "/channels/airbnb/reviews") return new Response(JSON.stringify({ success: true, data: airbnbReviews[url.searchParams.get("roomId") ?? ""] ?? [] }), { status: 200 });
    if (path === "/channels/booking/reviews") return new Response(JSON.stringify({ success: true, data: bookingReviews }), { status: 200 });
    if (method === "POST") return new Response(JSON.stringify((body as unknown[]).map(() => ({ success: true, modified: {} }))), { status: 201 });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(() => {
  // État Beds24 explicite à chaque test : lignes de prix d'origine (ligne 1 seule).
  faux.props.clear();
  faux.seed(344555, [711713, 711714]);
  faux.seed(999001, [999101]);
  calls = [];
  refuse = null;
  refuseProperty = null;
  reviewPages = {};
});

async function api(method: string, path: string, body?: unknown, e: Env = env()) {
  // Les push « temps réel » sont différés (waitUntil) : on les attend avant de lire les appels.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await router.handle(new Request(`http://test.local${path}`, {
    method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), e, ctx);
  await Promise.all(pending);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

const PROMO = { weeklyPct: 10, biweeklyPct: 15, monthlyPct: 25, earlyBirdDays: 90, earlyBirdPct: 5, lastMinuteDays: 7, lastMinutePct: 12, nonRefundablePct: 10 };

describe("règles pures", () => {
  it("promotions : bornes Airbnb, paliers cohérents, jours d'early bird de la liste", () => {
    expect(normalizeAirbnbPromotions(PROMO).ok).toBe(true);
    expect(normalizeAirbnbPromotions({ ...PROMO, weeklyPct: 91 }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({ ...PROMO, lastMinutePct: 51 }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({ ...PROMO, earlyBirdDays: 45 }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({ ...PROMO, monthlyPct: 5 }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({ ...PROMO, earlyBirdDays: null }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({ ...PROMO, weeklyPct: 10.5 }).ok).toBe(false);
    expect(normalizeAirbnbPromotions({}).ok).toBe(true);
  });

  it("aperçu : 7 nuits à 1 400 € sur Airbnb, + 18 % puis − 10 %", () => {
    const p = airbnbPreview(140_000, 7, 18, { ...NO_AIRBNB_PROMOTIONS, ...PROMO });
    expect(p.airbnbCents).toBe(165_200);
    expect(p.lengthPct).toBe(10);
    expect(p.withLengthCents).toBe(148_680);
    expect(p.nonRefundableCents).toBe(133_812);
    expect(airbnbPreview(140_000, 14, 0, { ...NO_AIRBNB_PROMOTIONS, ...PROMO }).lengthPct).toBe(15);
    expect(airbnbPreview(140_000, 30, 0, { ...NO_AIRBNB_PROMOTIONS, ...PROMO }).lengthPct).toBe(25);
    expect(airbnbPreview(140_000, 6, 0, { ...NO_AIRBNB_PROMOTIONS, ...PROMO }).lengthPct).toBe(0);
  });

  it("prix dérivés : une ligne par canal relié, multiplicateur = 1 + majoration", () => {
    const lines = derivedLines(DEFAULT_CHANNEL_MARKUPS);
    expect(lines.map((l) => [l.beds24Channel, l.multiplier, l.priceId])).toEqual([["airbnb", 1.18, 2], ["booking", 1.18, 3], ["vrbo", 1.15, 4]]);
    expect(linkMultiplier(17.5)).toBe(1.175);
    const live = parseLiveRules([{ id: 1, name: "Prix 1", minimumStay: 2, priceFor: { type: "maxCapacity" }, channels: { airbnb: { enabled: true } } }]);
    const plan = priceRulesFor(lines, true, 711713, live);
    if (!plan.ok) throw new Error(plan.message);
    const rules = plan.rules as Array<Record<string, any>>;
    expect(rules[0]).toEqual({ id: 1, channels: { airbnb: { enabled: false }, booking: { enabled: false }, vrbo: { enabled: false } } });
    // lien vers la ligne 1 de la MÊME chambre, occupation et séjour minimum repris de la ligne 1
    expect(rules[2]).toMatchObject({ id: 3, minimumStay: 2, priceFor: { type: "maxCapacity" }, priceLinking: { roomId: 711713, priceId: 1, offsetMultiplier: 1.18 }, channels: { booking: { enabled: true } } });
    // désactiver sans ligne dérivée chez Beds24 : seule la ligne 1 part, rien n'est créé
    const off = priceRulesFor(lines, false, 711713, live);
    expect(off.ok && off.rules).toEqual([{ id: 1, channels: { airbnb: { enabled: true }, booking: { enabled: true }, vrbo: { enabled: true } } }]);
  });

  it("corps Airbnb : une entrée par chambre, remises à zéro quand un palier manque", () => {
    const body = airbnbSettingsBody(344555, [711713], { ...NO_AIRBNB_PROMOTIONS, weeklyPct: 10 }) as Array<Record<string, any>>;
    const room = body[0]!.properties[0].roomTypes[0];
    expect(body[0]!.channel).toBe("airbnb");
    expect(room).toMatchObject({ id: 711713, "7DayDiscountPercent": 10, earlyBirdDiscountPercent: 0, lastMinuteDiscountPercent: 0 });
    expect(room).not.toHaveProperty("earlyBirdDaysToCheckin");
  });
});

describe("promotions Airbnb (routes)", () => {
  it("enregistrer, aperçu, envoi refusé quand les écritures sont fermées (rien ne part)", async () => {
    const saved = await api("PUT", "/api/admin/channels/airbnb-promotions", { propertyId: 1, promotions: PROMO }, env(false));
    expect(saved.status).toBe(200);
    expect(saved.data.promotions.weeklyPct).toBe(10);
    expect(saved.data.preview.nights).toBe(7);
    expect(saved.data.beds24.writesAllowed).toBe(false);
    expect(saved.data.beds24.reason).toMatch(/BEDS24_WRITE_ENABLED/);
    const sent = await api("POST", "/api/admin/channels/airbnb-promotions/send", { propertyId: 1 }, env(false));
    expect(sent.status).toBe(409);
    expect(sent.data.code).toBe("beds24_writes_closed");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await api("PUT", "/api/admin/channels/airbnb-promotions", { propertyId: 1, promotions: { ...PROMO, weeklyPct: 200 } })).status).toBe(400);
  });

  it("aperçu d'une saisie non enregistrée", async () => {
    const r = await api("POST", "/api/admin/channels/airbnb-promotions/preview", { promotions: PROMO, stayCents: 100_000, nights: 14 });
    expect(r.status).toBe(200);
    expect(r.data.lengthPct).toBe(15);
    expect((await api("POST", "/api/admin/channels/airbnb-promotions/preview", { promotions: PROMO, stayCents: 0, nights: 7 })).status).toBe(400);
  });

  it("envoi : POST /channels/settings Airbnb pour les deux chambres reliées, puis « à jour »", async () => {
    const r = await api("POST", "/api/admin/channels/airbnb-promotions/send", { propertyId: 1 });
    expect(r.status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.path === "/channels/settings")!;
    const prop = (post.body as Array<Record<string, any>>)[0]!.properties[0];
    expect(prop.id).toBe(344555);
    expect(prop.roomTypes.map((x: { id: number }) => x.id)).toEqual([711713, 711714]);
    expect(prop.roomTypes[0]).toMatchObject({ "7DayDiscountPercent": 10, "28DayDiscountPercent": 25, earlyBirdDaysToCheckin: 90, lastMinuteDaysToCheckin: 7, nonRefundableDiscountPercent: 10 });
    expect(r.data.sentSame).toBe(true);
    // une saisie modifiée après l'envoi n'est plus « à jour »
    const changed = await api("PUT", "/api/admin/channels/airbnb-promotions", { propertyId: 1, promotions: { ...PROMO, weeklyPct: 12 } });
    expect(changed.data.sentSame).toBe(false);
  });

  it("refus de Beds24 : 502 en clair, journal", async () => {
    refuse = "/channels/settings";
    const r = await api("POST", "/api/admin/channels/airbnb-promotions/send", { propertyId: 1 });
    expect(r.status).toBe(502);
    expect(r.data.code).toBe("beds24_refused");
    const n = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'beds24.airbnb_promotions_failed'").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("domaine non relié : 409", async () => {
    expect((await api("POST", "/api/admin/channels/airbnb-promotions/send", { propertyId: 2 })).data.code).toBe("beds24_not_linked");
  });
});

describe("prix dérivés par canal (routes)", () => {
  it("écritures fermées : 409, rien ne part, rien n'est activé", async () => {
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true }, env(false));
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
    expect((await api("GET", "/api/admin/channels/price-linking")).data.enabled).toBe(false);
  });

  it("activer : règles d'abord, puis calendrier au prix DIRECT (la majoration de référence ne s'ajoute plus)", async () => {
    // une majoration de référence en place : + 18 % Airbnb sur tout le calendrier
    await api("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    const before = calls.filter((c) => c.path === "/inventory/rooms/calendar").at(-1)!;
    const majore = (before.body as Array<{ calendar: Array<{ price1?: number }> }>)[0]!.calendar.find((d) => d.price1 != null)!.price1!;
    calls = [];
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(200);
    expect(r.data.enabled).toBe(true);
    expect(r.data.upToDate).toBe(true);
    const order = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(order[0]).toBe("/properties");
    expect(order).toContain("/inventory/rooms/calendar");
    const rules = (calls.find((c) => c.path === "/properties" && c.method === "POST")!.body as Array<Record<string, any>>)[0]!.roomTypes[0].priceRules;
    expect(rules[1]).toMatchObject({ priceLinking: { priceId: 1, offsetMultiplier: 1.18 } });
    const after = calls.filter((c) => c.path === "/inventory/rooms/calendar").at(-1)!;
    const direct = (after.body as Array<{ calendar: Array<{ price1?: number }> }>)[0]!.calendar.find((d) => d.price1 != null)!.price1!;
    expect(Math.round(direct * 1.18 * 100) / 100).toBeCloseTo(majore, 1);
    // l'aperçu Airbnb suit la ligne dérivée Airbnb
    expect((await api("GET", "/api/admin/channels/airbnb-promotions?property=1")).data.markupSource).toBe("prix dérivé Airbnb");
  });

  it("changer une majoration renvoie les règles avec le nouveau multiplicateur", async () => {
    calls = [];
    const r = await api("PUT", "/api/admin/channel-markups", { channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 20 }, { channel: "booking", label: "Booking.com", markupPct: 18 }, { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15 }] });
    expect(r.status).toBe(200);
    expect(r.data.linking).toEqual({ resent: true });
    const post = calls.find((c) => c.path === "/properties" && c.method === "POST")!;
    expect((post.body as Array<Record<string, any>>)[0]!.roomTypes[0].priceRules[1].priceLinking.offsetMultiplier).toBe(1.2);
    expect((await api("GET", "/api/admin/channels/price-linking")).data.upToDate).toBe(true);
  });

  it("désactiver : les liens sont défaits, la ligne 1 rendue à tous les canaux", async () => {
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: true })).status).toBe(200);
    calls = [];
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    expect(r.data.enabled).toBe(false);
    const rules = (calls.find((c) => c.path === "/properties" && c.method === "POST")!.body as Array<Record<string, any>>)[0]!.roomTypes[0].priceRules;
    expect(rules[0].channels.airbnb.enabled).toBe(true);
    expect(rules[1].priceLinking).toEqual({ priceId: null });
  });
});

describe("avis Airbnb et Booking", () => {
  it("conversion : avis de l'hôte écarté, Booking ramené sur 5", () => {
    expect(fromAirbnb({ id: "x", reviewer_role: "host", overall_rating: 5 }, 1, 1)).toBeNull();
    expect(fromAirbnb({ id: "y", reviewer_role: "guest", overall_rating: 4, public_review: "Très bien" }, 1, 1)).toMatchObject({ rating: 4, rawScale: 5 });
    expect(fromBooking({ review_id: 9, scoring: { review_score: 7 } }, 1)).toMatchObject({ rating: 3.5, rawScore: 7, rawScale: 10 });
  });

  it("relève : une fois toutes les 6 h, mise à jour sans doublon, résumé et alerte sous 4", async () => {
    airbnbReviews = {
      "711713": [
        { id: "a1", reviewer_role: "guest", overall_rating: 5, public_review: "Maison superbe, très calme.", submitted: true, submitted_at: "2026-10-01T10:00:00Z" },
        { id: "a2", reviewer_role: "host", overall_rating: 5, public_review: "Voyageurs parfaits" },
      ],
      "711714": [{ id: "a3", reviewer_role: "guest", overall_rating: 3, public_review: "Un peu froid.", submitted: true, submitted_at: "2026-10-05T10:00:00Z" }],
    };
    bookingReviews = [{ review_id: "b1", created_timestamp: "2026-10-07 09:00:00", scoring: { review_score: 9 }, reviewer: { name: "Pieter" }, content: { headline: "Top", positive: "Rustig" } }];
    const now = new Date("2026-10-10T08:00:00Z");
    const r = await pullChannelReviews(env(false), now);
    expect(r).toMatchObject({ ran: true, fetched: 3, inserted: 3, low: 1 });
    const fromParam = calls.find((c) => c.path === "/channels/booking/reviews")!.query.get("from");
    expect(fromParam).toBe("2025-10-10");
    // moins de 6 h après : rien
    calls = [];
    expect((await pullChannelReviews(env(false), new Date("2026-10-10T12:00:00Z"))).ran).toBe(false);
    expect(calls).toHaveLength(0);
    // 7 h après, l'hôte a répondu à l'avis à 3 : mis à jour, pas dupliqué
    airbnbReviews["711714"] = [{ ...(airbnbReviews["711714"]![0] as object), reviewee_response: "Merci, le chauffage est réparé." }];
    const again = await pullChannelReviews(env(false), new Date("2026-10-10T15:00:00Z"));
    expect(again.inserted).toBe(0);
    const s = await api("GET", "/api/admin/reviews?property=1");
    expect(s.data.count).toBe(3);
    expect(s.data.average).toBe(4.2); // (5 + 3 + 4,5) / 3
    expect(s.data.latest[0].channel).toBe("booking");
    expect(s.data.low).toHaveLength(0); // l'avis à 3 a reçu une réponse
    expect(s.data.lowScore).toBe(4);
    expect(s.data.replyUrl).toMatch(/^https:\/\/beds24\.com\//);
  });

  it("cron : la relève tourne dans runLot3Scheduled, une panne ne casse rien", async () => {
    await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(REVIEWS_STATE_KEY).run();
    refuse = "/channels/booking/reviews";
    await expect(runLot3Scheduled(env(false), new Date("2026-10-11T08:00:00Z"))).resolves.toBeUndefined();
    const n = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'beds24.reviews.error'").first<{ n: number }>();
    expect(n?.n).toBeGreaterThan(0);
  });
});

describe("revue Codex 1", () => {
  it("prix dérivés tout ou rien : une propriété refuse, la précédente est remise, rien n'est activé", async () => {
    await t.db.prepare("UPDATE properties SET beds24_property_id = 999001 WHERE id = 2").run();
    const unit = await t.db.prepare("SELECT id FROM units WHERE property_id = 2 AND is_composite = 0 LIMIT 1").first<{ id: number }>();
    await t.db.prepare("UPDATE units SET beds24_room_id = 999101 WHERE id = ?1").bind(unit!.id).run();
    try {
      refuseProperty = 999001;
      const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
      expect(r.status).toBe(502);
      const posts = calls.filter((c) => c.path === "/properties" && c.method === "POST").map((c) => (c.body as Array<{ id: number; roomTypes: Array<{ priceRules: Array<Record<string, any>> }> }>)[0]!);
      // aller sur 344555, refus sur 999001, retour arrière sur 344555 (liens défaits)
      expect(posts.map((p) => p.id)).toEqual([344555, 999001, 344555]);
      expect(posts[2]!.roomTypes[0]!.priceRules[1]!.priceLinking).toEqual({ priceId: null });
      expect((await api("GET", "/api/admin/channels/price-linking")).data.enabled).toBe(false);
    } finally {
      await t.db.prepare("UPDATE properties SET beds24_property_id = NULL WHERE id = 2").run();
      await t.db.prepare("UPDATE units SET beds24_room_id = NULL WHERE id = ?1").bind(unit!.id).run();
    }
  });

  it("avis : toutes les pages lues ; une source en panne garde son curseur ; un vieil avis sous 4 reste signalé", async () => {
    await t.db.prepare("DELETE FROM channel_reviews").run();
    await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(REVIEWS_STATE_KEY).run();
    const many = (prefix: string, n: number, rating: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, reviewer_role: "guest", overall_rating: rating, public_review: "ok", submitted_at: `2026-0${prefix === "old" ? "1" : "9"}-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z` }));
    reviewPages = {
      "/channels/airbnb/reviews?711713": [many("p1-", 100, 5), many("p2-", 3, 5)],
      "/channels/airbnb/reviews?711714": [[...many("old", 1, 2), ...many("new", 40, 5)]],
    };
    refuse = "/channels/booking/reviews";
    const r = await pullChannelReviews(env(false), new Date("2026-10-12T08:00:00Z"));
    expect(r.fetched).toBe(144);
    const state = JSON.parse((await t.db.prepare("SELECT value FROM app_settings WHERE key = ?1").bind(REVIEWS_STATE_KEY).first<{ value: string }>())!.value);
    expect(state.ok["airbnb:711713"]).toBeTruthy();
    expect(state.ok["booking:344555"]).toBeUndefined();
    const s = await api("GET", "/api/admin/reviews?property=1");
    expect(s.data.low.map((x: { rating: number }) => x.rating)).toEqual([2]);
  });

  it("Cloudflare Access compte comme un humain (lien de ménage permis)", async () => {
    const res = await router.handle(new Request("http://test.local/api/admin/task-links", {
      method: "POST", headers: { "cf-access-jwt-assertion": "jeton", "content-type": "application/json" }, body: JSON.stringify({ label: "Ménage Access" }),
    }), { ...env(false), ADMIN_TOKEN: undefined } as Env);
    expect(res!.status).toBe(201);
  });
});

describe("revue Codex 2", () => {
  it("un renvoi de majorations refusé en partie remet les ANCIENS multiplicateurs, pas un état désactivé", async () => {
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: true })).status).toBe(200);
    await t.db.prepare("UPDATE properties SET beds24_property_id = 999001 WHERE id = 2").run();
    const unit = await t.db.prepare("SELECT id FROM units WHERE property_id = 2 AND is_composite = 0 LIMIT 1").first<{ id: number }>();
    await t.db.prepare("UPDATE units SET beds24_room_id = 999101 WHERE id = ?1").bind(unit!.id).run();
    try {
      const before = (await api("GET", "/api/admin/channel-markups")).data.channels as Array<{ channel: string; label: string; markupPct: number }>;
      const old = before.find((c) => c.channel === "airbnb")!.markupPct;
      calls = [];
      refuseProperty = 999001;
      const r = await api("PUT", "/api/admin/channel-markups", { channels: before.map((c) => (c.channel === "airbnb" ? { ...c, markupPct: 25 } : c)) });
      expect(r.data.linking.resent).toBe(false);
      const posts = calls.filter((c) => c.path === "/properties" && c.method === "POST").map((c) => (c.body as Array<{ id: number; roomTypes: Array<{ priceRules: Array<Record<string, any>> }> }>)[0]!);
      expect(posts.map((p) => p.id)).toEqual([344555, 999001, 344555]);
      expect(posts[0]!.roomTypes[0]!.priceRules[1]!.priceLinking.offsetMultiplier).toBe(1.25);
      // retour arrière : seul l'écart part (la ligne Airbnb, à son ancien multiplicateur)
      expect(posts[2]!.roomTypes[0]!.priceRules.find((r) => r.id === 2)!.priceLinking).toMatchObject({ priceId: 1, offsetMultiplier: 1 + old / 100 });
      expect((await api("GET", "/api/admin/channels/price-linking")).data.upToDate).toBe(false);
    } finally {
      await t.db.prepare("UPDATE properties SET beds24_property_id = NULL WHERE id = 2").run();
      await t.db.prepare("UPDATE units SET beds24_room_id = NULL WHERE id = ?1").bind(unit!.id).run();
      refuseProperty = null;
      await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    }
  });

  it("plus de pages d'avis que la limite : la source échoue et son curseur n'avance pas", async () => {
    await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(REVIEWS_STATE_KEY).run();
    reviewPages = { "/channels/airbnb/reviews?711713": Array.from({ length: 25 }, () => []) };
    const r = await pullChannelReviews(env(false), new Date("2026-10-13T08:00:00Z"));
    expect(r.errors.some((e) => e.includes("relève incomplète"))).toBe(true);
    const state = JSON.parse((await t.db.prepare("SELECT value FROM app_settings WHERE key = ?1").bind(REVIEWS_STATE_KEY).first<{ value: string }>())!.value);
    expect(state.ok["airbnb:711713"]).toBeUndefined();
  });
});
