// Issue #26 — paiement intégré (Stripe Payment Element) : PaymentIntent créé
// côté serveur, formulaire monté dans la page, carte + Bancontact + wallets.
//
// Ce que ces tests verrouillent, dans l'ordre des risques :
//  1. le montant et les métadonnées du PaymentIntent viennent du serveur ;
//  2. le webhook `payment_intent.succeeded` crédite UNE fois, rejeu compris ;
//  3. `payment_intent.payment_failed` n'annule RIEN — le hold reste payable ;
//  4. sans clé publique, le tunnel ne voit aucun Stripe et garde son simulateur.
//
// Stripe n'est jamais appelé pour de vrai : `fetch` est intercepté sur la seule
// origine api.stripe.com, tout le reste (D1 Miniflare) passe par le vrai.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import worker from "../src/index";
import { addDays, todayInZone } from "../src/core/dates";
import { PAYMENT_METHOD_TYPES } from "../src/services/stripe";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const WEBHOOK_SECRET = "whsec_test_26";
const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Camille", lastName: "Testeur", email: "camille.testeur@example.com", phone: "+32 470 00 00 00" };

let t: TestDb;
let db: D1Database;
let env: Env;

// --- interception des appels Stripe ----------------------------------------
interface StripeCall { url: string; body: URLSearchParams; headers: Headers }
let calls: StripeCall[] = [];
let intentSeq = 0;
/** Statut que Stripe rendra pour telle intention (défaut : annulable). */
let intentStatus: Record<string, string> = {};
let realFetch: typeof fetch;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
    STRIPE_SECRET_KEY: "sk_test_26",
    STRIPE_PUBLISHABLE_KEY: "pk_test_26",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as Env;

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body, headers: new Headers(init?.headers ?? {}) });
    // Relecture d'une intention : c'est elle qui dit si un paiement est déjà
    // parti chez la banque du client.
    const retrieved = method === "GET" ? /\/payment_intents\/(pi_[^/]+)$/.exec(url) : null;
    if (retrieved) {
      const id = retrieved[1]!;
      return new Response(JSON.stringify({ id, status: intentStatus[id] ?? "requires_payment_method" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/payment_intents")) {
      intentSeq += 1;
      const id = `pi_test_${intentSeq}`;
      return new Response(JSON.stringify({ id, client_secret: `${id}_secret_xyz` }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/checkout/sessions")) {
      intentSeq += 1;
      const id = `cs_test_${intentSeq}`;
      return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "pi_test", status: "canceled" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  // Les identifiants Stripe simulés repartent à 1 à chaque test : les
  // assertions peuvent nommer `pi_test_1` sans dépendre de l'ordre d'exécution.
  intentSeq = 0;
  intentStatus = {};
  calls = [];
});
afterEach(() => {
  calls = [];
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  overrideEnv?: Env,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : { ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, overrideEnv ?? env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/** Webhook Stripe signé pour de vrai (HMAC-SHA256, comme en production). */
async function webhook(event: unknown, secret = WEBHOOK_SECRET, overrideEnv?: Env): Promise<number> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const req = new Request("http://test.local/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${hex}` },
    body: payload,
  });
  const res = await router.handle(req, overrideEnv ?? env);
  return res!.status;
}

async function bookWithElement() {
  const created = await call("POST", "/api/public/bookings", {
    unitId: 2,
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 4,
    children: 0,
    paymentMode: "deposit",
    cgvAccepted: true,
    guest: GUEST,
  });
  expect(created.status).toBe(201);
  return created;
}

const paymentOf = (d: Record<string, unknown>) => d.payment as Record<string, unknown>;
const voucher = (reference: string) =>
  call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`);

describe("PaymentIntent — création côté serveur", () => {
  it("le montant et les métadonnées viennent du devis serveur, jamais du navigateur", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);
    const amountDue = Number(created.data.amountDueCents);

    const pay = paymentOf(created.data);
    expect(pay.mode).toBe("element");
    expect(String(pay.clientSecret)).toMatch(/^pi_test_\d+_secret_/);
    // Le tunnel ne reçoit AUCUNE URL de redirection en mode intégré.
    expect(created.data.checkoutUrl).toBeNull();
    expect(String(pay.returnUrl)).toContain("/book/merci.html?ref=");

    const intents = calls.filter((c) => c.url.endsWith("/payment_intents"));
    expect(intents).toHaveLength(1);
    const body = intents[0]!.body;
    expect(Number(body.get("amount"))).toBe(amountDue);
    expect(body.get("currency")).toBe("eur");
    expect(body.get("metadata[reference]")).toBe(reference);
    expect(body.get("metadata[kind]")).toBe("deposit");
    // L'email part en MÉTADONNÉE, jamais en `receipt_email` : ce champ ferait
    // envoyer un reçu par Stripe lui-même, en doublon du nôtre et hors de la
    // discipline EMAILS_ENABLED (contre-review Gemini 2026-08-30).
    expect(body.get("metadata[guest_email]")).toBe(GUEST.email);
    expect(body.get("receipt_email")).toBeNull();
    // Carte et Bancontact se règlent dans le tableau de bord Stripe (API 2026-09-30) :
    // le paramètre `payment_method_types` est refusé par Stripe, il ne part plus.
    expect(PAYMENT_METHOD_TYPES).toEqual(["card", "bancontact"]);
    expect(body.get("payment_method_types[0]")).toBeNull();
    // Idempotence : réservation + étape + montant.
    const idem = intents[0]!.headers.get("idempotency-key") ?? "";
    expect(idem).toContain(reference);
    expect(idem).toContain("deposit");
    expect(idem).toContain(String(amountDue));

    // La référence Stripe est écrite dans la colonne de réconciliation du
    // webhook — la même que Checkout, donc la même idempotence, sans migration.
    const row = await db
      .prepare("SELECT stripe_session_id, amount_cents, status FROM payments ORDER BY id DESC LIMIT 1")
      .first<{ stripe_session_id: string; amount_cents: number; status: string }>();
    expect(row!.stripe_session_id).toBe("pi_test_1");
    expect(row!.amount_cents).toBe(amountDue);
    expect(row!.status).toBe("pending");
  });

  it("une nouvelle tentative annule l'intention précédente chez Stripe", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);
    calls = [];

    // Le client revient sur son voucher et reclique « Finaliser » : deux
    // intentions vivantes pour le même montant, ce sont deux encaissements.
    const again = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(again.status).toBe(200);
    const cancels = calls.filter((c) => c.url.includes("/cancel"));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.url).toContain("pi_test_1");
    expect(paymentOf(again.data).clientSecret).not.toBe(paymentOf(created.data).clientSecret);

    const first = await db
      .prepare("SELECT status, note FROM payments WHERE stripe_session_id = 'pi_test_1'")
      .first<{ status: string; note: string | null }>();
    expect(first!.status).toBe("failed");
    expect(first!.note).toBe("session remplacée par une nouvelle");
  });
});

describe("webhook payment_intent — la notification serveur fait foi", () => {
  const succeeded = (id: string) => ({ type: "payment_intent.succeeded", data: { object: { id, status: "succeeded" } } });

  it("succeeded confirme la réservation, et un rejeu ne crédite pas deux fois", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);
    const amountDue = Number(created.data.amountDueCents);

    expect((await voucher(reference)).data.booking).toMatchObject({ status: "pending", paidCents: 0 });

    expect(await webhook(succeeded("pi_test_1"))).toBe(200);
    const once = (await voucher(reference)).data.booking as Record<string, unknown>;
    expect(once.status).toBe("confirmed");
    expect(once.paidCents).toBe(amountDue);

    // Stripe retente jusqu'à 3 jours : le rejeu ne doit rien recréditer, ni
    // renvoyer un second voucher.
    expect(await webhook(succeeded("pi_test_1"))).toBe(200);
    expect(await webhook(succeeded("pi_test_1"))).toBe(200);
    const twice = (await voucher(reference)).data.booking as Record<string, unknown>;
    expect(twice.paidCents).toBe(amountDue);

    const emails = (await call("GET", "/api/admin/email-log")).data.emails as { kind: string }[];
    expect(emails.filter((e) => e.kind === "confirmation")).toHaveLength(1);
    expect(emails.filter((e) => e.kind === "payment_receipt")).toHaveLength(1);
  });

  it("un paiement inconnu laisse une trace au lieu de disparaître", async () => {
    expect(await webhook(succeeded("pi_jamais_vu"))).toBe(200);
    const audits = await db
      .prepare("SELECT action FROM audit_log WHERE action = 'webhook.unmatched'")
      .all<{ action: string }>();
    expect(audits.results).toHaveLength(1);
  });

  it("payment_failed n'annule pas la réservation : le hold reste payable", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);

    expect(
      await webhook({
        type: "payment_intent.payment_failed",
        data: { object: { id: "pi_test_1", last_payment_error: { code: "card_declined" } } },
      }),
    ).toBe(200);

    // La réservation ne bouge pas — annuler ici détruirait un blocage que le
    // client est en train d'utiliser.
    const after = (await voucher(reference)).data.booking as Record<string, unknown>;
    expect(after.status).toBe("pending");
    expect(after.paidCents).toBe(0);

    // Seule la TENTATIVE est soldée, avec son motif au journal.
    const row = await db
      .prepare("SELECT status FROM payments WHERE stripe_session_id = 'pi_test_1'")
      .first<{ status: string }>();
    expect(row!.status).toBe("failed");
    const audits = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'payment.failed'")
      .all<{ detail: string }>();
    expect(audits.results).toHaveLength(1);
    expect(String(audits.results[0]!.detail)).toContain("card_declined");

    // Et le client peut réessayer immédiatement.
    const retry = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(retry.status).toBe(200);
    expect(paymentOf(retry.data).mode).toBe("element");
  });

  it("un échec arrivé APRÈS l'encaissement ne décrédite rien", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);
    const amountDue = Number(created.data.amountDueCents);
    await webhook(succeeded("pi_test_1"));
    await webhook({ type: "payment_intent.payment_failed", data: { object: { id: "pi_test_1" } } });
    const after = (await voucher(reference)).data.booking as Record<string, unknown>;
    expect(after.status).toBe("confirmed");
    expect(after.paidCents).toBe(amountDue);
  });

  it("une signature invalide est refusée avant toute lecture du corps", async () => {
    const created = await bookWithElement();
    expect(await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_test_1" } } }, "whsec_faux")).toBe(400);
    const after = (await voucher(String(created.data.reference))).data.booking as Record<string, unknown>;
    expect(after.status).toBe("pending");
  });
});

describe("paiement déjà parti chez la banque (Bancontact)", () => {
  it("refuse d'ouvrir une seconde intention tant que la première est `processing`", async () => {
    const created = await bookWithElement();
    const reference = String(created.data.reference);
    // Le client a validé chez sa banque ; Stripe attend la confirmation. Dans
    // cet état, `payment_intents/{id}/cancel` REFUSE — on marquait pourtant la
    // ligne locale `failed` et on en ouvrait une seconde : les deux
    // aboutissaient, double débit.
    intentStatus["pi_test_1"] = "processing";
    calls = [];

    // Passage par le Worker complet : c'est `src/index.ts` qui traduit le refus
    // métier en 409 lisible plutôt qu'en 500 « erreur interne ».
    const res = await worker.fetch(
      new Request(`http://test.local/api/public/bookings/${reference}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: GUEST.email }),
      }),
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("payment_in_flight");

    // Rien n'a bougé : ni annulation chez Stripe, ni seconde intention, ni
    // statut local retouché.
    expect(calls.filter((c) => c.url.includes("/cancel"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.endsWith("/payment_intents"))).toHaveLength(0);
    const row = await db
      .prepare("SELECT status FROM payments WHERE stripe_session_id = 'pi_test_1'")
      .first<{ status: string }>();
    expect(row!.status).toBe("pending");

    // Et le paiement finit par aboutir normalement, une seule fois.
    expect(await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_test_1" } } })).toBe(200);
    const after = (await voucher(reference)).data.booking as Record<string, unknown>;
    expect(after.status).toBe("confirmed");
    expect(after.paidCents).toBe(Number(created.data.amountDueCents));
  });

  it("un statut annulable laisse passer la nouvelle tentative", async () => {
    const created = await bookWithElement();
    intentStatus["pi_test_1"] = "requires_payment_method";
    const again = await call("POST", `/api/public/bookings/${String(created.data.reference)}/pay`, { email: GUEST.email });
    expect(again.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/cancel"))).toHaveLength(1);
  });
});

describe("configuration publique du paiement", () => {
  it("annonce la clé publique quand les deux clés sont posées", async () => {
    const cfg = (await call("GET", "/api/public/payment-config")).data;
    expect(cfg).toMatchObject({ enabled: true, ui: "element", publishableKey: "pk_test_26" });
    // La clé SECRÈTE ne sort jamais du Worker.
    expect(JSON.stringify(cfg)).not.toContain("sk_test");
  });

  it("sans clé : { enabled: false } et le simulateur local reste seul à l'écran", async () => {
    const stub = { ...env, STRIPE_SECRET_KEY: undefined, STRIPE_PUBLISHABLE_KEY: undefined } as Env;
    const cfg = (await call("GET", "/api/public/payment-config", undefined, stub)).data;
    expect(cfg).toEqual({ enabled: false });

    const created = await call("POST", "/api/public/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
      paymentMode: "deposit", cgvAccepted: true, guest: GUEST,
    }, stub);
    expect(created.status).toBe(201);
    expect(paymentOf(created.data).mode).toBe("redirect");
    expect(String(created.data.checkoutUrl)).toContain("/book/dev-pay.html?session=stub_");
    expect(calls.filter((c) => c.url.endsWith("/payment_intents"))).toHaveLength(0);
  });

  it("clé secrète seule (pas de clé publique) : repli sur Checkout hébergé", async () => {
    const noPk = { ...env, STRIPE_PUBLISHABLE_KEY: undefined } as Env;
    expect((await call("GET", "/api/public/payment-config", undefined, noPk)).data).toEqual({ enabled: false });
  });

  it("STRIPE_UI=checkout force le repli sans redéploiement de code", async () => {
    const forced = { ...env, STRIPE_UI: "checkout" } as Env;
    expect((await call("GET", "/api/public/payment-config", undefined, forced)).data).toEqual({ enabled: false });
    const created = await call("POST", "/api/public/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
      paymentMode: "deposit", cgvAccepted: true, guest: GUEST,
    }, forced);
    expect(created.status).toBe(201);
    expect(paymentOf(created.data).mode).toBe("redirect");
    expect(calls.filter((c) => c.url.endsWith("/checkout/sessions"))).toHaveLength(1);
  });
});
