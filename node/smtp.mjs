// Client SMTP minimal, sans dépendance (node:net, node:tls) — envoi des mails
// de la plateforme par la boîte Infomaniak (reservations@…) quand le site tourne
// sur Node. Sur Cloudflare Workers, Resend reste le transport (src/services/email.ts).
//
// Couvre exactement ce dont un mail transactionnel a besoin, rien de plus :
//   - port 465 : TLS dès la connexion (« SMTPS », forçable par SMTP_SECURE) ;
//   - autre port (587, 25) : STARTTLS obligatoire — un serveur qui ne le
//     propose pas est refusé, jamais de mot de passe en clair sur le réseau ;
//   - AUTH PLAIN, sinon AUTH LOGIN (selon ce qu'annonce EHLO) ;
//   - un destinataire, texte brut UTF-8 en quoted-printable, objet en
//     encoded-word RFC 2047, Message-ID et Date posés ici ;
//   - en option une version HTML (multipart/alternative) et des pièces
//     jointes en base64 (multipart/mixed) : le PDF de la confirmation ;
//   - délai global (30 s par défaut) : un serveur muet ne bloque jamais la
//     requête qui envoie.
// Le mot de passe n'apparaît dans aucun message d'erreur ni journal.

import { randomBytes } from "node:crypto";
import { isIP, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Configuration lue dans l'environnement ; null si l'une des quatre variables manque. */
export function smtpConfigFromEnv(e = process.env) {
  const host = (e.SMTP_HOST || "").trim();
  const user = (e.SMTP_USER || "").trim();
  const password = e.SMTP_PASSWORD || "";
  const from = (e.MAIL_FROM || "").trim();
  if (!host || !user || !password || !from) return null;
  const raw = Number(e.SMTP_PORT || 465);
  const port = Number.isInteger(raw) && raw > 0 ? raw : 465;
  // TLS dès la connexion sur 465 ; STARTTLS ailleurs. SMTP_SECURE=true|false force le choix.
  const forced = (e.SMTP_SECURE || "").trim().toLowerCase();
  const secure = forced === "true" ? true : forced === "false" ? false : port === 465;
  return { host, port, secure, user, password, from };
}

/** Adresse nue d'un « Nom <adresse> » (ou l'adresse telle quelle). */
export function bareAddress(value) {
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim();
}

/** Refuse ce qui casserait la commande SMTP ou injecterait un en-tête. */
function checkHeaderValue(label, value) {
  if (/[\r\n]/.test(value)) throw new Error(`SMTP : ${label} contient un saut de ligne`);
}

function encodeHeaderWord(text) {
  // ASCII imprimable : tel quel ; sinon encoded-word base64 (UTF-8), découpé
  // pour que chaque mot reste sous 75 caractères (RFC 2047).
  // (un objet ASCII trop long est encodé aussi : les mots encodés se replient
  // proprement, la ligne d'en-tête reste sous la limite de 78 caractères)
  if (/^[\x20-\x7e]*$/.test(text) && text.length <= 66) return text;
  const words = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

function encodeFromHeader(value) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (!m || !m[1]) return bareAddress(value);
  const name = m[1].replace(/^"|"$/g, "");
  return `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, "")}"` : encodeHeaderWord(name)} <${m[2]}>`;
}

/** Quoted-printable (RFC 2045), lignes en CRLF, 76 caractères au plus. */
export function quotedPrintable(text) {
  const bytes = Buffer.from(text.replace(/\r?\n/g, "\n"), "utf8");
  const lines = [];
  let line = "";
  const push = (token) => {
    if (line.length + token.length > 75) {
      lines.push(line + "=");
      line = "";
    }
    line += token;
  };
  // une espace en fin de ligne serait mangée en route : on l'encode, en
  // repliant si l'encodage ferait dépasser 76 caractères
  const encodeTrailingSpace = () => {
    if (!(line.endsWith(" ") || line.endsWith("\t"))) return;
    const code = line.endsWith(" ") ? "=20" : "=09";
    line = line.slice(0, -1);
    if (line.length + code.length > 76) {
      lines.push(line + "=");
      line = "";
    }
    line += code;
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0x0a) {
      encodeTrailingSpace();
      lines.push(line);
      line = "";
      continue;
    }
    const printable = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9;
    push(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  encodeTrailingSpace();
  lines.push(line);
  return lines.join("\r\n");
}

/** Identifiants de fil (In-Reply-To, References) : des <identifiants> et rien d'autre,
 *  repliés à la ligne tous les trois identifiants. null si la valeur est vide. */
function threadHeader(label, value) {
  if (value == null || String(value).trim() === "") return null;
  const ids = String(value).trim().split(/\s+/);
  if (!ids.every((id) => /^<[^<>\s]{1,300}>$/.test(id))) throw new Error(`SMTP : ${label} invalide`);
  const lines = [];
  for (let i = 0; i < ids.length; i += 3) lines.push(ids.slice(i, i + 3).join(" "));
  return lines.join("\r\n ");
}

/** Message RFC 5322 complet, prêt pour DATA (sans le point final). */

/** Nom de fichier sûr pour un en-tête MIME : ASCII, sans guillemet, saut de ligne ni séparateur de chemin. */
export function safeFilename(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "piece-jointe";
}

/** Base64 en lignes de 76 caractères (RFC 2045). */
function base64Lines(content) {
  const b64 = Buffer.from(content).toString("base64");
  return (b64.match(/.{1,76}/g) || []).join("\r\n");
}

function textPart(contentType, text) {
  return [`Content-Type: ${contentType}; charset=UTF-8`, "Content-Transfer-Encoding: quoted-printable", "", quotedPrintable(text)].join("\r\n");
}

/** Message RFC 5322 complet, prêt pour DATA (sans le point final). */
export function buildMessage({ from, to, subject, text, html, attachments = [], messageId, inReplyTo, references, date = new Date() }) {
  const inReplyToValue = threadHeader("In-Reply-To", inReplyTo);
  const referencesValue = threadHeader("References", references || inReplyTo);
  const headers = [
    `From: ${encodeFromHeader(from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    ...(inReplyToValue ? [`In-Reply-To: ${inReplyToValue}`] : []),
    ...(referencesValue ? [`References: ${referencesValue}`] : []),
    "MIME-Version: 1.0",
  ];
  let body;
  if (!html && attachments.length === 0) {
    // cas historique : un seul morceau de texte
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: quoted-printable");
    body = quotedPrintable(text);
  } else {
    const tag = randomBytes(12).toString("hex");
    const body1 = html
      ? (() => {
          const alt = `=_alt_${tag}`;
          return {
            type: `multipart/alternative; boundary="${alt}"`,
            text: [`--${alt}`, textPart("text/plain", text), `--${alt}`, textPart("text/html", html), `--${alt}--`].join("\r\n"),
          };
        })()
      : { type: "text/plain; charset=UTF-8", text: null };
    if (attachments.length === 0) {
      headers.push(`Content-Type: ${body1.type}`);
      body = body1.text;
    } else {
      const mixed = `=_mix_${tag}`;
      headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
      const parts = [];
      if (body1.text !== null) parts.push(`--${mixed}`, `Content-Type: ${body1.type}`, "", body1.text);
      else parts.push(`--${mixed}`, textPart("text/plain", text));
      for (const a of attachments) {
        const type = /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : "application/octet-stream";
        const name = safeFilename(a.filename);
        parts.push(
          `--${mixed}`,
          `Content-Type: ${type}; name="${name}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${name}"`,
          "",
          base64Lines(a.content),
        );
      }
      parts.push(`--${mixed}--`);
      body = parts.join("\r\n");
    }
  }
  // dot-stuffing (RFC 5321 § 4.5.2) : une ligne qui commence par un point
  const stuffed = body
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${stuffed}`;
}

/** Lecteur de réponses SMTP (multi-lignes « 250-… » jusqu'à « 250 … »). */
class Replies {
  #buffer = "";
  #waiters = [];
  #queue = [];
  #error = null;

  feed(chunk) {
    this.#buffer += chunk.toString("utf8");
    let idx;
    let lines = [];
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(idx + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        this.#deliver({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    if (lines.length) this.#buffer = lines.join("\n") + "\n" + this.#buffer;
  }

  fail(error) {
    this.#error = error;
    for (const w of this.#waiters.splice(0)) w.reject(error);
  }

  #deliver(reply) {
    const w = this.#waiters.shift();
    if (w) w.resolve(reply);
    else this.#queue.push(reply);
  }

  next() {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

function attach(socket, replies) {
  socket.on("data", (c) => replies.feed(c));
  socket.on("error", (e) => replies.fail(new Error(`SMTP : connexion en erreur (${e.code || e.message})`)));
  socket.on("close", () => replies.fail(new Error("SMTP : connexion fermée par le serveur")));
}

/**
 * Envoie un mail. Rend { id } (le Message-ID posé) ; lève une Error lisible
 * (« SMTP 535 … ») sinon. `options.tls` sert aux tests (certificat local).
 */
export async function sendSmtp(config, mail, options = {}) {
  const { host, port, user, password, from } = config;
  const implicitTls = config.secure ?? port === 465;
  const to = bareAddress(mail.to);
  const envelopeFrom = bareAddress(from);
  checkHeaderValue("le destinataire", to);
  checkHeaderValue("l'expéditeur", from);
  checkHeaderValue("l'objet", mail.subject);
  // refus avant toute connexion : un identifiant de fil qui n'est pas un <identifiant> ne part pas
  threadHeader("In-Reply-To", mail.inReplyTo);
  threadHeader("References", mail.references);
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new Error("SMTP : adresse du destinataire invalide");
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(envelopeFrom)) throw new Error("SMTP : adresse de l'expéditeur (MAIL_FROM) invalide");
  const timeoutMs = options.timeoutMs ?? 30_000;
  // SNI : un nom d'hôte seulement (Node refuse une adresse IP comme servername)
  const tlsOptions = { ...(isIP(host) ? {} : { servername: host }), ...(options.tls || {}) };
  const domain = envelopeFrom.split("@")[1] || "localhost";
  const messageId = `<${Date.now().toString(36)}.${randomBytes(8).toString("hex")}@${domain}>`;

  let socket;
  let replies = new Replies();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SMTP : pas de réponse de ${host}:${port} après ${timeoutMs / 1000} s`)), timeoutMs);
  });
  // le délai rejette même si aucune lecture n'est en cours : pas de rejet orphelin
  deadline.catch(() => {});

  const expect = async (accepted, step) => {
    const reply = await Promise.race([replies.next(), deadline]);
    if (!accepted.includes(reply.code)) {
      const detail = reply.lines.join(" ").slice(0, 300);
      throw new Error(`SMTP ${reply.code} à l'étape ${step} : ${detail}`);
    }
    return reply;
  };
  const send = (line) => socket.write(`${line}\r\n`);

  try {
    socket = await Promise.race([
      new Promise((resolve, reject) => {
        const s = implicitTls
          ? tlsConnect({ host, port, ...tlsOptions }, () => resolve(s))
          : netConnect({ host, port }, () => resolve(s));
        s.once("error", (e) => reject(new Error(`SMTP : connexion à ${host}:${port} impossible (${e.code || e.message})`)));
      }),
      deadline,
    ]);
    attach(socket, replies);
    await expect([220], "accueil");
    send(`EHLO ${domain}`);
    let ehlo = await expect([250], "EHLO");

    if (!implicitTls) {
      if (!ehlo.lines.some((l) => /^250[ -]STARTTLS\b/i.test(l))) {
        throw new Error("SMTP : le serveur ne propose pas STARTTLS — envoi refusé (le mot de passe ne part jamais en clair)");
      }
      send("STARTTLS");
      await expect([220], "STARTTLS");
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      const plain = socket;
      socket = await Promise.race([
        new Promise((resolve, reject) => {
          const s = tlsConnect({ socket: plain, ...tlsOptions }, () => resolve(s));
          s.once("error", (e) => reject(new Error(`SMTP : négociation TLS refusée (${e.code || e.message})`)));
        }),
        deadline,
      ]);
      replies = new Replies();
      attach(socket, replies);
      send(`EHLO ${domain}`);
      ehlo = await expect([250], "EHLO après STARTTLS");
    }

    const auth = ehlo.lines.find((l) => /^250[ -]AUTH\b/i.test(l)) || "";
    if (/\bPLAIN\b/i.test(auth)) {
      send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64")}`);
      await expect([235], "AUTH PLAIN");
    } else if (/\bLOGIN\b/i.test(auth)) {
      send("AUTH LOGIN");
      await expect([334], "AUTH LOGIN");
      send(Buffer.from(user, "utf8").toString("base64"));
      await expect([334], "AUTH LOGIN (identifiant)");
      send(Buffer.from(password, "utf8").toString("base64"));
      await expect([235], "AUTH LOGIN (mot de passe)");
    } else {
      throw new Error("SMTP : le serveur n'annonce ni AUTH PLAIN ni AUTH LOGIN");
    }

    send(`MAIL FROM:<${envelopeFrom}>`);
    await expect([250], "MAIL FROM");
    send(`RCPT TO:<${to}>`);
    await expect([250, 251], "RCPT TO");
    send("DATA");
    await expect([354], "DATA");
    socket.write(`${buildMessage({ from, to, subject: mail.subject, text: mail.text, html: mail.html, attachments: mail.attachments, messageId, inReplyTo: mail.inReplyTo, references: mail.references })}\r\n.\r\n`);
    await expect([250], "fin du message");
    send("QUIT");
    // la réponse à QUIT n'a pas d'importance : le mail est accepté
    await Promise.race([replies.next(), new Promise((r) => setTimeout(r, 1000))]).catch(() => {});
    return { id: messageId };
  } finally {
    clearTimeout(timer);
    if (socket) socket.destroy();
  }
}

/** Transport injecté dans `env.SMTP_SEND` par node/server.mjs. */
export function smtpTransport(config, options) {
  return (mail) => sendSmtp(config, mail, options);
}
