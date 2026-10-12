// Client IMAP minimal, sans dépendance (node:tls) — relève de la boîte de contact
// des gîtes (Gmail, mot de passe d'application) quand le site tourne sur Node.
// Sur Cloudflare Workers (pas de socket sortante), la relève est désactivée :
// cf. src/services/mailbox.ts.
//
// Ce que le client fait, et rien de plus :
//   - TLS dès la connexion (993) ; jamais de connexion en clair ;
//   - LOGIN (mot de passe d'application), refusé si le serveur annonce LOGINDISABLED ;
//   - EXAMINE INBOX : boîte ouverte en LECTURE SEULE, rien n'y est jamais modifié
//     (ni \Seen, ni suppression) ; le curseur est un UID gardé en base, côté plateforme ;
//   - UID SEARCH puis UID FETCH ... BODY.PEEK[]<0.N> : au plus N octets par mail
//     (512 Ko par défaut) — un mail de 20 Mo de photos ne descend pas en entier ;
//   - lecteur de réponses fidèle au protocole : littéraux {n} lus à l'octet près,
//     lignes de réponse jamais confondues avec le contenu d'un mail ;
//   - délai global (60 s) et plafonds de taille : un serveur muet ou bavard ne
//     bloque ni ne remplit la mémoire.
// Le mot de passe n'apparaît dans aucun message d'erreur.

import { connect as tlsConnect } from "node:tls";
import { isIP } from "node:net";

/** Configuration lue dans l'environnement ; null si IMAP_USER ou le mot de passe manque.
 *  IMAP_PASSWORD retombe sur SMTP_PASSWORD (même mot de passe d'application). */
export function imapConfigFromEnv(e = process.env) {
  const user = (e.IMAP_USER || "").trim();
  const password = e.IMAP_PASSWORD || e.SMTP_PASSWORD || "";
  if (!user || !password) return null;
  const host = (e.IMAP_HOST || "imap.gmail.com").trim();
  const raw = Number(e.IMAP_PORT || 993);
  const port = Number.isInteger(raw) && raw > 0 ? raw : 993;
  return { host, port, user, password };
}

// une ligne peut porter une longue liste d'UID (SEARCH) : 1 Mo en tient plus de 100 000
const MAX_LINE = 1024 * 1024;
/** Réponses non étiquetées d'une commande : nombre au plus (EXISTS, FETCH, SEARCH… en prennent quelques dizaines). */
const MAX_UNTAGGED = 2000;
const MAX_OTHER_LITERAL = 1024 * 1024;

/** Chaîne IMAP entre guillemets ; refuse ce qui ne peut pas s'y mettre. */
export function imapQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("IMAP : valeur invalide (caractère de contrôle)");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Lecteur de réponses. Chaque réponse = { text, literals } : `text` est la ligne
 * (ou les lignes jointes par les littéraux) avec chaque littéral remplacé par
 * le marqueur « \0<i>\0 », `literals[i]` le contenu exact en Buffer.
 * Les NUL du serveur sont retirés du texte : un marqueur ne vient que de nous.
 */
export class ResponseReader {
  #buf = Buffer.alloc(0);
  #cur = { text: "", literals: [] };
  #need = null; // octets de littéral encore attendus
  #queue = [];
  #waiters = [];
  #error = null;
  #maxLiteral;

  constructor(maxLiteral) {
    this.#maxLiteral = maxLiteral;
  }

  feed(chunk) {
    if (this.#error) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    try {
      this.#drain();
    } catch (e) {
      this.fail(e);
    }
  }

  #drain() {
    for (;;) {
      if (this.#need !== null) {
        if (this.#buf.length < this.#need) return;
        const lit = Buffer.from(this.#buf.subarray(0, this.#need));
        this.#buf = this.#buf.subarray(this.#need);
        this.#cur.text += `\0${this.#cur.literals.length}\0`;
        this.#cur.literals.push(lit);
        this.#need = null;
        continue;
      }
      const idx = this.#buf.indexOf("\r\n");
      if (idx < 0) {
        if (this.#buf.length > MAX_LINE) throw new Error("IMAP : ligne de réponse trop longue");
        return;
      }
      if (idx > MAX_LINE) throw new Error("IMAP : ligne de réponse trop longue");
      const line = this.#buf.subarray(0, idx).toString("utf8").replace(/\0/g, "");
      this.#buf = this.#buf.subarray(idx + 2);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (lit) {
        const n = Number(lit[1]);
        if (!Number.isSafeInteger(n) || n > this.#maxLiteral) throw new Error(`IMAP : littéral de ${lit[1]} octets refusé`);
        this.#cur.text += line.slice(0, lit.index);
        this.#need = n;
        continue;
      }
      this.#cur.text += line;
      const done = this.#cur;
      this.#cur = { text: "", literals: [] };
      const w = this.#waiters.shift();
      if (w) w.resolve(done);
      else this.#queue.push(done);
    }
  }

  fail(error) {
    if (!this.#error) this.#error = error;
    for (const w of this.#waiters.splice(0)) w.reject(this.#error);
  }

  next() {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

/** « 12:40 » → plage de parts de l'ensemble ; utilitaire de lot UID. */
function uidSet(uids) {
  return uids.join(",");
}

/** Date IMAP « 5-Oct-2026 » (UTC), pour SEARCH SINCE. */
export function imapDate(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/**
 * Relève les nouveaux mails de INBOX.
 *
 * query : { uidValidity: number|null, lastUid: number|null, sinceDays: number, max: number, maxBytes?: number }
 *   - lastUid connu et uidValidity inchangée : seuls les UID > lastUid ;
 *   - sinon (premier passage, ou boîte reconstruite) : les mails des `sinceDays` derniers jours.
 *   - `max` mails au plus par appel, du plus ancien au plus récent ; `more` dit s'il en reste.
 *
 * Rend { uidValidity, mails: [{ uid, raw, size, truncated }], more, highestUid }.
 *   raw = le message en chaîne « binaire » (un caractère par octet, latin1) ;
 *   size = taille réelle du message chez le serveur ; truncated = raw est coupé à maxBytes.
 * Lève une Error lisible sinon. `options.tls` sert aux tests (certificat local).
 */
export async function fetchNewMail(config, query, options = {}) {
  const { host, port, user, password } = config;
  const maxBytes = query.maxBytes ?? 512 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const tlsOptions = { ...(isIP(host) ? {} : { servername: host }), ...(options.tls || {}) };

  let socket;
  let timer;
  const reader = new ResponseReader(Math.max(maxBytes + 4096, MAX_OTHER_LITERAL));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IMAP : pas de réponse de ${host}:${port} après ${timeoutMs / 1000} s`)), timeoutMs);
  });
  deadline.catch(() => {});

  let seq = 0;
  /** Envoie une commande, rend les réponses non étiquetées puis la réponse étiquetée. */
  const run = async (command, step, { secret = false, maxTotal = 2 * MAX_LINE } = {}) => {
    const tag = `A${String(++seq).padStart(3, "0")}`;
    socket.write(`${tag} ${command}\r\n`);
    const untagged = [];
    let total = 0;
    for (;;) {
      const r = await Promise.race([reader.next(), deadline]);
      if (r.text.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\b\s*(.*)$/i.exec(r.text);
        if (!m || m[1].toUpperCase() !== "OK") {
          // jamais la commande elle-même (elle porte le mot de passe) ; le détail serveur seulement
          const detail = secret ? (m ? m[1].toUpperCase() : "réponse illisible") : (m ? `${m[1].toUpperCase()} ${m[2]}` : r.text).slice(0, 300);
          throw new Error(`IMAP à l'étape ${step} : ${detail}`);
        }
        return { untagged, status: m[2] };
      }
      if (/^\* BYE\b/i.test(r.text)) throw new Error(`IMAP : le serveur ferme la connexion (${r.text.slice(0, 200)})`);
      // un serveur bavard ne remplit pas la mémoire : nombre et volume cumulés bornés par commande
      total += r.text.length + r.literals.reduce((n, l) => n + l.length, 0);
      if (untagged.length >= MAX_UNTAGGED || total > maxTotal) throw new Error(`IMAP à l'étape ${step} : trop de données reçues, connexion abandonnée`);
      untagged.push(r);
    }
  };

  try {
    socket = await Promise.race([
      new Promise((resolve, reject) => {
        const s = tlsConnect({ host, port, ...tlsOptions }, () => resolve(s));
        s.once("error", (e) => reject(new Error(`IMAP : connexion à ${host}:${port} impossible (${e.code || e.message})`)));
      }),
      deadline,
    ]);
    socket.on("data", (c) => reader.feed(c));
    socket.on("error", (e) => reader.fail(new Error(`IMAP : connexion en erreur (${e.code || e.message})`)));
    socket.on("close", () => reader.fail(new Error("IMAP : connexion fermée par le serveur")));

    const greeting = await Promise.race([reader.next(), deadline]);
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) throw new Error(`IMAP : accueil inattendu (${greeting.text.slice(0, 120)})`);

    const caps = await run("CAPABILITY", "CAPABILITY");
    if (caps.untagged.some((r) => /\bLOGINDISABLED\b/i.test(r.text))) {
      throw new Error("IMAP : le serveur refuse LOGIN (LOGINDISABLED)");
    }
    await run(`LOGIN ${imapQuote(user)} ${imapQuote(password)}`, "LOGIN", { secret: true });

    const sel = await run("EXAMINE INBOX", "EXAMINE INBOX");
    let uidValidity = null;
    for (const r of sel.untagged) {
      const m = /\[UIDVALIDITY (\d+)\]/i.exec(r.text);
      if (m) uidValidity = Number(m[1]);
    }
    if (uidValidity == null) throw new Error("IMAP : le serveur ne donne pas UIDVALIDITY");

    const resume = query.lastUid != null && query.uidValidity === uidValidity;
    let found = [];
    if (resume) {
      const s = await run(`UID SEARCH UID ${query.lastUid + 1}:*`, "UID SEARCH");
      found = parseSearch(s.untagged);
      // « n:* » rend toujours au moins le dernier message, même plus ancien que n
      found = found.filter((u) => u > query.lastUid);
    } else {
      const since = new Date(Date.now() - Math.max(1, query.sinceDays) * 86_400_000);
      const s = await run(`UID SEARCH SINCE ${imapDate(since)}`, "UID SEARCH");
      found = parseSearch(s.untagged);
    }
    found.sort((a, b) => a - b);
    const batch = found.slice(0, Math.max(1, query.max));
    const more = found.length > batch.length;

    const mails = [];
    if (batch.length > 0) {
      const maxTotal = batch.length * (maxBytes + 8192) + MAX_OTHER_LITERAL;
      /** Un FETCH pour ces UID ; rend ceux dont le serveur a donné le message. */
      const fetchSome = async (uids) => {
        const f = await run(`UID FETCH ${uidSet(uids)} (UID RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`, "UID FETCH", { maxTotal });
        const got = new Map();
        for (const r of f.untagged) {
          if (!/^\* \d+ FETCH\b/i.test(r.text)) continue;
          const uid = /\bUID (\d+)/i.exec(r.text)?.[1];
          if (!uid) continue;
          const size = Number(/\bRFC822\.SIZE (\d+)/i.exec(r.text)?.[1] ?? 0);
          const lit = /\0(\d+)\0/.exec(r.text);
          // BODY[] NIL ou "" : un message vide, pas un message manquant
          const bytes = lit ? r.literals[Number(lit[1])] : /BODY\[\](<\d+>)? (NIL|"")/i.test(r.text) ? Buffer.alloc(0) : null;
          if (bytes) got.set(Number(uid), { size, bytes });
        }
        return got;
      };
      const byUid = await fetchSome(batch);
      let missing = batch.filter((u) => !byUid.has(u));
      if (missing.length) {
        // réponse partielle ? on redemande ceux qui manquent, une fois
        for (const [uid, v] of await fetchSome(missing)) byUid.set(uid, v);
        missing = batch.filter((u) => !byUid.has(u));
      }
      if (missing.length) {
        // un message expulsé entre le SEARCH et le FETCH a vraiment disparu ; un message qui existe
        // encore sans être rendu est une panne : on s'arrête SANS avancer le curseur
        const still = parseSearch((await run(`UID SEARCH UID ${uidSet(missing)}`, "UID SEARCH (contrôle)")).untagged);
        if (still.length) throw new Error(`IMAP : le serveur n'a pas rendu les messages UID ${still.slice(0, 5).join(", ")} : relève reprise au prochain passage`);
      }
      for (const uid of batch) {
        const got = byUid.get(uid);
        if (!got) continue; // disparu (confirmé ci-dessus)
        mails.push({ uid, raw: got.bytes.toString("latin1"), size: got.size || got.bytes.length, truncated: got.size > got.bytes.length });
      }
    }
    try {
      socket.write(`A${String(++seq).padStart(3, "0")} LOGOUT\r\n`);
    } catch {
      /* peu importe */
    }
    return { uidValidity, mails, more, highestUid: batch.length ? batch[batch.length - 1] : null, batchUids: batch };
  } finally {
    clearTimeout(timer);
    if (socket) socket.destroy();
  }
}

function parseSearch(untagged) {
  const out = [];
  for (const r of untagged) {
    const m = /^\* SEARCH\b(.*)$/i.exec(r.text);
    if (!m) continue;
    for (const n of m[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(n)) out.push(Number(n));
    }
  }
  return out;
}

/** Transport injecté dans `env.IMAP_FETCH` par node/server.mjs. */
export function imapTransport(config, options) {
  return (query) => fetchNewMail(config, query, options);
}
