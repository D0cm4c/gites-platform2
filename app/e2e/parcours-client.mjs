// Parcours client COMPLET sur téléphone (390 × 844) : calendrier, hébergement,
// coordonnées (erreurs sous les champs), CGV, paiement simulé, page merci,
// voucher, contact avec accusé de réception. Serveur Node local jetable (port
// 8801, base SQLite temporaire, paiement simulé, e-mails journalisés, rien ne
// sort du Mac).
//
//   npx tsc -p tsconfig.build.json && node node/fix-esm-imports.mjs   (à la racine)
//   node app/e2e/parcours-client.mjs [dossier-de-captures]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(join(ROOT, "app") + "/");
const { chromium } = require("@playwright/test");
const { applyMigrations } = await import(join(ROOT, "node", "migrate.mjs"));
const { openDatabase } = await import(join(ROOT, "node", "sqlite-d1.mjs"));
const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "gites-parcours-"));
const dbPath = join(dir, "p.db");
const d1 = openDatabase(dbPath); applyMigrations(d1, join(ROOT, "migrations")); d1.close();
const BASE = "http://127.0.0.1:8801";
const server = spawn(process.execPath, [join(ROOT, "node", "server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, PORT: "8801", SQLITE_PATH: dbPath, UPLOADS_DIR: join(dir, "up"), PUBLIC_BASE_URL: BASE, ADMIN_TOKEN: "dev:dev", EMAILS_ENABLED: "false", CRON_KEY: "x" },
});
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/public/health`)).ok) break; } catch { /* démarrage */ } await new Promise((r) => setTimeout(r, 250)); }
  const b = await chromium.launch({ channel: "chrome" });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-BE", isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const shot = (n) => out ? p.screenshot({ path: `${out}/${n}.png`, fullPage: true }) : null;
  const noHScroll = async (n) => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `défilement horizontal : ${n}`);

  await p.goto(`${BASE}/book/?property=pre-more`); await p.waitForSelector(".pday[data-date]"); await noHScroll("dates");
  await p.locator("#calNext").click();
  const cells = p.locator(".pday[data-date]:not(.past):not(.full):not(.noarr)");
  await cells.nth(10).click(); await cells.nth(13).click();
  await p.waitForSelector("[data-select]");
  await p.locator("[data-select]").first().click();
  await p.waitForSelector("#gFirst"); await noHScroll("coordonnées");

  // lisibilité : champs ≥ 16 px, boutons ≥ 44 px
  const small = await p.evaluate(() => [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([tabindex='-1']),textarea,select")].filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id));
  assert.deepEqual(small, [], "champs sous 16 px");
  const low = await p.evaluate(() => [...document.querySelectorAll("button.btn,#bPay,#mbPay,.opt-add")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5).map((e) => e.id || e.className));
  assert.deepEqual(low, [], "boutons sous 44 px");

  // erreurs SOUS le champ concerné
  await p.locator("#bPay").click();
  assert.match(await p.locator("#eLast").innerText(), /nom/i);
  assert.match(await p.locator("#eEmail").innerText(), /e-mail/i);
  assert.equal(await p.locator("#gLast").getAttribute("aria-invalid"), "true");
  await shot("erreurs-champs");
  await p.locator("#gLast").fill("Dupont"); await p.locator("#gEmail").fill("camille.test@example.com");
  assert.equal(await p.locator("#eLast").innerText(), "");
  await p.locator("#bPay").click();
  assert.match(await p.locator("#cgvMsg").innerText(), /Cochez/);
  await p.locator("#gCgv").click();
  assert.match(await p.locator("#bPay").innerText(), /Payer .* et réserver/);
  assert.match(await p.locator(".next").first().innerText(), /objet commence par la référence/);
  await p.locator("#bPay").click();
  await p.waitForURL(/dev-pay/); await p.locator("#pay").click();
  await p.waitForURL(/merci/); await p.waitForSelector(".next", { timeout: 15000 });
  const merci = await p.locator("#box").innerText();
  assert.match(merci, /Référence\s+PM-\d{4}-\d+/);
  assert.match(merci, /e-mail de confirmation/);
  assert.match(merci, /solde de .* est à payer avant le \d\d\/\d\d\/\d{4}/);
  assert.match(merci, /Arrivée dès 18 h, départ avant 18 h/);
  assert.match(merci, /Répondez simplement/);
  await noHScroll("merci"); await shot("merci");
  const ref = merci.match(/PM-\d{4}-\d+/)[0];

  // le mail de confirmation est journalisé avec la référence en tête de l'objet
  const db = new DatabaseSync(dbPath);
  const subject = db.prepare("SELECT subject FROM email_log WHERE kind = 'confirmation'").get().subject;
  assert.ok(subject.startsWith(`[${ref}] `), subject);
  db.close();

  // contact : confirmation à l'écran (message repris tel quel, sans HTML) et accusé journalisé
  await p.goto(`${BASE}/book/?property=pre-more`); await p.waitForSelector(".pday[data-date]");
  assert.equal(await p.locator("#holdBanner").isHidden(), true, "décompte de blocage encore affiché après paiement");
  await p.locator("#contactCard summary").click();
  await p.locator("#cName").fill("Léa Martin"); await p.locator("#cEmail").fill("lea@example.com");
  await p.locator("#cMsg").fill("Le sauna est-il chauffé ? <b>test</b>");
  await p.locator("#cSend").click();
  await p.waitForSelector("#cOk:not([hidden])");
  const ok = await p.locator("#cOk").innerText();
  assert.match(ok, /référence QU-\d{4}-\d{4}/);
  assert.match(ok, /lea@example\.com/);
  assert.match(ok, /<b>test<\/b>/);
  await noHScroll("contact"); await shot("contact-envoye");
  const db2 = new DatabaseSync(dbPath);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'contact_ack'").get().n, 1);
  db2.close();
  await b.close();
  console.log("parcours client : OK");
} finally { stop(); }
