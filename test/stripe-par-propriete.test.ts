// Un compte Stripe par propriété (décision du 11/10/2026, migration 0030).
//
// Ce que ces tests verrouillent, dans l'ordre des risques :
//  1. chaque propriété encaisse avec SES clés (secrète et publiable), jamais avec
//     celles d'une autre, jamais avec un mélange de deux comptes ;
//  2. sans clés propres, le repli sur les variables d'environnement fonctionne ;
//  3. le webhook est vérifié avec le secret de la propriété de la route, et un
//     événement d'une autre propriété est refusé, même signé de son vrai secret ;
//  4. aucune clé n'est jamais renvoyée par l'API ni écrite dans le journal ;
//  5. les encaissements : frais et net, total par mois, CSV.
//
// Stripe n'est jamais appelé pour de vrai : `fetch` est intercepté sur la seule
// origine api.stripe.com.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { createServiceKey } from "../src/services/service-keys";
import { encaissementsCsv } from "../src/services/encaissements";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Camille", lastName: "Testeur", email: "camille.testeur@example.com", phone: "+32 470 00 00 00" };

// Deux comptes distincts, un par propriété.
const P1 = { sk: "sk_test_PREMORE0001", pk: "pk_test_PREMORE0001", wh: "whsec_PREMORE0001" };
const P2 = { sk: "sk_test_MOULIN0002", pk: "pk_test_MOULIN0002", wh: "whsec_MOULIN0002" };
const ENV_KEYS = { sk: "sk_test_ENVREPLI0003", pk: "pk_test_ENVREPLI0003", wh: "whsec_ENVREPLI0003" };

let t: TestDb;
let db: D1Database;
let env: Env;

interface StripeCall { url: string; method: string; body: URLSearchParams; headers: Headers }
let calls: StripeCall[] = [];
let seq = 0;
let balanceStatus = 200;
/** Frais que Stripe rendra pour une intention (absent = frais pas encore connus). */
let feeOf: Record<string, number> = {};
let realFetch: typeof fetch;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN } as Env;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: new URLSearchParams(String(init?.body ?? "")), headers: new Headers(init?.headers ?? {}) });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/balance")) {
      return balanceStatus === 200
        ? json({ object: "balance", livemode: false })
        : json({ error: { message: "Invalid API Key provided: sk_test_****" } }, balanceStatus);
    }
    const retrieved = method === "GET" ? /\/payment_intents\/(pi_[^/?]+)/.exec(url) : null;
    if (retrieved) {
      const id = retrieved[1]!;
      const fee = feeOf[id];
      return json({
        id,
        status: "succeeded",
        latest_charge: fee === undefined ? null : { balance_transaction: { fee, net: 5000 - fee } },
      });
    }
    if (url.endsWith("/payment_intents")) {
      seq += 1;
      const id = `pi_prop_${seq}`;
      return json({ id, client_secret: `${id}_secret_xyz` });
    }
    if (url.endsWith("/checkout/sessions")) {
      seq += 1;
      return json({ id: `cs_prop_${seq}`, url: `https://checkout.stripe.com/c/pay/cs_prop_${seq}` });
    }
    return json({ id: "pi_x", status: "canceled" });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "property_stripe"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  seq = 0;
  calls = [];
  feeOf = {};
  balanceStatus = 200;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { env?: Env; auth?: string } = {},
): Promise<{ status: number; data: Record<string, unknown>; text: string }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${opts.auth ?? ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : { ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, opts.env ?? env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
}

async function setKeys(propertyId: number, k: typeof P1, mode = "test") {
  const res = await call("PUT", `/api/admin/stripe/${propertyId}`, {
    secretKey: k.sk, publishableKey: k.pk, webhookSecret: k.wh, mode, accountLabel: `Compte ${propertyId}`,
  });
  expect(res.status).toBe(200);
}

/** Webhook signé pour de vrai (HMAC-SHA256), vers la route de la propriété. */
async function webhook(path: string, event: unknown, secret: string, opts: { env?: Env } = {}): Promise<number> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await router.handle(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${hex}` },
      body: payload,
    }),
    opts.env ?? env,
  );
  return res!.status;
}

async function book(unitId: number, opts: { env?: Env } = {}) {
  const created = await call("POST", "/api/public/bookings", {
    unitId, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0, paymentMode: "deposit", cgvAccepted: true, guest: GUEST,
  }, opts);
  expect(created.status).toBe(201);
  return created;
}
const paymentOf = (d: Record<string, unknown>) => d.payment as Record<string, unknown>;
const succeeded = (id: string) => ({ type: "payment_intent.succeeded", data: { object: { id, status: "succeeded" } } });

describe("les clés de la propriété servent à encaisser", () => {
  it("chaque propriété crée ses PaymentIntent avec SA clé secrète et rend SA clé publiable", async () => {
    await setKeys(1, P1);
    await setKeys(2, P2);

    const a = await book(2); // logement de la propriété 1
    expect(paymentOf(a.data).publishableKey).toBe(P1.pk);
    const callA = calls.filter((c) => c.url.endsWith("/payment_intents"))[0]!;
    expect(callA.headers.get("authorization")).toBe(`Bearer ${P1.sk}`);

    calls = [];
    const b = await book(4); // logement de la propriété 2
    expect(paymentOf(b.data).publishableKey).toBe(P2.pk);
    const callB = calls.filter((c) => c.url.endsWith("/payment_intents"))[0]!;
    expect(callB.headers.get("authorization")).toBe(`Bearer ${P2.sk}`);
    // Jamais la clé secrète dans la réponse publique.
    expect(a.text + b.text).not.toContain("sk_test_");
  });

  it("repli : sans clés propres, les variables d'environnement servent", async () => {
    const withEnv = { ...env, STRIPE_SECRET_KEY: ENV_KEYS.sk, STRIPE_PUBLISHABLE_KEY: ENV_KEYS.pk, STRIPE_WEBHOOK_SECRET: ENV_KEYS.wh } as Env;
    const a = await book(2, { env: withEnv });
    expect(paymentOf(a.data).publishableKey).toBe(ENV_KEYS.pk);
    expect(calls.find((c) => c.url.endsWith("/payment_intents"))!.headers.get("authorization")).toBe(`Bearer ${ENV_KEYS.sk}`);
    // Et la route historique vérifie le secret d'environnement.
    expect(await webhook("/api/webhooks/stripe", succeeded("pi_prop_1"), ENV_KEYS.wh, { env: withEnv })).toBe(200);
  });

  it("une propriété avec ses clés ignore l'environnement, l'autre l'utilise encore", async () => {
    await setKeys(1, P1);
    const withEnv = { ...env, STRIPE_SECRET_KEY: ENV_KEYS.sk, STRIPE_PUBLISHABLE_KEY: ENV_KEYS.pk } as Env;
    await book(2, { env: withEnv });
    expect(calls.find((c) => c.url.endsWith("/payment_intents"))!.headers.get("authorization")).toBe(`Bearer ${P1.sk}`);
    calls = [];
    await book(4, { env: withEnv });
    expect(calls.find((c) => c.url.endsWith("/payment_intents"))!.headers.get("authorization")).toBe(`Bearer ${ENV_KEYS.sk}`);
  });

  it("clé secrète seule : Checkout hébergé, jamais la clé publiable d'un autre compte", async () => {
    await call("PUT", "/api/admin/stripe/1", { secretKey: P1.sk, mode: "test" });
    const withEnv = { ...env, STRIPE_PUBLISHABLE_KEY: ENV_KEYS.pk } as Env;
    const a = await book(2, { env: withEnv });
    expect(paymentOf(a.data).mode).toBe("redirect");
    expect(paymentOf(a.data).publishableKey).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/checkout/sessions"))).toHaveLength(1);
  });

  it("sans aucune clé : simulateur, drapeau démo levé ; avec une clé propre : démo retiré", async () => {
    expect((await call("GET", "/api/public/today")).data.demo).toBe(true);
    const a = await book(2);
    expect(String(a.data.checkoutUrl)).toContain("/book/dev-pay.html");
    await setKeys(1, P1);
    expect((await call("GET", "/api/public/today")).data.demo).toBe(false);
  });
});

describe("webhook : une route par propriété", () => {
  it("le secret de la propriété valide ; celui d'une autre est refusé", async () => {
    await setKeys(1, P1);
    await setKeys(2, P2);
    const a = await book(2);
    const reference = String(a.data.reference);

    // Mauvais secret (celui de la propriété 2) sur la route de la propriété 1.
    expect(await webhook("/api/webhooks/stripe/1", succeeded("pi_prop_1"), P2.wh)).toBe(400);
    // Aucune route sans propriété ne valide un secret de propriété.
    expect(await webhook("/api/webhooks/stripe", succeeded("pi_prop_1"), P1.wh)).toBe(400);
    const still = (await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`)).data.booking as Record<string, unknown>;
    expect(still.status).toBe("pending");

    expect(await webhook("/api/webhooks/stripe/1", succeeded("pi_prop_1"), P1.wh)).toBe(200);
    const done = (await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`)).data.booking as Record<string, unknown>;
    expect(done.status).toBe("confirmed");
  });

  it("un événement d'une autre propriété est ignoré même signé de son vrai secret", async () => {
    await setKeys(1, P1);
    await setKeys(2, P2);
    const a = await book(2); // paiement de la propriété 1
    const reference = String(a.data.reference);
    // La propriété 2 « reçoit » l'identifiant du paiement de la propriété 1, signé avec SON secret.
    expect(await webhook("/api/webhooks/stripe/2", succeeded("pi_prop_1"), P2.wh)).toBe(200);
    const row = (await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`)).data.booking as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.paidCents).toBe(0);
    const audit = await db.prepare("SELECT action FROM audit_log WHERE action = 'webhook.property_mismatch'").all();
    expect(audit.results).toHaveLength(1);
  });

  it("propriété sans clés ni repli : 400 ; propriété inconnue : 404", async () => {
    expect(await webhook("/api/webhooks/stripe/2", succeeded("pi_x"), P2.wh)).toBe(400);
    expect(await webhook("/api/webhooks/stripe/99", succeeded("pi_x"), P2.wh)).toBe(404);
  });
});

describe("les clés ne ressortent jamais", () => {
  it("GET ne rend que des indicateurs, l'audit ne contient aucune clé", async () => {
    await setKeys(1, P1);
    const res = await call("GET", "/api/admin/stripe");
    expect(res.status).toBe(200);
    for (const secret of [P1.sk, P1.pk, P1.wh]) expect(res.text).not.toContain(secret);
    const p1 = (res.data.properties as Record<string, any>[]).find((p) => p.propertyId === 1)!;
    expect(p1.secret).toMatchObject({ set: true, hint: null });
    expect(p1.webhook.hint).toBeNull();
    // Aucune portion des secrets (seule la clé publiable, publique, montre ses 4 derniers caractères).
    expect(res.text).not.toMatch(/sk_|whsec_/);
    expect(p1.webhookPath).toBe("/api/webhooks/stripe/1");
    expect(p1.effective).toBe("property");
    expect(res.data.baseUrl).toBe("http://test.local");
    expect(res.data.events).toContain("payment_intent.succeeded");

    const put = await call("PUT", "/api/admin/stripe/1", { accountLabel: "Pré Moré SRL" });
    for (const secret of [P1.sk, P1.pk, P1.wh]) expect(put.text).not.toContain(secret);
    const logs = await db.prepare("SELECT detail FROM audit_log").all<{ detail: string | null }>();
    for (const l of logs.results) for (const secret of [P1.sk, P1.pk, P1.wh]) expect(l.detail ?? "").not.toContain(secret);
    // Les clés non renvoyées restent en place.
    await book(2);
    expect(calls.find((c) => c.url.endsWith("/payment_intents"))!.headers.get("authorization")).toBe(`Bearer ${P1.sk}`);
  });

  it("refuse une forme inattendue, un mode incohérent, et une clé de service", async () => {
    expect((await call("PUT", "/api/admin/stripe/1", { secretKey: "n_importe_quoi" })).status).toBe(400);
    const wrong = await call("PUT", "/api/admin/stripe/1", { secretKey: "sk_live_VRAIECLE0001", mode: "test" });
    expect(wrong.status).toBe(400);
    expect(wrong.text).not.toContain("VRAIECLE");
    expect((await call("PUT", "/api/admin/stripe/1", { secretKey: "sk_live_VRAIECLE0001", mode: "live" })).status).toBe(200);

    const { key } = await createServiceKey(db, "claude-test", "test");
    const svc = await call("PUT", "/api/admin/stripe/1", { mode: "test" }, { auth: `svc:${key}` });
    expect(svc.status).toBe(403);
  });

  it("une chaîne vide efface la clé : la propriété retombe sur le repli", async () => {
    await setKeys(1, P1);
    await call("PUT", "/api/admin/stripe/1", { secretKey: "" });
    const state = (await call("GET", "/api/admin/stripe")).data.properties as Record<string, any>[];
    expect(state.find((p) => p.propertyId === 1)!.effective).toBe("none");
  });
});

describe("Tester la clé", () => {
  it("clé valide : ok ; clé refusée : l'erreur de Stripe en clair, sans la clé", async () => {
    await setKeys(1, P1);
    const good = await call("POST", "/api/admin/stripe/1/test");
    expect(good.data).toMatchObject({ ok: true, source: "property" });
    expect(calls.find((c) => c.url.endsWith("/balance"))!.headers.get("authorization")).toBe(`Bearer ${P1.sk}`);

    balanceStatus = 401;
    const bad = await call("POST", "/api/admin/stripe/1/test");
    expect(bad.data.ok).toBe(false);
    expect(String(bad.data.error)).toContain("Invalid API Key");
    expect(bad.text).not.toContain(P1.sk);
  });

  it("sans clé ni repli : message clair, aucun appel à Stripe", async () => {
    const res = await call("POST", "/api/admin/stripe/2/test");
    expect(res.data.ok).toBe(false);
    expect(String(res.data.error)).toContain("Aucune clé");
    expect(calls).toHaveLength(0);
  });
});

describe("encaissements par propriété", () => {
  it("frais et net relevés au webhook, total par mois, CSV, séparation des propriétés", async () => {
    await setKeys(1, P1);
    await setKeys(2, P2);
    await book(2);
    feeOf["pi_prop_1"] = 175;
    expect(await webhook("/api/webhooks/stripe/1", succeeded("pi_prop_1"), P1.wh)).toBe(200);

    const r1 = ((await call("GET", "/api/admin/encaissements?property=1")).data.report) as Record<string, any>;
    expect(r1.rows).toHaveLength(1);
    expect(r1.rows[0]).toMatchObject({ feeCents: 175, kind: "deposit" });
    expect(r1.rows[0].netCents).toBe(5000 - 175);
    expect(r1.months).toHaveLength(1);
    expect(r1.totals.count).toBe(1);
    expect(r1.totals.feeCents).toBe(175);
    // L'autre propriété ne voit rien.
    const r2 = ((await call("GET", "/api/admin/encaissements?property=2")).data.report) as Record<string, any>;
    expect(r2.rows).toHaveLength(0);

    const csv = await call("GET", "/api/admin/encaissements.csv?property=1");
    expect(csv.status).toBe(200);
    // (text() retire le BOM d'Excel, présent dans les octets envoyés)
    expect(csv.text.startsWith("Date;")).toBe(true);
    expect(csv.text).toContain("Date;Réservation;Type;Brut (EUR);Frais Stripe (EUR);Net (EUR)");
    expect(csv.text).toContain("1,75");
    expect((await call("GET", "/api/admin/encaissements?property=0")).status).toBe(400);
  });

  it("frais pas encore connus : « inconnus », puis rattrapés par le relevé", async () => {
    await setKeys(1, P1);
    await book(2);
    expect(await webhook("/api/webhooks/stripe/1", succeeded("pi_prop_1"), P1.wh)).toBe(200);
    const before = ((await call("GET", "/api/admin/encaissements?property=1")).data.report) as Record<string, any>;
    expect(before.rows[0].feeCents).toBeNull();
    expect(before.totals.unknownFees).toBe(1);

    feeOf["pi_prop_1"] = 90;
    const fill = await call("POST", "/api/admin/encaissements/frais?property=1");
    expect(fill.data).toMatchObject({ ok: true, updated: 1, stillUnknown: 0 });
    const after = ((await call("GET", "/api/admin/encaissements?property=1")).data.report) as Record<string, any>;
    expect(after.rows[0].feeCents).toBe(90);
  });
});

describe("export CSV", () => {
  it("un remboursement reste un montant négatif, un texte piégé est neutralisé", () => {
    const csv = encaissementsCsv({
      propertyId: 1, from: null, to: null, months: [],
      totals: { count: 1, grossCents: -1200, feeCents: 0, netCents: 0, unknownFees: 1 },
      rows: [{ paymentId: 1, receivedAt: "2026-10-09 10:00:00", bookingId: 1, bookingReference: "=HYPERLINK(1)", kind: "refund", amountCents: -1200, feeCents: null, netCents: null, status: "succeeded", stripeRef: null }],
    });
    expect(csv).toContain(";-12,00;");
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});

describe("sauvegardes sans secrets, et route historique cloisonnée", () => {
  it("export.sql ne contient ni la clé secrète ni le secret du webhook", async () => {
    await setKeys(1, P1);
    const res = await call("GET", "/api/admin/export.sql");
    expect(res.status).toBe(200);
    const sql = String(res.data.raw ?? res.text);
    expect(sql).toContain("property_stripe");
    expect(sql).not.toContain(P1.sk);
    expect(sql).not.toContain(P1.wh);
  });

  it("la route historique (secret d'environnement) ne confirme pas le paiement d'une propriété qui a ses clés", async () => {
    await setKeys(1, P1);
    const withEnv = { ...env, STRIPE_SECRET_KEY: ENV_KEYS.sk, STRIPE_PUBLISHABLE_KEY: ENV_KEYS.pk, STRIPE_WEBHOOK_SECRET: ENV_KEYS.wh } as Env;
    const a = await book(2, { env: withEnv }); // propriété 1 : ses propres clés
    expect(await webhook("/api/webhooks/stripe", succeeded("pi_prop_1"), ENV_KEYS.wh, { env: withEnv })).toBe(200);
    const row = (await call("GET", `/api/public/bookings/${String(a.data.reference)}?email=${encodeURIComponent(GUEST.email)}`)).data.booking as Record<string, unknown>;
    expect(row.status).toBe("pending");
    const audit = await db.prepare("SELECT action FROM audit_log WHERE action = 'webhook.property_mismatch'").all();
    expect(audit.results).toHaveLength(1);
  });
});

describe("messages d'erreur", () => {
  it("une erreur Stripe qui répète la clé ne la laisse pas filer dans l'exception", async () => {
    await setKeys(1, P1);
    const before = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith("/payment_intents")) return new Response(`{"error":{"message":"Invalid API Key provided: ${P1.sk}"}}`, { status: 401 });
      return before(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const { createPaymentIntent } = await import("../src/services/stripe");
      const { resolveStripeConfig } = await import("../src/services/stripe-config");
      const cfg = await resolveStripeConfig(db, env, 1);
      const err = await createPaymentIntent(cfg, { paymentId: 1, reference: "PM-X", kind: "deposit", label: "x", amountCents: 1000 }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Invalid API Key");
      expect((err as Error).message).not.toContain(P1.sk);
    } finally {
      globalThis.fetch = before;
    }
  });
});
