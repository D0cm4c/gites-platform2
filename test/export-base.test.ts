// Export de la base pour la sauvegarde de nuit tirée depuis le Mac (sans SSH) :
//  - /api/admin/export.sqlite sur la cible Node (VACUUM INTO, base SQLite
//    réelle : node/sqlite-d1.mjs + node/migrate.mjs, comme chez Infomaniak) ;
//  - /api/admin/export.sql sur D1 (Miniflare), rejoué dans une base vide ;
//  - le compte réservé « sauvegarde » n'ouvre que l'export.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// modules JS (node/), hors du typecheck de src/
import { openDatabase, snapshotSqlite } from "../node/sqlite-d1.mjs";
import { applyMigrations } from "../node/migrate.mjs";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { createTestDb, type TestDb } from "./helpers/d1";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "admin:jeton-de-test";

async function call(env: Env, method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return res;
}

describe("export.sqlite (cible Node, base SQLite réelle)", () => {
  let dir = "";
  let d1: { close: () => void; raw: DatabaseSync };
  let env: Env;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gites-export-"));
    d1 = openDatabase(join(dir, "gites.db"));
    applyMigrations(d1, join(process.cwd(), "migrations"));
    env = {
      DB: d1 as unknown as D1Database, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local",
      ADMIN_TOKEN: ADMIN, SQLITE_SNAPSHOT: async () => snapshotSqlite(d1, dir),
    };
  });
  afterAll(() => {
    d1.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rend un fichier SQLite complet et intègre, et ne laisse aucun temporaire", async () => {
    const res = await call(env, "GET", "/api/admin/export.sqlite", ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");
    const copie = join(dir, "copie.sqlite");
    writeFileSync(copie, bytes);
    const c = new DatabaseSync(copie, { readOnly: true });
    try {
      expect((c.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
      const tables = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
      for (const t of ["_migrations", "properties", "units", "bookings", "channel_messages"]) expect(tables).toContain(t);
      const units = (c.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
      expect(units).toBeGreaterThan(0);
    } finally {
      c.close();
    }
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.startsWith(".export-"))).toEqual([]);
    const audit = d1.raw.prepare("SELECT action FROM audit_log WHERE action = 'export.sqlite'").all();
    expect(audit.length).toBe(1);
  });

  it("refuse sans authentification", async () => {
    expect((await call(env, "GET", "/api/admin/export.sqlite", null)).status).toBe(401);
  });

  it("n'emporte pas les secrets Stripe des propriétés (migration 0030)", async () => {
    d1.raw.exec("INSERT INTO property_stripe (property_id, secret_key, publishable_key, webhook_secret) VALUES (1, 'sk_test_SECRETAEXCLURE01', 'pk_test_PUBLIQUE000001', 'whsec_SECRETAEXCLURE01')");
    try {
      const res = await call(env, "GET", "/api/admin/export.sqlite", ADMIN);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).not.toContain("SECRETAEXCLURE01");
      expect(text).toContain("PUBLIQUE000001");
      // La base vivante, elle, garde ses clés.
      expect((d1.raw.prepare("SELECT secret_key AS k FROM property_stripe").get() as { k: string }).k).toBe("sk_test_SECRETAEXCLURE01");
    } finally {
      d1.raw.exec("DELETE FROM property_stripe");
    }
  });
});

describe("export.sql (D1) et compte « sauvegarde »", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", ADMIN_TOKEN: ADMIN };
  });
  afterAll(async () => {
    await t.dispose();
  });

  it("sur D1, export.sqlite répond 501 et renvoie vers export.sql", async () => {
    const res = await call(env, "GET", "/api/admin/export.sqlite", ADMIN);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain("export.sql");
  });

  it("export.sql se rejoue en entier dans une base vide (schéma, données, apostrophes)", async () => {
    await t.db.prepare("INSERT INTO app_settings (key, value) VALUES ('essai_export', 'l''apostrophe ; et -- tirets')").run();
    const res = await call(env, "GET", "/api/admin/export.sql", ADMIN);
    expect(res.status).toBe(200);
    const sql = await res.text();
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    const c = new DatabaseSync(":memory:");
    try {
      c.exec(sql);
      expect((c.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
      const v = c.prepare("SELECT value FROM app_settings WHERE key = 'essai_export'").get() as { value: string };
      expect(v.value).toBe("l'apostrophe ; et -- tirets");
      // (la base de test rejoue les migrations sans table d1_migrations : on compte les données du seed)
      const n = (c.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
      expect(n).toBeGreaterThan(0);
      const tables = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain("channel_messages");
      expect(tables.some((x) => x.startsWith("_cf_"))).toBe(false);
    } finally {
      c.close();
    }
  });

  it("le compte « sauvegarde » exporte, et ne fait rien d'autre", async () => {
    const created = await call(env, "POST", "/api/admin/users", ADMIN, { username: "sauvegarde" });
    expect(created.status).toBe(200);
    const { password } = (await created.json()) as { password: string };
    const login = await call(env, "POST", "/api/admin/login", null, { user: "sauvegarde", password });
    expect(login.status).toBe(200);
    const { session } = (await login.json()) as { session: string };
    const auth = `session:${session}`;
    expect((await call(env, "GET", "/api/admin/export.sql", auth)).status).toBe(200);
    expect((await call(env, "GET", "/api/admin/overview", auth)).status).toBe(403);
    expect((await call(env, "GET", "/api/admin/users", auth)).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/users", auth, { username: "pirate" })).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/logout", auth)).status).toBe(200);
    expect((await call(env, "GET", "/api/admin/export.sql", auth)).status).toBe(401);
  });

  it("même restriction par le secret ADMIN_TOKEN (paire sauvegarde:…)", async () => {
    const e2 = { ...env, ADMIN_TOKEN: `${ADMIN},sauvegarde:secret-nuit` };
    expect((await call(e2, "GET", "/api/admin/export.sql", "sauvegarde:secret-nuit")).status).toBe(200);
    expect((await call(e2, "GET", "/api/admin/messages", "sauvegarde:secret-nuit")).status).toBe(403);
    // le mot de passe nu de la paire n'ouvre pas davantage (finding Codex du 10/10)
    expect((await call(e2, "GET", "/api/admin/messages", "secret-nuit")).status).toBe(403);
    expect((await call(e2, "GET", "/api/admin/export.sql", "secret-nuit")).status).toBe(200);
    expect((await call(e2, "GET", "/api/admin/messages", "jeton-de-test")).status).toBe(200);
  });
});
