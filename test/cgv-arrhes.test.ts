// Conditions générales v3 (migration 0019) et arrhes par hébergement (issue #75),
// vérifiées contre une vraie base D1 avec toutes les migrations rejouées.
//
// Ces deux sujets partagent un même point de rupture : le découpage naïf des
// migrations. Un point-virgule oublié dans le texte des CGV ne fait pas échouer
// la migration, il la TRONQUE. D'où l'assertion sur la dernière phrase du
// texte, qui est la seule à détecter la troncature.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});

// Chaque test repart du seed : deposit_pct des unités à 50 (migration 0015) et
// deposit_pct du domaine à 30 (seed 0002).
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
  await t.db.prepare("UPDATE units SET deposit_pct = 50").run();
  await t.db
    .prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'deposit_pct', '30')")
    .run();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : { ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("CGV injectées en base (0019, puis 0036 pour la v3.1)", () => {
  it("les deux domaines servent le texte définitif, sans placeholder", async () => {
    for (const slug of ["pre-more", "moulin-braives"]) {
      const res = await call("GET", `/api/public/properties/${slug}`);
      expect(res.status).toBe(200);
      const cgv = String(res.data.cgvText);
      expect(cgv).not.toContain("TODO_");
      expect(cgv).toContain("CONDITIONS GÉNÉRALES DE LOCATION");
      expect(cgv).toContain("Jean-Philippe de Cartier d'Yves");
    }
  });

  it("le texte n'est pas tronqué par le découpage des migrations", async () => {
    const res = await call("GET", "/api/public/properties/pre-more");
    const cgv = String(res.data.cgvText);
    // 13 articles, du premier au dernier, et la toute dernière phrase.
    expect((cgv.match(/^Article \d+ /gm) ?? []).length).toBe(13);
    expect(cgv).toContain("Article 1 — Parties et objet");
    expect(cgv).toContain("Article 13 — Droit applicable et litiges");
    expect(
      cgv.trim().endsWith("les règles impératives de compétence et de protection lui restent acquises."),
    ).toBe(true);
  });

  it("le texte reste cohérent avec les réglages en vigueur", async () => {
    const res = await call("GET", "/api/public/properties/pre-more");
    const cgv = String(res.data.cgvText);
    const settings = res.data.settings as { checkinTime: string; checkoutTime: string; cautionCents: number };

    // Horaires : migration 0009 (18 h / 18 h, rotation le jour même).
    expect(settings.checkinTime).toBe("18:00");
    expect(settings.checkoutTime).toBe("18:00");
    expect(cgv).toContain("Arrivée à partir de 18 h, départ avant 18 h");

    // Caution : remise à 0 par la migration 0007, régime « arrhes seules ».
    expect(settings.cautionCents).toBe(0);
    expect(cgv).toContain("Aucune caution n'est demandée");

    // Le pourcentage d'arrhes n'est PAS figé : il renvoie à l'affichage.
    expect(cgv).toContain("affiché lors de la réservation");
  });

  it("ne mentionne plus les draps, la taxe de séjour, la TVA ni un enregistrement", async () => {
    for (const slug of ["pre-more", "moulin-braives"]) {
      const res = await call("GET", `/api/public/properties/${slug}`);
      const cgv = String(res.data.cgvText);
      for (const mot of ["draps", "linge", "taies", "taxe de séjour", "TVA", "enregistrement"]) {
        expect(cgv.toLowerCase()).not.toContain(mot.toLowerCase());
      }
      // Le réglage est à 0 sur les deux domaines...
      const tax = await t.db
        .prepare("SELECT value FROM settings WHERE key = 'tourist_tax_cents_per_person_night' AND property_id = ?1")
        .bind(slug === "pre-more" ? 1 : 2)
        .first<{ value: string }>();
      expect(tax?.value).toBe("0");

      // ...et le devis n'en porte donc plus la ligne, quel que soit le nombre
      // d'occupants (computeQuote n'émet la ligne que si le montant est > 0).
      const quote = await call("POST", "/api/public/quote", {
        unitId: slug === "pre-more" ? 1 : 4,
        checkin: CHECKIN,
        checkout: CHECKOUT,
        adults: 4,
        children: 2,
      });
      const lines = (quote.data.quote as { lines: { kind: string; label: string }[] }).lines;
      expect(lines.some((l) => l.kind === "tax")).toBe(false);
      for (const l of lines) {
        expect(l.label.toLowerCase()).not.toContain("draps");
        expect(l.label.toLowerCase()).not.toContain("taxe");
      }
    }
  });

  it("la preuve d'acceptation porte sur le texte complet", async () => {
    const res = await call("POST", "/api/public/bookings", {
      unitId: 2,
      checkin: CHECKIN,
      checkout: CHECKOUT,
      adults: 2,
      children: 0,
      guest: { lastName: "Dupuis", email: "essai@example.test", phone: "0470000000" },
      cgvAccepted: true,
      paymentMode: "deposit",
    });
    expect(res.status).toBe(201);
    const row = await t.db
      .prepare("SELECT cgv_version FROM bookings WHERE reference = ?1")
      .bind(res.data.reference)
      .first<{ cgv_version: string }>();
    const cgv = await t.db
      .prepare("SELECT value FROM settings WHERE property_id = 1 AND key = 'cgv_text'")
      .first<{ value: string }>();
    expect(row?.cgv_version).toContain(`len${cgv?.value.length}`);
  });
});

describe("arrhes par hébergement (issue #75)", () => {
  it("le seed pose 50 % sur tous les hébergements existants", async () => {
    const { results } = await t.db.prepare("SELECT id, deposit_pct FROM units ORDER BY id").all();
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results as { deposit_pct: number }[]) expect(r.deposit_pct).toBe(50);
  });

  it("la fiche domaine expose le pourcentage EFFECTIF de chaque hébergement", async () => {
    await call("PATCH", "/api/admin/units/2", { depositPct: null });
    const res = await call("GET", "/api/public/properties/pre-more");
    const units = res.data.units as { id: number; depositPct: number }[];
    expect(units.find((u) => u.id === 1)?.depositPct).toBe(50); // valeur propre
    expect(units.find((u) => u.id === 2)?.depositPct).toBe(30); // repli domaine
  });

  it("30 % et 50 % sur deux hébergements donnent des devis distincts", async () => {
    await call("PATCH", "/api/admin/units/1", { depositPct: 30 });
    const a = await call("POST", "/api/public/quote", {
      unitId: 1, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    const b = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    const qa = a.data.quote as { totalCents: number; depositCents: number; depositPct: number };
    const qb = b.data.quote as { totalCents: number; depositCents: number; depositPct: number };

    expect(qa.depositPct).toBe(30);
    expect(qb.depositPct).toBe(50);
    expect(qa.depositCents).toBe(Math.round((qa.totalCents * 30) / 100));
    expect(qb.depositCents).toBe(Math.round((qb.totalCents * 50) / 100));
  });

  it("hébergement sans valeur propre : le devis retombe sur le domaine", async () => {
    await t.db
      .prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'deposit_pct', '40')")
      .run();
    await call("PATCH", "/api/admin/units/2", { depositPct: null });

    const res = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    const q = res.data.quote as { totalCents: number; depositCents: number; depositPct: number };
    expect(q.depositPct).toBe(40);
    expect(q.depositCents).toBe(Math.round((q.totalCents * 40) / 100));
  });

  it("la réservation encaisse bien les arrhes de l'hébergement réservé", async () => {
    const quote = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    const expected = (quote.data.quote as { depositCents: number }).depositCents;

    const res = await call("POST", "/api/public/bookings", {
      unitId: 2,
      checkin: CHECKIN,
      checkout: CHECKOUT,
      adults: 2,
      children: 0,
      guest: { lastName: "Lambert", email: "arrhes@example.test", phone: "0470000001" },
      cgvAccepted: true,
      paymentMode: "deposit",
    });
    expect(res.status).toBe(201);
    const row = await t.db
      .prepare("SELECT deposit_cents FROM bookings WHERE reference = ?1")
      .bind(res.data.reference)
      .first<{ deposit_cents: number }>();
    expect(row?.deposit_cents).toBe(expected);
  });

  it("le voucher expose le pourcentage FIGÉ au moment de la réservation", async () => {
    const email = "voucher@example.test";
    const created = await call("POST", "/api/public/bookings", {
      unitId: 2,
      checkin: CHECKIN,
      checkout: CHECKOUT,
      adults: 2,
      children: 0,
      guest: { lastName: "Renard", email, phone: "0470000003" },
      cgvAccepted: true,
      paymentMode: "deposit",
    });
    expect(created.status).toBe(201);

    // Le propriétaire change d'avis APRÈS la réservation : le contrat déjà
    // conclu ne bouge pas.
    await call("PATCH", "/api/admin/units/2", { depositPct: 20 });

    const res = await call(
      "GET",
      `/api/public/bookings/${encodeURIComponent(String(created.data.reference))}?email=${encodeURIComponent(email)}`,
    );
    expect(res.status).toBe(200);
    expect((res.data.booking as { depositPct: number }).depositPct).toBe(50);
  });

  it("le back-office refuse un pourcentage hors bornes", async () => {
    const res = await call("PATCH", "/api/admin/units/1", { depositPct: 140 });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("pourcentage");
  });
});

// Le pourcentage d'arrhes se règle par hébergement : une valeur figée dans une
// page publique finit toujours par mentir. Les pages ont annoncé 30 % pendant
// que le réglage en vigueur était 50 % — ce test empêche la rechute.
describe("pages publiques — pourcentage d'arrhes non figé", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  const PAGES = [
    "public/index.html",
    "public/la-maison-du-scieur/index.html",
    "public/la-scierie/index.html",
    "public/le-moulin-de-braives/index.html",
  ];

  it("aucune page n'écrit un pourcentage d'arrhes en dur", () => {
    for (const page of PAGES) {
      expect(read(page), page).not.toMatch(/[Aa]rrhes\s+(de\s+)?\d+\s*%/);
    }
  });

  it("chaque mention porte les attributs d'injection et un repli lisible", () => {
    for (const page of PAGES) {
      const html = read(page);
      expect(html, page).toMatch(/data-deposit-unit="[^"]+" data-deposit-property="[^"]+"/);
      expect(html, page).toContain("selon l'hébergement");
    }
  });

  it("le module d'injection lit le pourcentage EFFECTIF servi par la fiche domaine", async () => {
    const js = read("public/arrhes.js");
    expect(js).toContain("/api/public/properties/");
    expect(js).toContain("depositPct");

    // Contrat côté serveur : la fiche expose bien un depositPct par hébergement.
    const res = await call("GET", "/api/public/properties/pre-more");
    const units = res.data.units as { id: number; depositPct: number }[];
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) expect(typeof u.depositPct).toBe("number");
  });
});
