// Point d'entrée Node — équivalent de src/index.ts côté Cloudflare.
//
// Pourquoi ce fichier est en JavaScript et pas en TypeScript : le projet est
// typé contre @cloudflare/workers-types, qui redéfinit fetch/Request/Response.
// Les mélanger avec @types/node provoque des conflits inutiles. Ici on ne fait
// que du câblage, et `src/` reste compilé tel quel — donc le déploiement
// Cloudflare reste possible à tout moment, sans divergence de code métier.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase, snapshotSqlite } from "./sqlite-d1.mjs";
import { applyMigrations } from "./migrate.mjs";
import { imapConfigFromEnv, imapTransport } from "./imap.mjs";
import { smtpConfigFromEnv, smtpTransport } from "./smtp.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const MIGRATIONS_DIR = join(ROOT, "migrations");

// --- configuration ----------------------------------------------------------

/** Charge un .env à la racine si présent (Infomaniak permet aussi de définir
 *  les variables dans le Manager — les deux sources fonctionnent, le Manager
 *  l'emportant puisqu'on n'écrase jamais une variable déjà définie). */
function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const SQLITE_PATH = process.env.SQLITE_PATH || join(ROOT, "data", "gites.db");
const CRON_KEY = (process.env.CRON_KEY || "").trim();
// Photos envoyées depuis le back-office : HORS du dossier déployé (un
// redéploiement ne doit pas les effacer), servies sous /uploads/.
const UPLOADS_DIR = resolve(ROOT, process.env.UPLOADS_DIR || "../gites-data/uploads");
// Derrière le proxy d'Infomaniak, l'adresse du client est la dernière entrée
// de X-Forwarded-For (celle qu'a vue le proxy). Sans TRUST_PROXY=true, on
// garde l'adresse de la socket : un X-Forwarded-For envoyé par le client ne
// trompe alors pas la garde ADMIN_ALLOWED_IPS.
const TRUST_PROXY = (process.env.TRUST_PROXY || "").trim() === "true";
/** Corps de requête accepté au plus : une photo de 8 Mo et son enveloppe. */
const MAX_BODY_BYTES = 9 * 1024 * 1024;

// --- base de données --------------------------------------------------------

// Le dossier de la base peut ne pas exister au premier démarrage (il n'est pas
// déployé : il contient les données, pas le code).
mkdirSync(dirname(resolve(SQLITE_PATH)), { recursive: true });

const db = openDatabase(SQLITE_PATH);
const applied = applyMigrations(db, MIGRATIONS_DIR);
if (applied.length > 0) console.log(`[db] migrations appliquées : ${applied.join(", ")}`);

/** L'objet `env` que tout le code métier attend (mêmes clés que sur Workers,
 *  ASSETS en moins — les fichiers statiques sont servis plus bas). */
const env = {
  DB: db,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  EMAILS_ENABLED: process.env.EMAILS_ENABLED || "false",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM: process.env.RESEND_FROM,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  BEDS24_REFRESH_TOKEN: process.env.BEDS24_REFRESH_TOKEN,
  BEDS24_WEBHOOK_KEY: process.env.BEDS24_WEBHOOK_KEY,
  BEDS24_WRITE_ENABLED: process.env.BEDS24_WRITE_ENABLED,
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_UI: process.env.STRIPE_UI,
  // Mails par SMTP (Infomaniak) : actif quand les quatre sont posés et
  // EMAILS_ENABLED=true — cf. node/smtp.mjs. Prime sur Resend.
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  MAIL_FROM: process.env.MAIL_FROM,
  SMTP_SEND: smtpConfigFromEnv() ? smtpTransport(smtpConfigFromEnv()) : undefined,
  // Relève de la boîte de contact (Gmail, IMAP) : actif quand IMAP_USER et un mot de
  // passe (IMAP_PASSWORD, sinon SMTP_PASSWORD) sont posés — cf. node/imap.mjs et
  // src/services/mailbox.ts. Lecture seule : la boîte n'est jamais modifiée.
  IMAP_HOST: process.env.IMAP_HOST,
  IMAP_PORT: process.env.IMAP_PORT,
  IMAP_USER: process.env.IMAP_USER,
  IMAP_PASSWORD: process.env.IMAP_PASSWORD,
  IMAP_FETCH: imapConfigFromEnv() ? imapTransport(imapConfigFromEnv()) : undefined,
  // Instantané de la base pour GET /api/admin/export.sqlite (Node seulement).
  SQLITE_SNAPSHOT: async () => snapshotSqlite(db, dirname(resolve(SQLITE_PATH))),
  ADMIN_ALLOWED_IPS: process.env.ADMIN_ALLOWED_IPS,
  // Dépôt des photos (src/api/admin-lot2.ts). Le nom arrive déjà validé ;
  // on le revérifie ici, et « wx » refuse d'écraser un fichier existant.
  UPLOADS: {
    async put(name, bytes) {
      if (!/^[0-9a-f]{32}\.(jpg|png|webp)$/.test(name)) throw new Error("nom de fichier refusé");
      mkdirSync(UPLOADS_DIR, { recursive: true });
      await writeFile(join(UPLOADS_DIR, name), bytes, { flag: "wx" });
    },
    async remove(name) {
      if (!/^[0-9a-f]{32}\.(jpg|png|webp)$/.test(name)) return;
      await unlink(join(UPLOADS_DIR, name));
    },
    // Sauvegarde des photos (GET /api/admin/export-uploads.tar).
    async list() {
      if (!existsSync(UPLOADS_DIR)) return [];
      return readdirSync(UPLOADS_DIR).filter((n) => /^[0-9a-f]{32}\.(jpg|png|webp)$/.test(n));
    },
    async read(name) {
      if (!/^[0-9a-f]{32}\.(jpg|png|webp)$/.test(name)) throw new Error("nom de fichier refusé");
      const full = join(UPLOADS_DIR, name);
      return { bytes: new Uint8Array(await readFile(full)), mtime: Math.floor((await stat(full)).mtimeMs / 1000) };
    },
  },
};

// --- routeur métier (code compilé depuis src/) ------------------------------

const { Router, apiError } = await import("../dist/api/router.js");
const { registerPublicRoutes } = await import("../dist/api/public.js");
const { registerAdminRoutes } = await import("../dist/api/admin.js");
const { runAllScheduled } = await import("../dist/jobs/scheduled.js");
const { pullMailbox } = await import("../dist/services/mailbox.js");
const { adminIpCheck, adminIpGate, ipDeniedResponse, markIpDenied } = await import("../dist/core/ip-allow.js");
const { adminAddressRedirect } = await import("../dist/core/admin-redirect.js");
const { localizePublicResponse } = await import("../dist/core/public-i18n.js");

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

/** Équivalent de ctx.waitUntil : sur Cloudflare, le travail de fond survit à la
 *  réponse. Ici le processus reste vivant — on lance et on capture l'échec pour
 *  qu'une promesse rejetée ne fasse jamais tomber le serveur. */
const execCtx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((e) => console.error("[waitUntil]", e));
  },
  passThroughOnException() {},
};

// --- fichiers statiques -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".ics": "text/calendar; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** Résout un chemin d'URL vers un fichier de public/, en refusant toute
 *  sortie du dossier (traversée de répertoire). */
function resolveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  // /book → /book/index.html
  const asDir = join(full, "index.html");
  if (existsSync(asDir) && statSync(asDir).isFile()) return asDir;
  // /page → /page.html
  const asHtml = `${full}.html`;
  if (existsSync(asHtml) && statSync(asHtml).isFile()) return asHtml;
  return null;
}

/** En-têtes de sécurité + cache. Répond au finding « aucun en-tête de
 *  sécurité » de l'audit ECC, que le binding ASSETS de Cloudflare ne posait
 *  pas non plus. */
function staticHeaders(file) {
  const ext = extname(file);
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (file.startsWith(join(PUBLIC_DIR, "img"))) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (ext === ".html" || file.endsWith("/sw.js")) {
    // Le service worker de /admin/ doit être relu à chaque visite, sinon une
    // nouvelle version de l'écran ne s'installe pas.
    headers["cache-control"] = "no-cache";
  } else {
    headers["cache-control"] = "public, max-age=86400";
  }
  return headers;
}

// --- pont node:http ↔ Request/Response --------------------------------------

class BodyTooLarge extends Error {}

/** Adresse du client, pour la garde ADMIN_ALLOWED_IPS. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || "";
}

/** Fichier de UPLOADS_DIR pour /uploads/<nom>, ou null (nom strict : pas de
 *  sous-dossier, pas de traversée possible). */
function resolveUpload(pathname) {
  const m = /^\/uploads\/([0-9a-f]{32}\.(?:jpg|png|webp))$/.exec(pathname);
  if (!m) return null;
  const full = join(UPLOADS_DIR, m[1]);
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

async function toRequest(req, origin) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body;
  if (hasBody) {
    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw new BodyTooLarge();
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(res, response) {
  const headers = {};
  for (const [k, v] of response.headers) headers[k] = v;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // En flux, avec contre-pression : une grosse réponse (archive des photos)
  // ne passe jamais tout entière en mémoire. pipeline() annule la source si
  // le client ferme la connexion en cours de route.
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (e) {
    console.error("[gites] réponse interrompue :", e instanceof Error ? e.message : e);
  }
}

// --- serveur ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const origin = env.PUBLIC_BASE_URL.startsWith("http") ? env.PUBLIC_BASE_URL : `http://localhost:${PORT}`;
  let url;
  try {
    url = new URL(req.url, origin);
  } catch {
    res.writeHead(400).end("requête invalide");
    return;
  }

  try {
    // 1. Tâche planifiée déclenchée par le Planificateur Infomaniak (une URL
    //    appelée toutes les 15 min — il n'y a pas de crontab en mutualisé).
    if (url.pathname === "/internal/cron") {
      const given = url.searchParams.get("key") ?? "";
      if (!CRON_KEY || given.length !== CRON_KEY.length || given !== CRON_KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "clé invalide" }));
        return;
      }
      await runAllScheduled(env);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
      return;
    }

    // 2. Sonde de disponibilité (monitoring externe, sans secret ni donnée).
    if (url.pathname === "/internal/health") {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM units").first("n");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, units: n }));
      return;
    }

    // 3. Accès administrateur fermé au public (ADMIN_ALLOWED_IPS, vide = ouvert).
    //    Écrans : refus immédiat. API : refus après authentification, aux
    //    humains seulement (clés svc: et compte « sauvegarde » exemptés).
    const ip = clientIp(req);
    const ipCheck = adminIpCheck(url.pathname, env.ADMIN_ALLOWED_IPS, ip);
    if (ipCheck === "deny") {
      await sendResponse(res, adminIpGate(url.pathname, env.ADMIN_ALLOWED_IPS, ip) ?? ipDeniedResponse());
      return;
    }

    // 3 bis. Une seule adresse pour l'écran d'administration : l'ancienne
    //    adresse du pilote et la connexion de l'ancien écran renvoient vers /admin/.
    const moved = adminAddressRedirect(url.pathname);
    if (moved) {
      res.writeHead(301, { location: moved, "cache-control": "public, max-age=3600" }).end();
      return;
    }

    // 3 ter. Photos envoyées depuis le back-office.
    if (url.pathname.startsWith("/uploads/")) {
      const file = resolveUpload(url.pathname);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("introuvable");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
      return;
    }

    // 4. Routes dynamiques (API, iCal) — même routeur que sur Cloudflare.
    let request;
    try {
      request = await toRequest(req, origin);
    } catch (e) {
      if (!(e instanceof BodyTooLarge)) throw e;
      res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "requête trop lourde (9 Mo au plus)" }));
      req.destroy();
      return;
    }
    if (ipCheck === "defer") markIpDenied(request);
    const response = await router.handle(request, env, execCtx);
    if (response) {
      // Tunnel public en néerlandais : textes du serveur traduits à la sortie.
      await sendResponse(res, await localizePublicResponse(request, response));
      return;
    }
    if (ipCheck === "defer") {
      await sendResponse(res, ipDeniedResponse());
      return;
    }

    // 5. Fichiers statiques.
    const file = resolveStatic(url.pathname);
    if (file) {
      const headers = staticHeaders(file);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
      return;
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ical/")) {
      await sendResponse(res, apiError(404, "route inconnue"));
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end("<h1>Page introuvable</h1>");
  } catch (e) {
    console.error("[erreur]", req.method, url?.pathname, e instanceof Error ? e.stack : e);
    // Même filet qu'en Worker : la trace persiste en base, les logs d'un
    // hébergement mutualisé n'étant pas toujours consultables après coup.
    try {
      await db
        .prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES ('cron', 'unhandled.error', ?1, ?2)")
        .bind(url?.pathname ?? "?", String(e instanceof Error ? e.stack : e).slice(0, 2000))
        .run();
    } catch (logErr) {
      console.error("[audit_log indisponible]", logErr);
    }
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "erreur interne" }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[gites] écoute sur le port ${PORT}`);
  console.log(`[gites] base   : ${SQLITE_PATH}`);
  console.log(`[gites] URL    : ${env.PUBLIC_BASE_URL}`);
  const transport = env.EMAILS_ENABLED !== "true" ? null : env.SMTP_SEND ? `SMTP ${env.SMTP_HOST}` : env.RESEND_API_KEY ? "Resend" : null;
  console.log(`[gites] emails : ${transport ? `ACTIFS (${transport})` : "stub (journalisés)"}`);
  console.log(`[gites] photos : ${UPLOADS_DIR}`);
  console.log(`[gites] beds24 : écritures ${env.BEDS24_WRITE_ENABLED === "true" ? "ACTIVES" : "FERMÉES (BEDS24_WRITE_ENABLED ≠ true)"}`);
  console.log(`[gites] admin  : ${(env.ADMIN_ALLOWED_IPS || "").trim() ? `réservé à ${env.ADMIN_ALLOWED_IPS}${TRUST_PROXY ? " (via X-Forwarded-For)" : ""}` : "ouvert à toute adresse"}`);
  console.log(`[gites] boîte  : ${env.IMAP_FETCH ? `relève IMAP ${env.IMAP_USER} @ ${env.IMAP_HOST || "imap.gmail.com"} (lecture seule)` : "relève IMAP inactive (IMAP_USER / mot de passe absents)"}`);
  if (!env.ADMIN_TOKEN) console.warn("[gites] ⚠️ ADMIN_TOKEN absent — le back-office refusera tout (garde fail-closed)");
  if (!CRON_KEY) console.warn("[gites] ⚠️ CRON_KEY absente — /internal/cron est désactivé");
});

// Filet entre deux passages du cron (15 min) : la boîte de contact est relevée toutes les
// MAILBOX_POLL_MINUTES (10 par défaut, 0 = seulement au cron). Sans danger de doublon : le
// curseur UID et le Message-ID rendent la relève idempotente, et un verrou évite deux
// relèves à la fois. Le minuteur n'empêche pas le processus de s'arrêter.
const mailboxEvery = Number(process.env.MAILBOX_POLL_MINUTES ?? 10);
if (env.IMAP_FETCH && Number.isFinite(mailboxEvery) && mailboxEvery >= 1) {
  setInterval(() => {
    pullMailbox(env).catch((e) => console.error("[boîte]", e instanceof Error ? e.message : e));
  }, Math.round(mailboxEvery * 60_000)).unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[gites] arrêt (${signal})`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
