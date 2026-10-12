// Remarques d'amélioration des testeurs : création (validation, auteur, page),
// liste filtrée avec compteurs, changement de statut et note, journal d'audit,
// ligne du résumé quotidien. Pas de suppression.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { collectDigest, renderDigest } from "../src/services/digest";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "arnold:jeton-testeur";
let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", ADMIN_TOKEN: `${ADMIN},sauvegarde:nuit` };
});
afterAll(async () => {
  await t.dispose();
});

async function call(method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (iPhone) essai" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

describe("remarques d'amélioration", () => {
  let id = 0;

  it("sans connexion : 401", async () => {
    expect((await call("POST", "/api/admin/improvements", null, { text: "bonjour", pagePath: "/" })).status).toBe(401);
    expect((await call("GET", "/api/admin/improvements", null)).status).toBe(401);
  });

  it("crée une remarque : auteur, page, largeur, navigateur coupé, journal", async () => {
    const r = await call("POST", "/api/admin/improvements", ADMIN, { text: "  Le bouton Envoyer est trop petit.  ", pagePath: "/reglages/tarifs", pageTitle: "Prix et saisons", viewportWidth: 390 });
    expect(r.status).toBe(200);
    const row = r.data.improvement;
    id = row.id;
    expect(row).toMatchObject({ author: "arnold", pagePath: "/reglages/tarifs", pageTitle: "Prix et saisons", text: "Le bouton Envoyer est trop petit.", status: "nouveau", viewportWidth: 390, adminNote: null });
    expect(row.userAgent).toContain("iPhone");
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'improvement.create'").first<{ n: number }>())?.n).toBe(1);
  });

  it("validation : texte trop court ou trop long, page absente, JSON illisible", async () => {
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "ab", pagePath: "/" })).status).toBe(400);
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "x".repeat(2001), pagePath: "/" })).status).toBe(400);
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "x".repeat(2000), pagePath: "/" })).status).toBe(200);
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "une remarque", pagePath: "" })).status).toBe(400);
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "une remarque" })).status).toBe(400);
    expect((await call("POST", "/api/admin/improvements", ADMIN, { text: "une remarque", pagePath: "/" + "a".repeat(300) })).status).toBe(400);
  });

  it("corps trop volumineux : 413 avant lecture", async () => {
    const res = await router.handle(new Request("http://test.local/api/admin/improvements", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", "content-length": "50000" }, body: JSON.stringify({ text: "abc", pagePath: "/" }) }), env);
    expect(res?.status).toBe(413);
  });

  it("le HTML reste du texte : stocké tel quel, renvoyé tel quel", async () => {
    const r = await call("POST", "/api/admin/improvements", ADMIN, { text: "<img src=x onerror=alert(1)>", pagePath: "/", pageTitle: "<b>x</b>" });
    expect(r.data.improvement.text).toBe("<img src=x onerror=alert(1)>");
  });

  it("une clé de service peut en déposer une, au nom de la clé", async () => {
    const key = await call("POST", "/api/admin/service-keys", ADMIN, { name: "claude-mac" });
    const r = await call("POST", "/api/admin/improvements", `svc:${String(key.data.key)}`, { text: "Idée venue de Claude", pagePath: "/avis" });
    expect(r.status).toBe(200);
    expect(r.data.improvement.author).toBe("svc:claude-mac");
  });

  it("liste : plus récentes d'abord, filtre par statut, compteurs", async () => {
    const all = await call("GET", "/api/admin/improvements", ADMIN);
    expect(all.status).toBe(200);
    expect(all.data.improvements.length).toBe(4);
    expect(all.data.improvements[0].id).toBeGreaterThan(all.data.improvements[3].id);
    expect(all.data.counts).toEqual({ nouveau: 4, en_cours: 0, fait: 0, ecarte: 0 });
    expect((await call("GET", "/api/admin/improvements?status=fait", ADMIN)).data.improvements).toEqual([]);
    expect((await call("GET", "/api/admin/improvements?status=nimporte", ADMIN)).status).toBe(400);
  });

  it("statut et note : modifiés, journal, erreurs", async () => {
    const r = await call("PATCH", `/api/admin/improvements/${id}`, ADMIN, { status: "en_cours", adminNote: "Vu avec Julien, à faire cette semaine." });
    expect(r.status).toBe(200);
    expect(r.data.improvement).toMatchObject({ status: "en_cours", adminNote: "Vu avec Julien, à faire cette semaine." });
    const audit = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'improvement.update'").first<{ detail: string }>();
    expect(JSON.parse(audit!.detail)).toMatchObject({ par: "arnold", status: "en_cours", avant: "nouveau" });
    // la note seule, puis vidée
    expect((await call("PATCH", `/api/admin/improvements/${id}`, ADMIN, { adminNote: "" })).data.improvement.adminNote).toBeNull();
    expect((await call("PATCH", `/api/admin/improvements/${id}`, ADMIN, { status: "bizarre" })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/improvements/${id}`, ADMIN, {})).status).toBe(400);
    expect((await call("PATCH", `/api/admin/improvements/${id}`, ADMIN, { adminNote: "x".repeat(2001) })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/improvements/99999", ADMIN, { status: "fait" })).status).toBe(404);
    const counts = (await call("GET", "/api/admin/improvements", ADMIN)).data.counts;
    expect(counts).toMatchObject({ nouveau: 3, en_cours: 1 });
  });

  it("pas de suppression", async () => {
    const res = await router.handle(new Request(`http://test.local/api/admin/improvements/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } }), env);
    expect(res === null || res.status === 404 || res.status === 405).toBe(true);
    expect((await call("GET", "/api/admin/improvements", ADMIN)).data.improvements.length).toBe(4);
  });

  it("le compte sauvegarde n'y a pas accès", async () => {
    expect((await call("GET", "/api/admin/improvements", "sauvegarde:nuit")).status).toBe(403);
  });

  it("le résumé quotidien annonce les nouvelles remarques", async () => {
    const data = await collectDigest(t.db, new Date());
    expect(data.newImprovements).toBe(4);
    expect(data.quiet).toBe(false);
    expect(renderDigest(data).bodyText).toContain("4 nouvelles remarques d'amélioration");
  });
});
