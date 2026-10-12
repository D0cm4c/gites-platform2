// Captures téléphone (390×844) de toutes les pages, données inventées de
// npm run pilote:donnees. Usage : node e2e/captures-mobile.mjs avant|apres [route,…]
// Variables : GITES_URL (défaut http://127.0.0.1:5185), FULL=1 pour la page entière.
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dossier = process.argv[2] ?? "avant";
const base = process.env.GITES_URL ?? "http://127.0.0.1:5185";
const pw = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").match(/^PILOTE_PASSWORD=(.*)$/m)?.[1]?.trim() ?? "";
const rep = fileURLToPath(new URL(`../docs/captures/mobile-2026-10-12/${dossier}/`, import.meta.url));
mkdirSync(rep, { recursive: true });
const routes = (process.argv[3] ?? ",calendrier,reservations,messages,menage,avis,reglages,reglages/clients,reglages/paiements,reglages/chiffres,reglages/tarifs,reglages/plateformes/prix,reglages/promotions,reglages/options,reglages/plateformes,reglages/calendriers,reglages/domaine,reglages/comptes,reglages/modeles,reglages/mon-compte,reglages/appareil,reglages/mise-en-route,reglages/journaux,reglages/ameliorations,reglages/aide").split(",");

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "fr-BE", timezoneId: "Europe/Brussels" });
const page = await ctx.newPage();
await page.goto(`${base}/admin/`);
await page.getByLabel("Identifiant").fill("pilote");
await page.getByLabel("Mot de passe").fill(pw);
await page.getByRole("button", { name: "Se connecter" }).click();
await page.waitForTimeout(1500);
for (const r of routes) {
  await page.goto(`${base}/admin/#/${r}`);
  await page.waitForTimeout(1500);
  const nom = (r || "aujourdhui").replace(/\//g, "-");
  await page.screenshot({ path: `${rep}${nom}.png`, fullPage: process.env.FULL !== "0" });
  // débordement horizontal ?
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const small = await page.evaluate(() => {
    let n = 0; const bad = [];
    for (const el of document.querySelectorAll("main *, .page *")) {
      if (!el.childNodes.length) continue;
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!own) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 14) { n++; if (bad.length < 4) bad.push(`${fs}:${el.textContent.trim().slice(0, 20)}`); }
    }
    const tap = [];
    for (const el of document.querySelectorAll("main button, main a, .page button, .page a, .page input, .page select")) {
      const b = el.getBoundingClientRect();
      if (b.width && b.height && (b.height < 40 || b.width < 40) && getComputedStyle(el).visibility !== "hidden") tap.push(`${Math.round(b.width)}x${Math.round(b.height)}:${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 18)}`);
    }
    return { n, bad, tap: tap.slice(0, 6), tapN: tap.length };
  });
  console.log(r || "/", "débord:", over, "petit<14px:", small.n, small.bad.join(" | "), "cibles<40:", small.tapN, small.tap.join(" | "));
}
await browser.close();
