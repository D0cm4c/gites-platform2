// Annulation et argent (CGV v3.1, articles 4-5 ; décisions de Julien du 12/10/2026 :
// seule indemnité, celle de l'exploitant qui annule, égale aux arrhes reçues).
//
//  - client (`par: "locataire"`) : arrhes acquises, solde remboursé par Stripe ;
//  - exploitant (`par: "proprietaire"`) : tout est rendu, plus une indemnité = arrhes, à virer à la main ;
//  - force majeure : tout est rendu, quelle que soit la partie, sans indemnité ;
//  - option non payée et réservation de canal : aucun mouvement d'argent ;
//  - jamais plus que l'encaissé, une double annulation ne rembourse pas deux fois ;
//  - un remboursement échoué ne bloque pas l'annulation et se rejoue.
// Stripe n'est jamais appelé pour de vrai : `fetch` est intercepté sur api.stripe.com.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { addPayment, getBooking } from "../src/db/repo";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const CHECKIN = addDays(todayInZone(), 90);
const CHECKOUT = addDays(CHECKIN, 5);

let t: TestDb;
let db: D1Database;
let env: Env;
let realFetch: typeof fetch;

interface StripeCall { url: string; method: string; body: URLSearchParams; headers: Headers }
let calls: StripeCall[] = [];
let refundSeq = 0;
/** Réponse de POST /refunds : "ok" | "pending" | "http500". */
let refundMode: "ok" | "pending" | "http500" | "requires_action" = "ok";
/** Ligne de remboursement que Stripe dit avoir DÉJÀ créée (métadonnée refund_row) ; sinon seul un remboursement manuel sans rapport existe. */
let remoteRefundRow: number | null = null;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN, STRIPE_SECRET_KEY: "sk_test_ann" } as Env;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: new URLSearchParams(String(init?.body ?? "")), headers: new Headers(init?.headers ?? {}) });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.endsWith("/refunds")) {
      if (refundMode === "http500") return json({ error: { message: "boom" } }, 500);
      refundSeq += 1;
      return json({ id: `re_test_${refundSeq}`, status: refundMode === "ok" ? "succeeded" : refundMode });
    }
    if (method === "GET" && /\/refunds\?/.test(url)) {
      return json({ data: remoteRefundRow == null ? [{ id: "re_manuel", status: "succeeded", metadata: {} }] : [{ id: "re_deja", status: "succeeded", metadata: { refund_row: String(remoteRefundRow) } }], has_more: false });
    }
    return json({});
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) await db.prepare(`DELETE FROM ${table}`).run();
  calls = [];
  refundSeq = 0;
  refundMode = "ok";
  remoteRefundRow = null;
});

async function call(method: string, path: string, body?: unknown) {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

async function mkBooking(o: { status?: string; source?: string; lang?: string; total?: number; deposit?: number; depositPct?: number } = {}): Promise<number> {
  const g = await db
    .prepare("INSERT INTO guests (email, first_name, last_name, lang) VALUES ('client@example.com', 'Camille', 'Testeur', ?1)")
    .bind(o.lang ?? "fr")
    .run();
  const res = await db
    .prepare(
      `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference, total_cents, deposit_cents, paid_cents, guest_id)
       VALUES (2, ?1, ?2, 2, 0, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
    )
    .bind(CHECKIN, CHECKOUT, o.status ?? "confirmed", o.source ?? "direct", `AN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, o.total ?? 100000, o.deposit ?? 30000, g.meta.last_row_id)
    .run();
  if (o.depositPct != null) {
    await db.prepare("UPDATE bookings SET quote_json = ?2 WHERE id = ?1").bind(res.meta.last_row_id, JSON.stringify({ depositPct: o.depositPct, totalCents: o.total ?? 100000 })).run();
  }
  return res.meta.last_row_id;
}
const stripePay = (bookingId: number, kind: "deposit" | "balance" | "full", amountCents: number, pi: string) =>
  addPayment(db, { bookingId, kind, method: "stripe", amountCents, status: "succeeded", stripeSessionId: pi, stripePaymentIntent: pi, receivedAt: "2026-10-01 10:00:00" });
const refundCalls = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/refunds"));
const mails = async () => (await db.prepare("SELECT kind, to_email, subject, body_text FROM email_log WHERE kind = 'cancellation'").all()).results as { subject: string; body_text: string }[];

describe("annulation par le client", () => {
  it("arrhes seules payées : tout reste acquis, rien à rembourser", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_a1");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "client malade" });
    expect(r.status).toBe(200);
    expect(r.data.plan).toMatchObject({ mode: "arrhes", par: "locataire", keptCents: 30000, refundCents: 0, stripeRefundCents: 0, indemnityCents: 0 });
    expect(refundCalls()).toHaveLength(0);
    expect(r.data.note).not.toContain("TODO");
    expect((await getBooking(db, id))!.status).toBe("cancelled");
  });

  it("arrhes + solde : le solde est remboursé par Stripe, les arrhes restent", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d1");
    await stripePay(id, "balance", 70000, "pi_b1");
    const sim = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", simuler: true });
    expect(sim.data.simule).toBe(true);
    expect(sim.data.plan).toMatchObject({ keptCents: 30000, refundCents: 70000, stripeRefundCents: 70000, manualRefundCents: 0 });
    expect(calls).toHaveLength(0);
    expect((await getBooking(db, id))!.status).toBe("confirmed"); // la simulation n'annule rien

    // sans confirmer, un plan qui rembourse par Stripe est refusé
    const refused = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x" });
    expect(refused.status).toBe(400);
    expect(refundCalls()).toHaveLength(0);

    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    expect(r.status).toBe(200);
    const sent = refundCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.get("payment_intent")).toBe("pi_b1");
    expect(sent[0]!.body.get("amount")).toBe("70000");
    expect(sent[0]!.headers.get("idempotency-key")).toMatch(/^gp-refund-\d+$/);
    const rows = (await db.prepare("SELECT kind, status, amount_cents, stripe_payment_intent, note FROM payments WHERE kind = 'refund'").all()).results as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", amount_cents: -70000, stripe_payment_intent: "pi_b1" });
    expect(rows[0].note).toContain("re_test_1");
    expect((await getBooking(db, id))!.paidCents).toBe(30000); // les arrhes restent encaissées
    const actions = (await db.prepare("SELECT action FROM audit_log").all()).results.map((x: any) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["booking.cancel", "refund.done"]));
  });

  it("prix total payé d'avance (arrivée à moins de 30 jours ou choix du client) : seules les arrhes au pourcentage du devis restent acquises (CGV 4.3)", async () => {
    // deposit_cents = montant demandé = prix total ; le devis fige 50 % d'arrhes.
    const id = await mkBooking({ total: 100000, deposit: 100000, depositPct: 50 });
    await stripePay(id, "full", 100000, "pi_f1");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    expect(r.data.plan).toMatchObject({ arrhesCents: 50000, keptCents: 50000, refundCents: 50000, stripeRefundCents: 50000 });
    expect(refundCalls().map((c) => [c.body.get("payment_intent"), c.body.get("amount")])).toEqual([["pi_f1", "50000"]]);
  });

  it("devis à 100 % d'arrhes : tout reste acquis ; sans devis lisible, repli sur le montant demandé", async () => {
    const full = await mkBooking({ total: 100000, deposit: 100000, depositPct: 100 });
    await stripePay(full, "full", 100000, "pi_f2");
    expect((await call("POST", `/api/admin/bookings/${full}/cancel`, { reason: "x", simuler: true })).data.plan).toMatchObject({ keptCents: 100000, refundCents: 0 });
    const sansDevis = await mkBooking({ total: 100000, deposit: 30000 });
    await stripePay(sansDevis, "deposit", 30000, "pi_f3");
    expect((await call("POST", `/api/admin/bookings/${sansDevis}/cancel`, { reason: "x", simuler: true })).data.plan).toMatchObject({ arrhesCents: 30000, keptCents: 30000 });
  });

  it("une seconde annulation ne rembourse pas une seconde fois", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d2");
    await stripePay(id, "balance", 70000, "pi_b2");
    expect((await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true })).status).toBe(200);
    expect((await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true })).status).toBe(409);
    expect(refundCalls()).toHaveLength(1);
  });

  it("jamais plus que l'encaissé : un solde en deux paiements est plafonné par paiement", async () => {
    const id = await mkBooking({ total: 100000, deposit: 30000 });
    await stripePay(id, "deposit", 30000, "pi_d3");
    await stripePay(id, "balance", 20000, "pi_b3a");
    await stripePay(id, "balance", 50000, "pi_b3b");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    const amounts = refundCalls().map((c) => [c.body.get("payment_intent"), c.body.get("amount")]);
    expect(amounts).toEqual([["pi_b3b", "50000"], ["pi_b3a", "20000"]]);
    expect(r.data.plan.stripeRefundCents).toBe(70000);
    expect(r.data.plan.refundCents).toBe(70000);
  });
});

describe("annulation par l'exploitant", () => {
  it("tout est rendu par Stripe, plus l'indemnité (= arrhes) à virer à la main", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d4");
    await stripePay(id, "balance", 70000, "pi_b4");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "travaux", par: "proprietaire", confirmer: true });
    expect(r.status).toBe(200);
    expect(r.data.plan).toMatchObject({ par: "proprietaire", keptCents: 0, refundCents: 100000, stripeRefundCents: 100000, manualRefundCents: 0, indemnityCents: 30000 });
    const total = refundCalls().reduce((s, c) => s + Number(c.body.get("amount")), 0);
    expect(total).toBe(100000); // jamais l'indemnité par Stripe : exactement l'encaissé
    expect(refundCalls().map((c) => c.body.get("payment_intent")).sort()).toEqual(["pi_b4", "pi_d4"]);
    expect((await getBooking(db, id))!.paidCents).toBe(0);
    const manual = await db.prepare("SELECT detail FROM audit_log WHERE action = 'refund.manual_due'").first<{ detail: string }>();
    expect(JSON.parse(manual!.detail)).toEqual({ indemnityCents: 30000, manualRefundCents: 0 });
    expect(r.data.note).toContain("Indemnité de 300,00 € à virer à la main");
    expect(r.data.note).not.toMatch(/double|1590/);
  });

  it("indemnité = arrhes réellement reçues : jamais plus que le payé, et au pourcentage du devis si tout a été payé d'avance", async () => {
    const partiel = await mkBooking({ total: 100000, deposit: 30000 });
    await stripePay(partiel, "deposit", 20000, "pi_p1"); // arrhes payées en partie
    expect((await call("POST", `/api/admin/bookings/${partiel}/cancel`, { reason: "x", par: "proprietaire", simuler: true })).data.plan).toMatchObject({ refundCents: 20000, indemnityCents: 20000 });
    const avance = await mkBooking({ total: 100000, deposit: 100000, depositPct: 50 });
    await stripePay(avance, "full", 100000, "pi_p2");
    expect((await call("POST", `/api/admin/bookings/${avance}/cancel`, { reason: "x", par: "proprietaire", simuler: true })).data.plan).toMatchObject({ refundCents: 100000, indemnityCents: 50000 });
  });

  it("« exploitant » et « client » sont acceptés comme synonymes de par", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d18");
    const owner = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", par: "exploitant", simuler: true });
    expect(owner.data.plan).toMatchObject({ par: "proprietaire", refundCents: 30000, keptCents: 0, indemnityCents: 30000 });
    const client = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", par: "client", simuler: true });
    expect(client.data.plan).toMatchObject({ par: "locataire", refundCents: 0, keptCents: 30000 });
  });

  it("un paiement par virement bancaire est rendu à la main, pas par Stripe", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d5");
    await addPayment(db, { bookingId: id, kind: "balance", method: "transfer", amountCents: 70000, status: "succeeded", receivedAt: "2026-10-02 10:00:00" });
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", par: "proprietaire", confirmer: true });
    expect(r.data.plan).toMatchObject({ stripeRefundCents: 30000, manualRefundCents: 70000, refundCents: 100000, indemnityCents: 30000 });
    expect(refundCalls()).toHaveLength(1);
    const manual = await db.prepare("SELECT detail FROM audit_log WHERE action = 'refund.manual_due'").first<{ detail: string }>();
    expect(JSON.parse(manual!.detail)).toEqual({ indemnityCents: 30000, manualRefundCents: 70000 });
  });
});

describe("exceptions des CGV", () => {
  it("force majeure invoquée par l'exploitant : tout est rendu, sans indemnité", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d13");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "inondation", par: "proprietaire", forceMajeure: true, confirmer: true });
    expect(r.data.plan).toMatchObject({ refundCents: 30000, keptCents: 0, forceMajeure: true, indemnityCents: 0 });
    expect(await db.prepare("SELECT detail FROM audit_log WHERE action = 'refund.manual_due'").first()).toBeNull();
    expect(r.data.note).toContain("Force majeure");
  });

  it("force majeure côté client (CGV 5.4) : les arrhes aussi sont rendues", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d19");
    await stripePay(id, "balance", 70000, "pi_b19");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "route coupée", forceMajeure: true, sejourEntame: true, confirmer: true });
    expect(r.data.plan).toMatchObject({ par: "locataire", keptCents: 0, refundCents: 100000, forceMajeure: true, sejourEntame: false });
  });

  it("séjour entamé : le trop-perçu au-delà du prix du séjour est rendu", async () => {
    const id = await mkBooking({ total: 100000, deposit: 30000 });
    await stripePay(id, "deposit", 30000, "pi_d16");
    await stripePay(id, "balance", 80000, "pi_b16"); // 1 100 € payés pour 1 000 €
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "no-show", sejourEntame: true, confirmer: true });
    expect(r.data.plan).toMatchObject({ keptCents: 100000, refundCents: 10000, stripeRefundCents: 10000 });
  });

  it("séjour entamé (no-show) : rien n'est restitué", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d14");
    await stripePay(id, "balance", 70000, "pi_b14");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "no-show", sejourEntame: true });
    expect(r.data.plan).toMatchObject({ keptCents: 100000, refundCents: 0, sejourEntame: true });
    expect(refundCalls()).toHaveLength(0);
  });

  it("séjour entamé ne s'applique pas à une annulation par l'exploitant", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d20");
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", par: "proprietaire", sejourEntame: true, simuler: true });
    expect(r.data.plan).toMatchObject({ keptCents: 0, refundCents: 30000, sejourEntame: false });
  });
});

describe("cas sans mouvement d'argent", () => {
  it("option non payée : rien à rembourser, pas de mail", async () => {
    const id = await mkBooking({ status: "pending" });
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "option expirée" });
    expect(r.status).toBe(200);
    expect(r.data.plan).toMatchObject({ mode: "sans_paiement", refundCents: 0, keptCents: 0, indemnityCents: 0 });
    expect(calls).toHaveLength(0);
    expect(await mails()).toHaveLength(0);
  });

  it("réservation d'un canal : aucun mouvement, même si des paiements sont notés", async () => {
    const id = await mkBooking({ source: "ical" });
    await db.prepare("UPDATE bookings SET channel_label = 'Airbnb' WHERE id = ?1").bind(id).run();
    await addPayment(db, { bookingId: id, kind: "manual", method: "other", amountCents: 50000, status: "succeeded" });
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "annulée sur Airbnb", par: "proprietaire", confirmer: true });
    expect(r.data.plan).toMatchObject({ mode: "canal", refundCents: 0, stripeRefundCents: 0, indemnityCents: 0 });
    expect(r.data.note).not.toMatch(/indemnit/i);
    expect(r.data.note).toContain("Airbnb");
    expect(calls).toHaveLength(0);
    expect(await mails()).toHaveLength(0);
  });

  it("réservation importée : même règle", async () => {
    const id = await mkBooking({ source: "import" });
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x" });
    expect(r.data.plan.mode).toBe("canal");
  });
});

describe("remboursement Stripe", () => {
  it("échoué : l'annulation tient, la ligne est signalée puis rejouée", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d6");
    await stripePay(id, "balance", 70000, "pi_b6");
    refundMode = "http500";
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    expect(r.status).toBe(200);
    expect((await getBooking(db, id))!.status).toBe("cancelled");
    expect(r.data.refunds[0]).toMatchObject({ status: "failed" });
    const failed = (await db.prepare("SELECT id, status, amount_cents FROM payments WHERE kind = 'refund'").first()) as any;
    expect(failed.status).toBe("failed");
    expect((await getBooking(db, id))!.paidCents).toBe(100000); // rien n'est parti
    const acts = (await db.prepare("SELECT action FROM audit_log").all()).results.map((x: any) => x.action);
    expect(acts).toContain("refund.failed");

    // rejeu : Stripe dit que rien n'est remboursé → on renvoie l'ordre
    refundMode = "ok";
    calls = [];
    const retry = await call("POST", `/api/admin/bookings/${id}/refunds/${failed.id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.data.refund.status).toBe("succeeded");
    expect(refundCalls()).toHaveLength(1);
    // même clé que le premier envoi : Stripe rend le remboursement déjà créé, au lieu d'en ouvrir un second
    expect(refundCalls()[0]!.headers.get("idempotency-key")).toBe(`gp-refund-${failed.id}`);
    expect((await getBooking(db, id))!.paidCents).toBe(30000);
    // et un second rejeu est refusé : la ligne n'est plus en échec
    expect((await call("POST", `/api/admin/bookings/${id}/refunds/${failed.id}/retry`)).status).toBe(409);
  });

  it("rejeu : si Stripe a déjà remboursé, on n'envoie PAS un second ordre", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d7");
    await stripePay(id, "balance", 70000, "pi_b7");
    refundMode = "http500";
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    const failed = (await db.prepare("SELECT id FROM payments WHERE kind = 'refund'").first()) as any;
    remoteRefundRow = failed.id; // la réponse s'était perdue mais le remboursement est passé
    calls = [];
    const retry = await call("POST", `/api/admin/bookings/${id}/refunds/${failed.id}/retry`);
    expect(retry.data.refund.status).toBe("succeeded");
    expect(refundCalls()).toHaveLength(0);
  });

  it("un statut Stripe inconnu n'est pas compté comme remboursé", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d11");
    await stripePay(id, "balance", 70000, "pi_b11");
    refundMode = "requires_action";
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    expect(r.data.refunds[0].status).toBe("failed");
    expect((await getBooking(db, id))!.paidCents).toBe(100000);
  });

  it("une panne après la préparation laisse une ligne pending, reprise par le rejeu avec la même clé", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d12");
    await stripePay(id, "balance", 70000, "pi_b12");
    const row = await addPayment(db, { bookingId: id, kind: "refund", method: "stripe", amountCents: -70000, status: "pending", stripePaymentIntent: "pi_b12", note: "remboursement du paiement #2" });
    await db.prepare("UPDATE bookings SET status = 'cancelled', cancel_reason = 'x', cancelled_at = datetime('now') WHERE id = ?1").bind(id).run();
    const retry = await call("POST", `/api/admin/bookings/${id}/refunds/${row}/retry`);
    expect(retry.status).toBe(200);
    expect(refundCalls()[0]!.headers.get("idempotency-key")).toBe(`gp-refund-${row}`);
  });

  it("un remboursement manuel fait dans Stripe ne passe pas pour celui de la ligne", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d15");
    await stripePay(id, "balance", 70000, "pi_b15");
    refundMode = "http500";
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    const failed = (await db.prepare("SELECT id FROM payments WHERE kind = 'refund'").first()) as any;
    refundMode = "ok";
    calls = [];
    const retry = await call("POST", `/api/admin/bookings/${id}/refunds/${failed.id}/retry`); // Stripe ne connaît que re_manuel
    expect(retry.data.refund.status).toBe("succeeded");
    expect(refundCalls()).toHaveLength(1);
  });

  it("pending (Bancontact) : la ligne compte comme remboursée", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d8");
    await stripePay(id, "balance", 70000, "pi_b8");
    refundMode = "pending";
    const r = await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    expect(r.data.refunds[0].status).toBe("succeeded");
  });
});

describe("mail au client", () => {
  it("part une fois, en français, avec le détail", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d9");
    await stripePay(id, "balance", 70000, "pi_b9");
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true });
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", confirmer: true }); // 409
    const m = await mails();
    expect(m).toHaveLength(1);
    expect(m[0]!.subject).toContain("Annulation de votre réservation");
    expect(m[0]!.body_text).toContain("restent acquises à l'exploitant");
    expect(m[0]!.body_text).toContain("Remboursement : 700,00 €, sur le moyen de paiement utilisé, sous 14 jours.");
    expect(m[0]!.body_text).not.toMatch(/indemnit|double|1590|IBAN|numéro de compte|propriétaire|locataire/i);
  });

  it("l'exploitant annule : tout est remboursé, et l'indemnité égale aux arrhes est annoncée avec la demande d'IBAN", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d21");
    await stripePay(id, "balance", 70000, "pi_b21");
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "travaux", par: "proprietaire", confirmer: true });
    const m = await mails();
    expect(m[0]!.body_text).toContain("Nous sommes au regret d'annuler");
    expect(m[0]!.body_text).toContain("arrhes comprises");
    expect(m[0]!.body_text).toContain("Remboursement : 1 000,00 €, sur le moyen de paiement utilisé, sous 14 jours.");
    expect(m[0]!.body_text).toContain("Une indemnité de 300,00 €, égale aux arrhes, vous sera virée en outre. Indiquez-nous votre IBAN en réponse à ce message.");
    expect(m[0]!.body_text).not.toMatch(/double|1590|propriétaire|locataire/i);
  });

  it("en néerlandais pour un client néerlandophone, avec la vergoeding et la demande d'IBAN si l'exploitant annule", async () => {
    const id = await mkBooking({ lang: "nl" });
    await stripePay(id, "deposit", 30000, "pi_d10");
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "x", par: "proprietaire", confirmer: true });
    const m = await mails();
    expect(m[0]!.subject).toContain("Annulering van uw reservering");
    expect(m[0]!.body_text).toContain("voorschot inbegrepen");
    expect(m[0]!.body_text).toContain("op het gebruikte betaalmiddel, binnen 14 dagen");
    expect(m[0]!.body_text).toContain("vergoeding gelijk aan het voorschot");
    expect(m[0]!.body_text).toContain("IBAN");
    expect(m[0]!.body_text).not.toMatch(/dubbele|eigenaar|huurder/i);
  });

  it("force majeure : le mail ne promet pas le double des arrhes", async () => {
    const id = await mkBooking();
    await stripePay(id, "deposit", 30000, "pi_d17");
    await call("POST", `/api/admin/bookings/${id}/cancel`, { reason: "inondation", par: "proprietaire", forceMajeure: true, confirmer: true });
    const m = await mails();
    expect(m[0]!.body_text).not.toContain("double");
    expect(m[0]!.body_text).not.toMatch(/indemnité|IBAN/);
    expect(m[0]!.body_text).toContain("Force majeure");
    expect(m[0]!.body_text).toContain("300,00");
  });
});

describe("validation", () => {
  it("par inconnu → 400, réservation inconnue → 404", async () => {
    const id = await mkBooking();
    expect((await call("POST", `/api/admin/bookings/${id}/cancel`, { par: "voisin" })).status).toBe(400);
    expect((await call("POST", `/api/admin/bookings/99999/cancel`, {})).status).toBe(404);
  });
});
