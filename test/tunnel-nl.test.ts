// Tunnel de réservation en néerlandais (lot 3, #34) : dictionnaire complet du
// tunnel, textes du serveur traduits à la sortie de /api/public/* quand la page
// le demande, langue du client gardée et mails de confirmation en néerlandais,
// conditions générales en français avec la mention que la version française
// fait foi. Aucun réseau.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { localizePublicResponse, nlText } from "../src/core/public-i18n";
import { tunnelTexts } from "../scripts/tunnel-textes.mjs";
import { NL } from "../public/book/nl.js";

const router = new Router();
registerPublicRoutes(router);
let t: TestDb;
let env: Env;
const CHECKIN = addDays(todayInZone(), 130);
const CHECKOUT = addDays(CHECKIN, 7);

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: "x:y" };
});
afterAll(async () => {
  await t.dispose();
});

async function call(method: string, path: string, body?: unknown, lang?: "nl") {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(lang ? { "x-gites-lang": lang } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  const out = await localizePublicResponse(req, res);
  return { status: out.status, data: (await out.json()) as Record<string, any> };
}

describe("dictionnaire du tunnel", () => {
  it("chaque texte du tunnel a sa traduction, avec les mêmes variables", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    const keys = tunnelTexts();
    expect(keys.length).toBeGreaterThan(150);
    const dict = NL as Record<string, string>;
    for (const k of keys) {
      expect(dict[k], k).toBeTruthy();
      expect(vars(dict[k]!), k).toBe(vars(k));
    }
  });

  it("terminologie belge : voorschot, waarborg ; jamais « aanbetaling » ni « borg » seul", () => {
    const all = Object.values(NL as Record<string, string>).join("\n");
    expect(all).not.toMatch(/aanbetaling/i);
    expect((NL as Record<string, string>)["Caution (hors total, avant l'arrivée)"]).toMatch(/^Waarborg/);
    expect((NL as Record<string, string>)["Arrhes de <b>{arrhes}</b> à la réservation, solde de {solde} pour le {date}"]).toMatch(/Voorschot/);
  });
});

describe("textes du serveur", () => {
  it("lignes de devis, erreurs et phrase de disponibilité", () => {
    expect(nlText("3 nuits semaine · Été — La Scierie")).toBe("3 nachten week · Été — La Scierie");
    expect(nlText("1 nuit weekend")).toBe("1 nacht weekend");
    expect(nlText("Taxe de séjour (4 pers. × 7 nuits)")).toBe("Verblijfsbelasting (4 pers. × 7 nachten)");
    expect(nlText("Frais généraux — ménage et charges")).toBe("Algemene kosten — schoonmaak en lasten");
    expect(nlText("capacité dépassée (max 6 personnes)")).toBe("capaciteit overschreden (max. 6 personen)");
    expect(nlText("3 week-ends encore libres sur les 9 d'août et septembre.")).toBe("3 weekends nog vrij op de 9 van augustus en september.");
    expect(nlText("Prochain week-end libre : à partir du vendredi 16 octobre.")).toBe("Volgend vrij weekend: vanaf vrijdag 16 oktober.");
    expect(nlText("nombre d'adultes invalide")).toBe("ongeldig aantal volwassenen");
    expect(nlText("séjour trop long (max 60 nuits)")).toBe("verblijf te lang (max. 60 nachten)");
    expect(nlText("texte inconnu")).toBe("texte inconnu");
  });

  it("/api/public/* en néerlandais seulement quand la page le demande", async () => {
    const body = { unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 20, children: 0 };
    const fr = await call("POST", "/api/public/quote", body);
    const nl = await call("POST", "/api/public/quote", body, "nl");
    expect(fr.status).toBe(400);
    expect(fr.data.error).toMatch(/^capacité dépassée/);
    expect(nl.data.error).toMatch(/^capaciteit overschreden/);
    const ok = await call("POST", "/api/public/quote", { ...body, adults: 2 }, "nl");
    // Les lignes calculées sont traduites ; le nom d'une remise saisi par le
    // propriétaire (ligne « discount ») reste tel qu'il l'a écrit.
    const lines = ok.data.quote.lines as Array<{ label: string; kind: string }>;
    const labels = lines.filter((l) => l.kind !== "discount" && l.kind !== "promo").map((l) => l.label).join(" | ");
    expect(labels).toMatch(/nachten (week|weekend) · basistarief/);
    expect(labels).toMatch(/Algemene kosten/);
    expect(labels).not.toMatch(/\bnuits\b|tarif de base/);
  });
});

describe("réservation en néerlandais", () => {
  it("la langue du client est gardée : voucher et mail de confirmation en néerlandais, CGV en français avec la mention", async () => {
    const created = await call("POST", "/api/public/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0, paymentMode: "deposit",
      guest: { firstName: "Pieter", lastName: "Janssens", email: "pieter@example.be", phone: "+32 470 00 00 09" },
      cgvAccepted: true, lang: "nl",
    }, "nl");
    expect(created.status).toBe(201);
    const guest = await t.db.prepare("SELECT lang FROM guests WHERE email = 'pieter@example.be'").first<{ lang: string }>();
    expect(guest?.lang).toBe("nl");
    // la langue est aussi celle de CETTE réservation (revue Codex) : un client qui
    // réserve plus tard en français ne fait pas basculer celle-ci.
    expect((await t.db.prepare("SELECT lang FROM bookings WHERE reference = ?1").bind(created.data.reference).first<{ lang: string }>())?.lang).toBe("nl");
    const session = new URL(created.data.checkoutUrl as string).searchParams.get("session")!;
    expect((await call("POST", "/api/public/dev-pay/confirm", { session })).status).toBe(200);
    const mails = (await t.db.prepare("SELECT subject, body_text, kind FROM email_log WHERE to_email = 'pieter@example.be'").all<{ subject: string; body_text: string; kind: string }>()).results;
    const voucher = mails.find((m) => m.kind === "confirmation")!;
    expect(voucher.subject).toMatch(/^\[[A-Z]{2}-\d{4}-\d+\] Uw reservering is bevestigd/);
    expect(voucher.body_text).toMatch(/Uw reservering is bevestigd/);
    expect(voucher.body_text).toMatch(/De Franse versie is rechtsgeldend/);
    expect(voucher.body_text).toMatch(/voucher\.html\?ref=.*&lang=nl/);
    expect(voucher.body_text).toMatch(/Voorschot|Al betaald/);
  });

  it("un client francophone garde le mail français", async () => {
    const created = await call("POST", "/api/public/bookings", {
      unitId: 1, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0, paymentMode: "deposit",
      guest: { firstName: "Claire", lastName: "Dubois", email: "claire@example.be", phone: "+32 470 00 00 08" },
      cgvAccepted: true,
    });
    expect(created.status).toBe(201);
    const session = new URL(created.data.checkoutUrl as string).searchParams.get("session")!;
    await call("POST", "/api/public/dev-pay/confirm", { session });
    const voucher = await t.db.prepare("SELECT subject, body_text FROM email_log WHERE to_email = 'claire@example.be' AND kind = 'confirmation'").first<{ subject: string; body_text: string }>();
    expect(voucher!.subject).toMatch(/^\[[A-Z]{2}-\d{4}-\d+\] Votre réservation est confirmée/);
    expect(voucher!.body_text).not.toMatch(/lang=nl/);
  });
});
