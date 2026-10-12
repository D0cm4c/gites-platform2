// Transport SMTP (node/smtp.mjs) contre un faux serveur local : TLS direct
// (465), STARTTLS (587), AUTH PLAIN et LOGIN, refus d'un serveur sans STARTTLS,
// échec d'authentification sans fuite du mot de passe, et branchement dans
// queueEmail (email_log « sent » / « failed »).
//
// Le certificat du faux serveur est fabriqué à la volée par openssl dans un
// dossier temporaire : aucune clé n'entre dans le dépôt. Sans openssl, les
// essais TLS sont sautés (le Mac et la CI Ubuntu l'ont).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// module JS (node/), hors du typecheck de src/
import { buildMessage, quotedPrintable, sendSmtp, smtpConfigFromEnv, smtpTransport } from "../node/smtp.mjs";
import { createTestDb, type TestDb } from "./helpers/d1";
import { emailTransport, queueEmail } from "../src/services/email";

let cert: { key: Buffer; cert: Buffer } | null = null;
let dir = "";
try {
  dir = mkdtempSync(join(tmpdir(), "smtp-test-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  cert = { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
} catch {
  cert = null;
}

interface Received {
  commands: string[];
  data: string;
  authUser: string | null;
  authPassword: string | null;
}

/** Faux serveur SMTP. mode : « tls » (TLS dès la connexion), « starttls », « clair » (sans STARTTLS). */
async function fakeSmtp(opts: { mode: "tls" | "starttls" | "clair"; auth?: "PLAIN" | "LOGIN" | "PLAIN LOGIN"; refuseAuth?: boolean }) {
  const received: Received = { commands: [], data: "", authUser: null, authPassword: null };
  const auth = opts.auth ?? "PLAIN LOGIN";
  const handle = (sock: Socket | TLSSocket, secured: boolean) => {
    let buf = "";
    let inData = false;
    let loginStep: 0 | 1 | 2 = 0;
    const reply = (s: string) => sock.write(`${s}\r\n`);
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            reply("250 2.0.0 accepté");
          } else {
            received.data += line + "\r\n";
          }
          continue;
        }
        received.commands.push(line.startsWith("AUTH PLAIN ") ? "AUTH PLAIN ***" : loginStep ? "***" : line);
        if (loginStep === 1) {
          received.authUser = Buffer.from(line, "base64").toString("utf8");
          loginStep = 2;
          reply("334 UGFzc3dvcmQ6");
          continue;
        }
        if (loginStep === 2) {
          received.authPassword = Buffer.from(line, "base64").toString("utf8");
          loginStep = 0;
          reply(opts.refuseAuth ? "535 5.7.8 authentification refusée" : "235 2.7.0 ok");
          continue;
        }
        const cmd = line.split(" ")[0]!.toUpperCase();
        if (cmd === "EHLO") {
          const caps = ["250-fake.local bonjour"];
          if (opts.mode === "starttls" && !secured) caps.push("250-STARTTLS");
          if (secured || opts.mode === "clair") caps.push(`250-AUTH ${auth}`);
          caps.push("250 SIZE 10240000");
          reply(caps.join("\r\n"));
        } else if (cmd === "STARTTLS") {
          reply("220 2.0.0 prêt");
          sock.removeAllListeners("data");
          const tls = new TLSSocket(sock as Socket, { isServer: true, key: cert!.key, cert: cert!.cert });
          handle(tls, true);
        } else if (cmd === "AUTH") {
          const [, mech, payload] = line.split(" ");
          if (mech === "PLAIN") {
            const parts = Buffer.from(payload ?? "", "base64").toString("utf8").split("\0");
            received.authUser = parts[1] ?? null;
            received.authPassword = parts[2] ?? null;
            reply(opts.refuseAuth ? "535 5.7.8 authentification refusée" : "235 2.7.0 ok");
          } else {
            loginStep = 1;
            reply("334 VXNlcm5hbWU6");
          }
        } else if (cmd === "MAIL" || cmd === "RCPT") {
          reply("250 2.1.0 ok");
        } else if (cmd === "DATA") {
          inData = true;
          reply("354 envoyez");
        } else if (cmd === "QUIT") {
          reply("221 2.0.0 au revoir");
          sock.end();
        } else {
          reply("502 5.5.2 inconnu");
        }
      }
    });
    sock.on("error", () => {});
  };
  const server: Server =
    opts.mode === "tls"
      ? createTlsServer({ key: cert!.key, cert: cert!.cert }, (s) => {
          s.write("220 fake.local ESMTP\r\n");
          handle(s, true);
        })
      : createServer((s) => {
          s.write("220 fake.local ESMTP\r\n");
          handle(s, false);
        });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const TLS_TEST = { rejectUnauthorized: false };
const config = (port: number, secure: boolean) => ({
  host: "127.0.0.1", port, secure, user: "reservations@exemple.be", password: "mot-de-passe-secret", from: "Les Gîtes du Pré Moré <reservations@exemple.be>",
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("message construit pour DATA", () => {
  it("objet encodé, corps en quoted-printable UTF-8, ligne qui commence par un point doublée", () => {
    const m = buildMessage({
      from: "Les Gîtes <r@exemple.be>", to: "client@exemple.com", subject: "Réservation confirmée",
      text: "Bonjour,\n.début de ligne\nTotal : 1 200,00 €", messageId: "<x@exemple.be>",
    });
    expect(m).toMatch(/^From: =\?UTF-8\?B\?/m);
    expect(m).toContain("Subject: =?UTF-8?B?");
    expect(m).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(m).toContain("\r\n..d=C3=A9but de ligne\r\n");
    expect(m).toContain("1 200,00 =E2=82=AC");
  });

  it("quoted-printable : lignes de 76 caractères au plus, espace finale encodée", () => {
    const qp = quotedPrintable("x".repeat(200) + " \nfin");
    for (const l of qp.split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
    expect(qp).toContain("=20\r\nfin");
  });

  it("une espace finale en bout de ligne pleine ne fait pas dépasser 76 caractères ; objet long replié", () => {
    for (let n = 70; n <= 80; n += 1) {
      for (const l of quotedPrintable("a".repeat(n) + " \nfin").split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
    }
    const m = buildMessage({ from: "r@exemple.be", to: "c@exemple.com", subject: "Rappel — ".replace("—", "-") + "x".repeat(120), text: "y", messageId: "<x@y>" });
    for (const l of m.split("\r\n\r\n")[0]!.split("\r\n")) expect(l.length).toBeLessThanOrEqual(78);
  });

  it("configuration : les quatre variables, 465 en TLS direct, 587 en STARTTLS", () => {
    expect(smtpConfigFromEnv({ SMTP_HOST: "mail.infomaniak.com", SMTP_USER: "u", SMTP_PASSWORD: "p" })).toBeNull();
    expect(smtpConfigFromEnv({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "f@x.be" })).toMatchObject({ port: 465, secure: true });
    expect(smtpConfigFromEnv({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "f@x.be" })).toMatchObject({ port: 587, secure: false });
  });
});

describe.skipIf(!cert)("envoi contre un faux serveur SMTP", () => {
  it("TLS dès la connexion (465), AUTH PLAIN : le mail arrive entier", async () => {
    const srv = await fakeSmtp({ mode: "tls" });
    try {
      const r = await sendSmtp(config(srv.port, true), { to: "Client <client@exemple.com>", subject: "Voucher", text: "Bonjour" }, { tls: TLS_TEST });
      expect(r.id).toMatch(/^<.+@exemple\.be>$/);
      expect(srv.received.authUser).toBe("reservations@exemple.be");
      expect(srv.received.authPassword).toBe("mot-de-passe-secret");
      expect(srv.received.commands).toContain("MAIL FROM:<reservations@exemple.be>");
      expect(srv.received.commands).toContain("RCPT TO:<client@exemple.com>");
      expect(srv.received.data).toContain("Subject: Voucher");
      expect(srv.received.data).toContain(`Message-ID: ${r.id}`);
    } finally {
      await srv.close();
    }
  });

  it("STARTTLS (587) puis AUTH LOGIN quand PLAIN n'est pas proposé", async () => {
    const srv = await fakeSmtp({ mode: "starttls", auth: "LOGIN" });
    try {
      await sendSmtp(config(srv.port, false), { to: "client@exemple.com", subject: "Reçu", text: "Merci" }, { tls: TLS_TEST });
      expect(srv.received.commands.filter((c) => c.startsWith("EHLO"))).toHaveLength(2);
      expect(srv.received.commands).toContain("STARTTLS");
      expect(srv.received.commands).toContain("AUTH LOGIN");
      expect(srv.received.authPassword).toBe("mot-de-passe-secret");
    } finally {
      await srv.close();
    }
  });

  it("un serveur sans STARTTLS est refusé AVANT tout envoi du mot de passe", async () => {
    const srv = await fakeSmtp({ mode: "clair" });
    try {
      await expect(sendSmtp(config(srv.port, false), { to: "client@exemple.com", subject: "x", text: "y" })).rejects.toThrow(/STARTTLS/);
      expect(srv.received.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
      expect(srv.received.authPassword).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("authentification refusée : erreur lisible, sans le mot de passe", async () => {
    const srv = await fakeSmtp({ mode: "tls", refuseAuth: true });
    try {
      const err = await sendSmtp(config(srv.port, true), { to: "client@exemple.com", subject: "x", text: "y" }, { tls: TLS_TEST }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^SMTP 535/);
      expect((err as Error).message).not.toContain("mot-de-passe-secret");
    } finally {
      await srv.close();
    }
  });

  it("un destinataire avec saut de ligne est refusé (pas d'injection d'en-tête)", async () => {
    await expect(sendSmtp(config(1, true), { to: "a@b.c\r\nBcc: x@y.z", subject: "x", text: "y" })).rejects.toThrow(/saut de ligne/);
  });
});

describe.skipIf(!cert)("queueEmail avec le transport SMTP", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.dispose();
  });

  const envWith = (send: Env["SMTP_SEND"], enabled = "true"): Env => ({
    DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: enabled,
    SMTP_HOST: "127.0.0.1", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "r@exemple.be", SMTP_SEND: send,
    RESEND_API_KEY: "re_jamais_utilisee",
  });

  it("EMAILS_ENABLED=true et SMTP posé : SMTP prime sur Resend, le journal dit « sent »", async () => {
    const srv = await fakeSmtp({ mode: "tls" });
    try {
      const env = envWith(smtpTransport(config(srv.port, true), { tls: TLS_TEST }));
      expect(emailTransport(env)).toBe("smtp");
      const status = await queueEmail(t.db, env, { to: "client@exemple.com", subject: "Voucher", bodyText: "Bonjour", kind: "voucher" });
      expect(status).toBe("sent");
      const row = await t.db.prepare("SELECT status, provider_id FROM email_log ORDER BY id DESC LIMIT 1").first<{ status: string; provider_id: string }>();
      expect(row?.status).toBe("sent");
      expect(row?.provider_id).toMatch(/@exemple\.be>$/);
    } finally {
      await srv.close();
    }
  });

  it("échec SMTP : « failed » et le détail au journal", async () => {
    const env = envWith(async () => {
      throw new Error("SMTP 535 à l'étape AUTH PLAIN : refusé");
    });
    expect(await queueEmail(t.db, env, { to: "c@exemple.com", subject: "x", bodyText: "y", kind: "reply" })).toBe("failed");
    const row = await t.db.prepare("SELECT status, error_detail FROM email_log ORDER BY id DESC LIMIT 1").first<{ status: string; error_detail: string }>();
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.error_detail).toContain("SMTP 535");
  });

  it("EMAILS_ENABLED=false : stub, aucun envoi", async () => {
    let called = false;
    const env = envWith(async () => {
      called = true;
      return { id: "x" };
    }, "false");
    expect(emailTransport(env)).toBeNull();
    expect(await queueEmail(t.db, env, { to: "c@exemple.com", subject: "x", bodyText: "y", kind: "reply" })).toBe("stub");
    expect(called).toBe(false);
  });

  it("variables SMTP incomplètes : Resend reste le transport (Workers inchangé)", () => {
    const env = { ...envWith(undefined), SMTP_HOST: "" };
    expect(emailTransport(env)).toBe("resend");
  });
});

describe("fil de conversation (In-Reply-To / References)", () => {
  const base = { from: "Les Gîtes <g@exemple.com>", to: "c@exemple.com", subject: "Re: x", text: "y", messageId: "<m@exemple.com>" };

  it("buildMessage pose In-Reply-To et References ; References retombe sur In-Reply-To", () => {
    const m = buildMessage({ ...base, inReplyTo: "<p@x>", references: "<a@x> <b@x> <c@x> <p@x>" });
    expect(m).toContain("In-Reply-To: <p@x>\r\n");
    expect(m).toContain("References: <a@x> <b@x> <c@x>\r\n <p@x>\r\n");
    expect(buildMessage({ ...base, inReplyTo: "<p@x>" })).toContain("References: <p@x>\r\n");
    expect(buildMessage(base)).not.toContain("In-Reply-To");
  });

  it("une valeur qui n'est pas une liste d'<identifiants> (injection d'en-tête) est refusée avant toute connexion", async () => {
    expect(() => buildMessage({ ...base, inReplyTo: "<p@x>\r\nBcc: v@x.be" })).toThrow(/In-Reply-To invalide/);
    expect(() => buildMessage({ ...base, inReplyTo: "<p@x>", references: "<a@x> Bcc: v@x.be" })).toThrow(/References invalide/);
    const cfg = { host: "127.0.0.1", port: 1, secure: true, user: "u", password: "p", from: "g@exemple.com" };
    await expect(sendSmtp(cfg, { to: "c@exemple.com", subject: "x", text: "y", inReplyTo: "<a@x>\r\nBcc: v@x.be" })).rejects.toThrow(/invalide/);
  });
});
