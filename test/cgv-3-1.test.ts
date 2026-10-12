// CGV v3.1 (migration 0036, décisions de Julien du 12/10/2026) : arrhes acquises
// quand le client annule, remboursement intégral plus une indemnité égale aux
// arrhes quand l'exploitant annule (art. 5.3, CDE VI.83, 27°), aucune autre
// indemnité, résumé « Comment ça se passe ».
// Vérifié contre une vraie base D1, toutes migrations rejouées : le texte des
// deux domaines, l'archivage de la v3, le rejeu de la migration, et la version
// enregistrée à l'acceptation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { acceptedVersionLabel, cgvArticle, cgvVersionLabel } from "../src/services/confirmation-pdf";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false" } as Env;
});
afterAll(async () => {
  await t.dispose();
});

const cgvOf = async (propertyId: number) =>
  (await t.db.prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'cgv_text'").bind(propertyId).first<{ value: string }>())!.value;

/** Les instructions de la migration 0036, découpées comme le font les deux migrateurs. */
function migration0036(): string[] {
  const sql = readFileSync(fileURLToPath(new URL("../migrations/0036_cgv_v3_1_annulation.sql", import.meta.url)), "utf8");
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}

describe("CGV v3.1 en base", () => {
  for (const propertyId of [1, 2]) {
    it(`domaine ${propertyId} : version 3.1 du 12 octobre 2026, 14 jours, arrhes, ni double ni 1590`, async () => {
      const cgv = await cgvOf(propertyId);
      expect(cgvVersionLabel(cgv)).toBe("3.1");
      expect(cgv).toContain("Version 3.1 — 12 octobre 2026.");
      expect(cgv).toContain("14 jours");
      expect(cgv).toContain("arrhes");
      expect(cgv.toLowerCase()).not.toContain("double");
      expect(cgv).not.toContain("1590");
      // « indemnité » n'est PROMISE qu'à l'art. 5.3 : ailleurs, seulement pour l'exclure
      const a53 = /^5\.3\. .*$/m.exec(cgv)![0];
      expect(a53).toContain("et lui verse en outre une indemnité égale au montant des arrhes.");
      const ailleurs = cgv.replace(a53, "");
      const mentions = [...ailleurs.matchAll(/indemnit/g)].map((x) => ailleurs.slice(Math.max(0, x.index! - 25), x.index! + 35));
      expect(mentions.length).toBeGreaterThan(0);
      for (const m of mentions) expect(m, m).toMatch(/sans indemnité|aucune autre indemnité|l'indemnité prévue à l'article 5\.3/);
      // vocabulaire : client et exploitant
      expect(cgv).not.toMatch(/locataire|propriétaire|contrat|\bbail\b/i);
      // le texte n'est pas tronqué par le découpage des migrations
      expect((cgv.match(/^Article \d+ /gm) ?? []).length).toBe(13);
      expect(cgv.trim().endsWith("les règles impératives de compétence et de protection lui restent acquises.")).toBe(true);
    });
  }

  it("les deux domaines ont le même texte", async () => {
    expect(await cgvOf(1)).toBe(await cgvOf(2));
  });

  it("le résumé « Comment ça se passe » ouvre le texte, avant l'article 1", async () => {
    const cgv = await cgvOf(1);
    const resume = cgv.indexOf("Comment ça se passe");
    expect(resume).toBeGreaterThan(0);
    expect(resume).toBeLessThan(cgv.indexOf("Article 1 —"));
    const bloc = cgv.slice(resume, cgv.indexOf("Article 1 —"));
    for (const etape of ["réservez en ligne", "acceptez les présentes conditions générales", "payez les arrhes", "confirmation de votre réservation", "récapitulatif", "solde au plus tard 30 jours avant l'arrivée", "Arrivée à partir de 18 h", "Départ avant 18 h", "par e-mail en rappelant votre référence"]) {
      expect(bloc, etape).toContain(etape);
    }
  });

  it("articles 4 et 5 : arrhes, solde à 30 jours, annulation par le client, par l'exploitant avec indemnité égale aux arrhes, force majeure sans indemnité, séjour entamé", async () => {
    const cgv = await cgvOf(1);
    const a4 = cgvArticle(cgv, 4)!;
    const a5 = cgvArticle(cgv, 5)!;
    expect(a4).toContain("Article 4 — Arrhes et paiement du solde");
    expect(a4).toContain("affiché lors de la réservation");
    expect(a4).toContain("30 jours avant l'arrivée");
    expect(a5).toContain("Article 5 — Caution et annulation");
    expect(a5).toContain("Aucune caution n'est demandée");
    expect(a5).toMatch(/5\.2\. Annulation par le client\..*les arrhes restent acquises à l'exploitant\..*remboursé dans les 14 jours, sur le moyen de paiement utilisé/s);
    expect(a5).toContain("5.3. Annulation par l'exploitant. Si l'exploitant annule la réservation, hors cas de force majeure, il rembourse au client tout ce que celui-ci a payé, arrhes comprises, dans les 14 jours, sur le moyen de paiement utilisé, et lui verse en outre une indemnité égale au montant des arrhes.");
    expect(a5).toMatch(/5\.4\. Force majeure\..*sans indemnité de part ni d'autre\./);
    expect(a5).toContain("5.5. Non-présentation et séjour entamé.");
    expect(a5).toContain("5.6. En dehors de l'indemnité prévue à l'article 5.3, aucune autre indemnité n'est due, ni par le client ni par l'exploitant.");
  });

  it("la v3 est archivée, et la migration se rejoue sans rien écraser", async () => {
    const archive = async () =>
      (await t.db.prepare("SELECT property_id, value FROM settings WHERE key = 'cgv_text_avant_3_1' ORDER BY property_id").all<{ property_id: number; value: string }>()).results;
    const before = await archive();
    expect(before.map((r) => r.property_id)).toEqual([1, 2]);
    for (const r of before) {
      expect(cgvVersionLabel(r.value)).toBe("3.0");
      expect(r.value).toContain("double des arrhes"); // c'est bien l'ancienne
    }
    const current = await cgvOf(1);
    for (const stmt of migration0036()) await t.db.prepare(stmt).run();
    expect(await archive()).toEqual(before); // la 3.1 n'est pas archivée par-dessus la v3
    expect(await cgvOf(1)).toBe(current);
    expect(await cgvOf(2)).toBe(current);
  });

  it("l'acceptation enregistre la version 3.1 (et le hash du texte affiché)", async () => {
    const checkin = addDays(todayInZone(), 150);
    const req = new Request("http://test.local/api/public/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({
        unitId: 2, checkin, checkout: addDays(checkin, 3), adults: 2, children: 0, paymentMode: "deposit", cgvAccepted: true,
        guest: { firstName: "Alix", lastName: "Essai", email: "alix@example.test", phone: "0470000001" },
      }),
    });
    const res = (await router.handle(req, env))!;
    expect(res.status).toBe(201);
    const { reference } = (await res.json()) as { reference: string };
    const row = await t.db.prepare("SELECT cgv_version, cgv_ip FROM bookings WHERE reference = ?1").bind(reference).first<{ cgv_version: string; cgv_ip: string }>();
    expect(row!.cgv_version).toMatch(/^v3\.1\+sha256:[0-9a-f]{16}-len\d+$/);
    expect(row!.cgv_version).toContain(`len${(await cgvOf(1)).length}`);
    expect(acceptedVersionLabel(row!.cgv_version)).toBe("3.1");
    expect(row!.cgv_ip).toBe("203.0.113.9");
  });
});
