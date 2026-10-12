#!/usr/bin/env node
// Données du pilote du back-office (/admin/) — D1 LOCALE uniquement.
//
// Ce que fait le script, dans l'ordre :
//   1. repart d'une D1 locale vide (.wrangler/state/v3/d1 du dossier courant) ;
//   2. y charge la sauvegarde de prod la plus récente de `sauvegardes/`
//      (export `wrangler d1 export`, déjà sur le Mac — la prod n'est jamais lue
//      ni écrite ici) ;
//   3. applique les migrations plus récentes que la sauvegarde ;
//   4. coupe tout ce qui pourrait sortir du Mac : jeton Beds24 et clé de webhook
//      retirés de la base, transfert des mails vidé (les mails sont de toute
//      façon désactivés en local : EMAILS_ENABLED=false) ;
//   5. sauf `--sans-demo` : lance un `wrangler dev` provisoire et crée par l'API
//      un compte d'essai « pilote » et des réservations de démonstration aux
//      noms inventés (la prod du 30/08 ne contient aucune réservation), puis
//      l'arrête.
//
// Usage : npm run pilote:donnees            (sauvegarde la plus récente + démo)
//         npm run pilote:donnees -- --sans-demo
//         npm run pilote:donnees -- --fichier sauvegardes/2026-08-28-gites-platform.sql
//
// Le mot de passe du compte « pilote » est écrit dans `.dev.vars`
// (PILOTE_PASSWORD), jamais affiché. Julien peut aussi se connecter avec son
// propre compte : les comptes de la sauvegarde sont chargés avec elle.
// Arrêt : le script s'arrête seul ; Ctrl-C coupe aussi le wrangler provisoire.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((a) => /remote|prod/i.test(a))) {
  console.error("Refusé : ce script ne travaille que sur la D1 locale.");
  process.exit(2);
}
const sansDemo = args.includes("--sans-demo");
const fileArg = args.includes("--fichier") ? args[args.indexOf("--fichier") + 1] : null;
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const PORT = 8796;

function backupsDir() {
  const local = join(ROOT, "sauvegardes");
  if (existsSync(local)) return local;
  // Worktree : les sauvegardes vivent dans le clone principal.
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
  return join(dirname(common), "sauvegardes");
}

function latestBackup() {
  if (fileArg) return resolve(ROOT, fileArg);
  const dir = backupsDir();
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-gites-platform\.sql$/.test(f)).sort();
  if (!files.length) throw new Error(`aucune sauvegarde dans ${dir}`);
  return join(dir, files[files.length - 1]);
}

function wrangler(argv, opts = {}) {
  return execFileSync(WRANGLER, argv, { cwd: ROOT, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8" });
}

function sql(command) {
  wrangler(["d1", "execute", "gites-platform", "--local", "--command", command], { quiet: true });
}

function devVars() {
  const p = join(ROOT, ".dev.vars");
  if (!existsSync(p)) throw new Error(".dev.vars absent : copiez-le depuis le clone principal (sans les lignes BEDS24_*)");
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// --- 1 à 4 : base locale ------------------------------------------------------
const backup = latestBackup();
console.log(`Sauvegarde chargée : ${backup.split("/").slice(-1)[0]}`);
rmSync(join(ROOT, ".wrangler", "state", "v3", "d1"), { recursive: true, force: true });
wrangler(["d1", "execute", "gites-platform", "--local", `--file=${backup}`, "--yes"], { quiet: true });
wrangler(["d1", "migrations", "apply", "gites-platform", "--local"], { quiet: true });
sql("DELETE FROM app_settings WHERE key LIKE 'beds24_%'");
sql("UPDATE settings SET value = '' WHERE key = 'email_forward_to'");
sql("UPDATE ical_feeds SET active = 0");
sql("DELETE FROM property_stripe");
console.log("Base locale prête (Beds24, Stripe, transferts et flux iCal coupés).");

if (sansDemo) process.exit(0);

// --- 5 : démonstration par l'API ---------------------------------------------
const vars = devVars();
// Garde-fou : aucun accès aux plateformes depuis le pilote.
const SENSIBLES = ["BEDS24_REFRESH_TOKEN", "BEDS24_WEBHOOK_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"];
if (SENSIBLES.some((k) => vars[k])) {
  throw new Error(".dev.vars contient des clés Beds24, Stripe ou d'envoi de mails : retirez-les pour le pilote (rien ne doit sortir du Mac).");
}
const secours = (vars.ADMIN_TOKEN ?? "").split(",")[0]?.trim();
if (!secours || !secours.includes(":")) throw new Error("ADMIN_TOKEN de .dev.vars attendu sous la forme id:motdepasse");

const server = spawn(WRANGLER, ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--var", "EMAILS_ENABLED:false", "--var", "BEDS24_WRITE_ENABLED:false", "--var", `PUBLIC_BASE_URL:http://127.0.0.1:${PORT}`], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => {
  if (!server.killed) server.kill("SIGINT");
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

const BASE = `http://127.0.0.1:${PORT}`;
async function call(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(`${BASE}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${secours}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/public/health`);
      if (r.status < 500) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wrangler dev ne répond pas :\n${serverLog.slice(-2000)}`);
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
const day = (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

try {
  await waitReady();

  // Compte d'essai.
  const u = await call("/users", { username: "pilote" });
  const dv = join(ROOT, ".dev.vars");
  const txt = readFileSync(dv, "utf8").replace(/\n?# Compte d'essai du pilote[^\n]*\nPILOTE_PASSWORD=.*\n?/g, "\n");
  writeFileSync(dv, txt.replace(/\n*$/, "\n"));
  appendFileSync(dv, `# Compte d'essai du back-office /admin/ (identifiant « pilote »), régénéré par npm run pilote:donnees\nPILOTE_PASSWORD=${u.password}\n`);

  const { units } = await call("/units?property=1");
  const { units: units2 } = await call("/units?property=2");
  const all = [...units, ...units2].filter((x) => x.active);
  const byName = (re) => all.find((x) => re.test(x.name));
  const scieur = byName(/scieur/i);
  const scierie = byName(/^la scierie/i);
  const domaine = all.find((x) => x.isComposite);
  const moulin = byName(/moulin/i);

  // Noms inventés (repris des maquettes du 10/10, contrôlés par noms_fictifs.py).
  const ventes = [
    { unit: scierie, a: -3, d: 0, adults: 6, guest: ["Barnabé", "Pirlouvet", "+32 470 00 01 01"], pay: "full" },
    { unit: scieur, a: -1, d: 2, adults: 10, guest: ["Wolter", "Brugmondt", "+32 470 00 01 02"], pay: "full" },
    { unit: scierie, a: 0, d: 2, adults: 4, guest: ["Ombeline", "Vauchelard", "+32 470 00 01 03"], pay: "deposit" },
    { unit: domaine, a: 6, d: 8, adults: 19, guest: ["Théodric", "Malvoisinne", "+32 470 00 01 04"], pay: "option" },
    { unit: scieur, a: 13, d: 20, adults: 9, guest: ["Gwenola", "Oudewaeter", "+32 470 00 01 05"], pay: "deposit" },
    { unit: scierie, a: 21, d: 24, adults: 7, guest: ["Inès", "Taverdiaux", "+32 470 00 01 06"], pay: "full" },
    { unit: domaine, a: 27, d: 29, adults: 17, guest: ["Paul", "Desquiennes", "+32 470 00 01 07"], pay: "full" },
    { unit: scieur, a: 34, d: 36, adults: 8, guest: ["Ysolde", "Belcourtois", "+32 470 00 01 08"], pay: "deposit" },
  ];
  let n = 0;
  for (const v of ventes) {
    if (!v.unit) continue;
    try {
      const body = {
        unitId: v.unit.id,
        checkin: day(v.a),
        checkout: day(v.d),
        adults: v.adults,
        children: 0,
        guest: { firstName: v.guest[0], lastName: v.guest[1], phone: v.guest[2], email: `${v.guest[1].toLowerCase()}@example.com` },
        confirmNow: v.pay !== "option",
        generatePaymentLink: false,
        internalNotes: "Réservation de démonstration (pilote, noms inventés).",
      };
      // Les séjours déjà commencés passent par la base : l'API refuse une arrivée passée.
      if (v.a < 0) {
        const ctx = await call("/quote", { unitId: v.unit.id, checkin: day(v.a), checkout: day(v.d), adults: v.adults, children: 0 });
        const total = ctx.quote.ok ? ctx.quote.totalCents : 60000;
        const ref = `DEMO-${String(++n).padStart(3, "0")}`;
        sql(
          `INSERT INTO guests (email, first_name, last_name, phone) VALUES ('${v.guest[1].toLowerCase()}@example.com','${v.guest[0]}','${v.guest[1]}','${v.guest[2]}')`,
        );
        sql(
          `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, status, source, total_cents, deposit_cents, paid_cents, internal_notes) VALUES ('${ref}', ${v.unit.id}, (SELECT MAX(id) FROM guests), '${day(v.a)}', '${day(v.d)}', ${v.adults}, 'confirmed', 'manual', ${total}, ${total}, ${total}, 'Réservation de démonstration (pilote, noms inventés).')`,
        );
        sql(
          `INSERT INTO payments (booking_id, kind, method, amount_cents, status, received_at) VALUES ((SELECT id FROM bookings WHERE reference='${ref}'), 'full', 'transfer', ${total}, 'succeeded', datetime('now','-10 days'))`,
        );
        continue;
      }
      const r = await call("/bookings", body);
      const b = r.booking;
      if (v.pay === "full") await call(`/bookings/${b.id}/payments`, { amountCents: b.totalCents, method: "transfer", kind: "full" });
      // Arrhes de moitié : à moins de 30 jours, le devis demande tout, on veut un solde à montrer.
      if (v.pay === "deposit") await call(`/bookings/${b.id}/payments`, { amountCents: Math.round(b.totalCents / 2), method: "transfer", kind: "deposit" });
    } catch (e) {
      console.warn(`Démo : vente ignorée (${v.unit.name}) — ${e.message}`);
    }
  }
  // Solde en retard : on avance l'échéance de la réservation de Gwenola.
  sql("UPDATE bookings SET balance_due_date = date('now','-17 days') WHERE internal_notes LIKE 'Réservation de démonstration%' AND guest_id IN (SELECT id FROM guests WHERE last_name='Oudewaeter')");

  // Réservations venues d'autres sites (comme une liaison iCal/Beds24).
  const plat = [
    { unit: moulin, a: 0, d: 3, label: "Booking", adults: 8, name: "Fiene Elsenhaage" },
    { unit: moulin, a: 13, d: 16, label: "Airbnb", adults: 6, name: "Ottilie Fürstberg" },
    { unit: scierie, a: 14, d: 17, label: "Airbnb", adults: 4, name: null },
  ];
  for (const p of plat) {
    if (!p.unit) continue;
    const ref = `DEMO-${String(++n).padStart(3, "0")}`;
    let guest = "NULL";
    if (p.name) {
      const [fn, ln] = p.name.split(" ");
      sql(`INSERT INTO guests (email, first_name, last_name) VALUES (NULL,'${fn}','${ln}')`);
      guest = "(SELECT MAX(id) FROM guests)";
    }
    sql(
      `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, status, source, channel_label, external_uid, total_cents, internal_notes) VALUES ('${ref}', ${p.unit.id}, ${guest}, '${day(p.a)}', '${day(p.d)}', ${p.adults}, 'confirmed', 'ical', '${p.label}', 'demo-${ref}', 0, 'Réservation de démonstration (pilote).')`,
    );
  }

  // Blocages.
  if (moulin) await call("/blocks", { unitId: moulin.id, checkin: day(22), checkout: day(25), reason: "Travaux de toiture" }).catch((e) => console.warn(e.message));
  if (scierie) await call("/blocks", { unitId: scierie.id, checkin: day(25), checkout: day(27), reason: "Usage familial" }).catch((e) => console.warn(e.message));

  // Messages entrants simulés (aucun envoi : simulation locale).
  const msgs = [
    { from: "elsenhaage@example.com", fromName: "Fiene Elsenhaage", subject: "Arrivée plus tôt ?", text: "Bonjour, nous serons à Braives vers 15 h. Est-ce possible d'entrer plus tôt ? Et où peut-on garer deux voitures ? Merci !" },
    { from: "rambervaux@example.com", fromName: "Sophie Rambervaux", subject: "Domaine pour Noël", text: "Bonjour, le Domaine entier serait-il libre du 26 au 28 décembre pour 20 personnes ?" },
    { from: "vauchelard@example.com", fromName: "Ombeline Vauchelard", subject: "Chaise haute", text: "Y a-t-il une chaise haute et un lit parapluie pour notre fille ?" },
  ];
  for (const m of msgs) await call("/dev-inbound-email", m).catch((e) => console.warn(e.message));

  console.log(`Démonstration prête : ${ventes.length + plat.length} réservations inventées, 2 blocages, 3 messages.`);
  console.log("Compte d'essai : identifiant « pilote », mot de passe dans .dev.vars (PILOTE_PASSWORD).");
} finally {
  stop();
}
