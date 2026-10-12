// Prix dérivés par canal contre un faux Beds24 qui valide le schéma apiV2.yaml
// (contrôle du 10/10/2026 : POST /api/admin/channels/price-linking a répondu 502
// en production, « 1 élément(s) refusé(s) : "échec" », retour arrière en échec
// sur la propriété 359805). Les ids de production sont repris : propriété
// #359805, chambres #741844 (Scieur) et #741845 (Scierie).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { DEFAULT_RULE_1, FauxBeds24, PRICE_RULE_SCHEMA, validate } from "./helpers/beds24-faux";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "admin:jeton-prix-derives";
const PROP = 359805;
const SCIEUR = 741844;
const SCIERIE = 741845;
let t: TestDb;
const faux = new FauxBeds24();
interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];
/** Réponse 201 en texte brut (non JSON) au prochain POST /properties. */
let rawPost: string | null = null;
const realFetch = globalThis.fetch;

const env = (writes = true): Env => ({
  DB: t.db, ASSETS: undefined as unknown as Fetcher, ADMIN_TOKEN: ADMIN, PUBLIC_BASE_URL: "https://gites.exemple.be",
  BEDS24_REFRESH_TOKEN: "refresh-de-test", EMAILS_ENABLED: "false", ...(writes ? { BEDS24_WRITE_ENABLED: "true" } : {}),
});

async function api(method: string, path: string, body?: unknown, e: Env = env()) {
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

const posts = () => calls.filter((c) => c.method === "POST" && c.path === "/properties").map((c) => (c.body as Array<{ id: number; roomTypes: Array<{ id: number; priceRules: Array<Record<string, any>> }> }>)[0]!);
const etats = async () => ((await api("GET", "/api/admin/channels/price-linking?beds24=1")).data.live as Array<{ beds24PropertyId: number; rooms: Array<{ roomId: number; etat: string }> }>)
  .flatMap((p) => p.rooms.map((r) => `${r.roomId}:${r.etat}`));

beforeAll(async () => {
  t = await createTestDb();
  await t.db.prepare("UPDATE properties SET beds24_property_id = ?1 WHERE id = 1").bind(PROP).run();
  await t.db.prepare("UPDATE units SET beds24_room_id = ?1 WHERE id = 1").bind(SCIEUR).run();
  await t.db.prepare("UPDATE units SET beds24_room_id = ?1 WHERE id = 2").bind(SCIERIE).run();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.beds24.com") return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === "/authentication/token") return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    if (path === "/properties" && method === "POST" && rawPost != null) {
      const text = rawPost;
      rawPost = null;
      return new Response(text, { status: 201 });
    }
    if (path === "/properties") return method === "GET" ? faux.get(url.searchParams) : faux.post(body);
    if (method === "POST") return new Response(JSON.stringify((body as unknown[]).map(() => ({ success: true, modified: {} }))), { status: 201 });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  calls = [];
  faux.refuser = null;
  faux.partialRefusal = null;
  faux.readFails.clear();
  faux.props.clear();
  faux.seed(PROP, [SCIEUR, SCIERIE]);
  faux.seed(999001, [999101]);
  await t.db.prepare("UPDATE properties SET beds24_property_id = NULL WHERE id = 2").run();
  await t.db.prepare("UPDATE units SET beds24_room_id = NULL WHERE property_id = 2").run();
  await t.db.prepare("DELETE FROM app_settings WHERE key = 'channels.price_linking'").run();
  await t.db.prepare("DELETE FROM app_settings WHERE key = 'pricing.channel_markups'").run();
});

/** Relie une deuxième propriété Beds24 (999001) pour tester le tout ou rien. */
async function secondProperty() {
  await t.db.prepare("UPDATE properties SET beds24_property_id = 999001 WHERE id = 2").run();
  const unit = await t.db.prepare("SELECT id FROM units WHERE property_id = 2 AND is_composite = 0 LIMIT 1").first<{ id: number }>();
  await t.db.prepare("UPDATE units SET beds24_room_id = 999101 WHERE id = ?1").bind(unit!.id).run();
}

describe("schéma Beds24 (apiV2.yaml)", () => {
  it("le validateur du faux serveur refuse un champ inconnu, un type faux, une borne dépassée", () => {
    expect(validate(PRICE_RULE_SCHEMA, { id: 2, priceLinked: true })).toEqual([".priceLinked : champ inconnu"]);
    expect(validate(PRICE_RULE_SCHEMA, { id: 2, priceLinking: { priceId: "1" } })).toEqual([".priceLinking.priceId : entier attendu"]);
    expect(validate(PRICE_RULE_SCHEMA, { id: 17 })).toEqual([".id : au-dessus de 16"]);
    expect(validate(PRICE_RULE_SCHEMA, { id: 2, priceLinking: { priceId: null, offsetMultiplier: 10 } })).toEqual([".priceLinking.offsetMultiplier : au-dessus de 9.99"]);
    expect(validate(PRICE_RULE_SCHEMA, DEFAULT_RULE_1)).toEqual([]);
  });
});

describe("prix dérivés contre le faux Beds24", () => {
  it("essai : lit l'état, rend la charge utile, n'écrit rien (même écritures fermées)", async () => {
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true, essai: true }, env(false));
    expect(r.status).toBe(200);
    expect(r.data.essai).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const rules = r.data.envois[0][0].roomTypes[0].priceRules as Array<Record<string, unknown>>;
    for (const rule of rules) expect(validate(PRICE_RULE_SCHEMA, rule)).toEqual([]);
    expect(rules.map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(r.data.live[0].rooms.map((x: { etat: string }) => x.etat)).toEqual(["direct", "direct"]);
  });

  it("acceptation : charge utile conforme au schéma, état « derive » relu chez Beds24, puis retour au prix direct", async () => {
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(200);
    expect(await etats()).toEqual([`${SCIEUR}:derive`, `${SCIERIE}:derive`]);
    const scieur = faux.rules(SCIEUR);
    expect(scieur.find((x) => x.id === 3)).toMatchObject({ minimumStay: 2, priceLinking: { roomId: SCIEUR, priceId: 1, offsetMultiplier: 1.18 }, channels: { booking: { enabled: true } } });
    // l'audit garde ce qui est parti et la réponse de Beds24
    const a = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'beds24.price_linking' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
    expect(JSON.parse(a!.detail).journal.filter((j: { etape: string }) => j.etape === "envoi")[0].reponse).toEqual([{ success: true, modified: { id: PROP } }]);

    const off = await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    expect(off.status).toBe(200);
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`]);
    expect(faux.rules(SCIEUR).find((x) => x.id === 2)!.priceLinking).toBeUndefined();
    // rejouable : une deuxième désactivation passe aussi
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: false })).status).toBe(200);
  });

  it("désactiver sur une propriété sans ligne dérivée : seule la ligne 1 part, rien n'est créé", async () => {
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    expect(r.status).toBe(200);
    expect(posts()[0]!.roomTypes.map((rt) => rt.priceRules.map((x) => x.id))).toEqual([[1], [1]]);
    expect(faux.rules(SCIEUR).map((x) => x.id)).toEqual([1]);
  });

  it("refus sans `errors` (forme vue en production) : le motif remonte tel quel, jamais « échec »", async () => {
    faux.refuser = () => ({ success: false, modified: { id: PROP }, warnings: [{ action: "modify", field: "priceRules", message: "price linking not allowed on this room" }] });
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("price linking not allowed on this room");
    expect(r.data.error).not.toContain('"échec"');
    const brutMotif = JSON.stringify({ action: "modify", field: "priceRules", message: "price linking not allowed on this room" });
    expect(r.data.beds24).toEqual([{ success: false, modified: { id: PROP }, warnings: [{ action: "modify", field: "priceRules", message: "price linking not allowed on this room", raw: brutMotif }] }]);
    expect(r.data.journal.find((j: { etape: string }) => j.etape === "envoi").envoi[0].id).toBe(PROP);
    faux.refuser = () => ({ success: false });
    const bare = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(bare.data.error).toContain('réponse sans motif : {"success":false}');
    const a = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'beds24.price_linking_failed' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
    expect(JSON.parse(a!.detail).journal.some((j: { etape: string; envoi?: unknown }) => j.etape === "envoi" && j.envoi)).toBe(true);
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`]);
  });

  it("avertissements à clés inconnues : toutes les clés scalaires remontent mot pour mot ; {} est dit explicitement", async () => {
    faux.refuser = () => ({ success: false, modified: {}, warnings: [{ type: "x", field: "priceRules", message: "texte exact de Beds24", priceId: 1, nested: { a: 1 } }] });
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.data.error).toContain("priceRules : texte exact de Beds24");
    expect(r.data.error).toContain("type=x");
    expect(r.data.beds24[0].warnings[0]).toEqual({ type: "x", field: "priceRules", message: "texte exact de Beds24", priceId: 1, raw: JSON.stringify({ type: "x", field: "priceRules", message: "texte exact de Beds24", priceId: 1, nested: { a: 1 } }) });
    faux.refuser = () => ({ success: false, modified: {}, warnings: [{ reason: "linked rate unsupported", code2: 42 }, {}] });
    const autre = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(autre.data.error).toContain("reason=linked rate unsupported, code2=42");
    expect(autre.data.error).toContain("{} (Beds24 n'a rien dit)");
  });

  it("avertissement aux seules clés imbriquées : le JSON brut remonte ; {} reste « n'a rien dit »", async () => {
    faux.refuser = () => ({ success: false, modified: {}, warnings: [{ detail: { field: "priceRules", message: "x" } }] });
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.data.error).toContain('{} — brut : {"detail":{"field":"priceRules","message":"x"}}');
    expect(r.data.error).not.toContain("n'a rien dit");
    faux.refuser = () => ({ success: false, modified: {}, warnings: [{}] });
    const vide = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(vide.data.error).toContain("{} (Beds24 n'a rien dit)");
  });

  it("refus de forme (schéma) : le champ et le message de Beds24 remontent", async () => {
    faux.seed(PROP, [SCIEUR, SCIERIE], [{ ...DEFAULT_RULE_1, minimumStay: 31 }]); // recopié sur les lignes créées : hors borne
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("roomTypes.priceRules[1].minimumStay : au-dessus de 30");
  });

  it("une ligne de prix 2 à 16 déjà utilisée par autre chose n'est jamais écrasée", async () => {
    faux.seed(PROP, [SCIEUR, SCIERIE], [DEFAULT_RULE_1, { id: 3, name: "Tarif week-end", channels: { booking: { enabled: true } } }]);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("« Tarif week-end »");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("les lignes vierges que Beds24 crée d'office (2 à 16, sans nom ni lien ni canal) sont libres", async () => {
    faux.seed(PROP, [SCIEUR, SCIERIE], [DEFAULT_RULE_1, { id: 2, name: "" }, { id: 3 }, { id: 4, name: " ", channels: { booking: { enabled: false } }, bookingPage: { direct: true } }]);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(200);
    expect(faux.rules(SCIEUR).filter((x) => x.priceLinking).map((x) => x.id)).toEqual([2, 3, 4]);
  });

  it("retour arrière : la propriété qui a refusé et celles déjà passées reviennent à l'état lu avant", async () => {
    await secondProperty();
    faux.refuser = (pid) => (pid === 999001 ? { success: false, errors: [{ action: "modify", field: "priceRules", message: "refus du faux Beds24" }] } : null);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("priceRules : refus du faux Beds24");
    expect(r.data.error).toContain("retour arrière fait");
    expect(posts().map((p) => p.id)).toEqual([PROP, 999001, PROP]);
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`, "999101:direct"]);
    expect((await api("GET", "/api/admin/channels/price-linking")).data.enabled).toBe(false);
  });

  it("retour arrière en échec : le motif est dit, l'état partiel se voit, {enabled:false} remet le prix direct partout", async () => {
    await secondProperty();
    let firstAccepted = false;
    faux.refuser = (pid) => {
      if (pid === PROP && !firstAccepted) {
        firstAccepted = true;
        return null;
      }
      return { success: false, errors: [{ action: "modify", field: "priceRules", message: `refus #${pid}` }] };
    };
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.code).toBe("beds24_unknown");
    expect(r.data.error).toContain(`retour arrière a échoué sur la propriété Beds24 #${PROP} (`);
    expect(r.data.error).toContain(`refus #${PROP}`);
    expect(r.data.error).toContain('{"enabled":false}');
    expect(await etats()).toEqual([`${SCIEUR}:derive`, `${SCIERIE}:derive`, "999101:direct"]);
    faux.refuser = null;
    const fix = await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    expect(fix.status).toBe(200);
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`, "999101:direct"]);
  });

  it("lecture impossible : rien n'est envoyé", async () => {
    faux.readFails.add(PROP);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("rien n'a été envoyé");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("contrôle Codex 10/10", () => {
  it("essai non booléen : 400, rien ne part", async () => {
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true, essai: "true" });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("une ligne faite à la main liée à la ligne 1 n'est jamais touchée, ni à l'activation ni à la désactivation", async () => {
    const manuelle = { id: 6, name: "Tarif ami", priceLinking: { roomId: null, priceId: 1, offsetMultiplier: 0.9, offsetAmount: 0 }, channels: { booking: { enabled: true } } };
    faux.seed(PROP, [SCIEUR, SCIERIE], [DEFAULT_RULE_1, manuelle]);
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: true })).status).toBe(200);
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: false })).status).toBe(200);
    expect(posts().flatMap((p) => p.roomTypes.flatMap((rt) => rt.priceRules.map((x) => x.id)))).not.toContain(6);
    expect(faux.rules(SCIEUR).find((x) => x.id === 6)).toEqual(manuelle);
  });

  it("retirer un canal des majorations : sa ligne est fermée ET le canal revient sur la ligne 1 (lignes fixes par canal)", async () => {
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: true })).status).toBe(200);
    const r = await api("PUT", "/api/admin/channel-markups", { channels: [{ channel: "booking", label: "Booking.com", markupPct: 18 }, { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15 }] });
    expect(r.data.linking).toEqual({ resent: true });
    const scieur = faux.rules(SCIEUR);
    expect(scieur.find((x) => x.id === 1)!.channels).toMatchObject({ airbnb: { enabled: true }, booking: { enabled: false }, vrbo: { enabled: false } });
    expect(scieur.find((x) => x.id === 2)).toMatchObject({ channels: { airbnb: { enabled: false } } });
    expect(scieur.find((x) => x.id === 2)!.priceLinking).toBeUndefined();
    expect(scieur.find((x) => x.id === 3)).toMatchObject({ priceLinking: { priceId: 1, offsetMultiplier: 1.18 }, channels: { booking: { enabled: true } } });
    expect(await etats()).toEqual([`${SCIEUR}:derive`, `${SCIERIE}:derive`]);
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: false })).status).toBe(200);
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`]);
  });

  it("refus partiel (une chambre appliquée, élément refusé) : la propriété qui a refusé est remise, et rien ne reste dérivé", async () => {
    faux.partialRefusal = (pid) => (pid === PROP ? { success: false, modified: { id: PROP }, errors: [{ action: "modify", field: "priceRules", message: "refus partiel" }] } : null);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("refus partiel");
    expect(posts().map((p) => p.id)).toEqual([PROP, PROP]);
    faux.partialRefusal = null;
    expect(await etats()).toEqual([`${SCIEUR}:direct`, `${SCIERIE}:direct`]);
  });

  it("refus certain : la propriété qui a refusé n'est pas réécrite", async () => {
    faux.refuser = () => ({ success: false, errors: [{ action: "modify", field: "priceRules", message: "non" }] });
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(posts().map((p) => p.id)).toEqual([PROP]);
  });

  it("contrôle Codex 2 : liste priceRules en partie illisible ou sans ligne 1 → rien n'est envoyé", async () => {
    faux.seed(PROP, [SCIEUR, SCIERIE], [DEFAULT_RULE_1, { name: "sans id" }]);
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: false })).status).toBe(502);
    faux.seed(PROP, [SCIEUR, SCIERIE], [{ id: 2, name: "Airbnb (prix direct x 1,18)", priceLinking: { roomId: SCIEUR, priceId: 1, offsetMultiplier: 1.18, offsetAmount: 0 }, channels: { airbnb: { enabled: true } } }]);
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: false });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("pas de ligne de prix 1");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await etats()).toEqual([`${SCIEUR}:partiel`, `${SCIERIE}:partiel`]);
  });

  it("contrôle Codex 2 : une ligne existante garde sa page de réservation", async () => {
    faux.seed(PROP, [SCIEUR, SCIERIE], [DEFAULT_RULE_1, { id: 2, name: "Airbnb (prix direct × 1,18)", channels: { airbnb: { enabled: false } } }]);
    expect((await api("POST", "/api/admin/channels/price-linking", { enabled: true })).status).toBe(200);
    const sent = posts()[0]!.roomTypes[0]!.priceRules;
    expect(sent.find((x) => x.id === 2)!.bookingPage).toBeUndefined();
    expect(sent.find((x) => x.id === 3)!.bookingPage).toEqual({ direct: false, agent: false });
  });

  it("contrôle Codex 2 : un 201 non JSON n'est pas pris pour un succès", async () => {
    rawPost = "<html>Service Unavailable</html>";
    const r = await api("POST", "/api/admin/channels/price-linking", { enabled: true });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("réponse non JSON : <html>Service Unavailable</html>");
    expect((await api("GET", "/api/admin/channels/price-linking")).data.enabled).toBe(false);
  });
});
