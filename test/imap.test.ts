// Client IMAP (node/imap.mjs) contre un faux serveur TLS local qui joue le protocole :
// accueil, CAPABILITY, LOGIN, EXAMINE (jamais SELECT : la boîte reste en lecture seule),
// UID SEARCH, UID FETCH avec littéraux {n}. Vérifie le curseur UID, UIDVALIDITY, les lots,
// la coupe des gros messages, les octets 8 bits, un littéral qui contient des lignes
// ressemblant à des réponses, et qu'un échec de connexion ne divulgue pas le mot de passe.
//
// Le certificat est fabriqué à la volée par openssl dans un dossier temporaire (comme
// smtp.test.ts) : aucune clé n'entre dans le dépôt. Sans openssl, les essais sont sautés.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server, type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
// module JS (node/), hors du typecheck de src/
import { ResponseReader, fetchNewMail, imapConfigFromEnv, imapDate, imapQuote } from "../node/imap.mjs";

let cert: { key: Buffer; cert: Buffer } | null = null;
try {
  const dir = mkdtempSync(join(tmpdir(), "imap-test-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  cert = { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
} catch {
  cert = null;
}
const tls = it.skipIf(!cert);

interface FakeMail {
  uid: number;
  raw: Buffer;
}
interface FakeOptions {
  mails: FakeMail[];
  uidValidity?: number;
  password?: string;
  loginDisabled?: boolean;
  /** Réponse FETCH démesurée : annonce un littéral énorme. */
  hugeLiteral?: boolean;
  /** UID omis une seule fois de la réponse FETCH (réponse partielle transitoire). */
  dropOnce?: number[];
  /** UID jamais rendus par FETCH mais toujours présents (panne). */
  hide?: number[];
  /** UID rendus par SEARCH puis disparus (expulsés entre-temps). */
  gone?: number[];
  /** Après le FETCH, déverse un nombre démesuré de petites réponses non étiquetées. */
  flood?: boolean;
}

/** Faux serveur IMAP. `log` garde les commandes reçues (sans le mot de passe). */
async function fakeImap(opts: FakeOptions) {
  const log: string[] = [];
  const dropped = new Set<number>();
  const password = opts.password ?? "secret-app-password";
  const server: Server = createTlsServer({ key: cert!.key, cert: cert!.cert }, (sock: TLSSocket) => {
    let buf = "";
    sock.write("* OK IMAP4rev1 faux serveur prêt\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const [, tag, cmd, rest = ""] = m;
        log.push(cmd === "LOGIN" ? "LOGIN <masqué>" : `${cmd} ${rest}`.trim());
        if (cmd === "CAPABILITY") {
          sock.write(`* CAPABILITY IMAP4rev1${opts.loginDisabled ? " LOGINDISABLED" : ""}\r\n${tag} OK CAPABILITY terminé\r\n`);
        } else if (cmd === "LOGIN") {
          const ok = rest.includes(`"${password}"`);
          sock.write(ok ? `${tag} OK LOGIN réussi\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Identifiants refusés\r\n`);
        } else if (cmd === "EXAMINE") {
          sock.write(`* 3 EXISTS\r\n* OK [UIDVALIDITY ${opts.uidValidity ?? 7}] UIDs valides\r\n${tag} OK [READ-ONLY] EXAMINE terminé\r\n`);
        } else if (cmd === "UID" && /^SEARCH UID [\d,]+$/.test(rest)) {
          // contrôle d'existence après un FETCH incomplet
          const asked = rest.slice("SEARCH UID ".length).split(",").map(Number);
          const alive = asked.filter((u) => opts.mails.some((x) => x.uid === u) && !opts.gone?.includes(u));
          sock.write(`* SEARCH ${alive.join(" ")}\r\n${tag} OK SEARCH terminé\r\n`);
        } else if (cmd === "UID" && rest.startsWith("SEARCH")) {
          let uids = opts.mails.map((x) => x.uid);
          const after = /^SEARCH UID (\d+):\*/.exec(rest);
          if (after) {
            // « n:* » rend toujours au moins le dernier message
            const n = Number(after[1]);
            uids = uids.filter((u) => u >= n);
            if (uids.length === 0 && opts.mails.length) uids = [opts.mails[opts.mails.length - 1]!.uid];
          }
          sock.write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK SEARCH terminé\r\n`);
        } else if (cmd === "UID" && rest.startsWith("FETCH")) {
          const f = /^FETCH ([\d,]+) \(.*BODY\.PEEK\[\]<0\.(\d+)>\)$/.exec(rest);
          if (!f) {
            sock.write(`${tag} BAD commande FETCH inattendue\r\n`);
            continue;
          }
          const limit = Number(f[2]);
          for (const uid of f[1]!.split(",").map(Number)) {
            const mail = opts.mails.find((x) => x.uid === uid);
            if (!mail || opts.hide?.includes(uid) || opts.gone?.includes(uid)) continue;
            if (opts.dropOnce?.includes(uid) && !dropped.has(uid)) {
              dropped.add(uid);
              continue;
            }
            const part = mail.raw.subarray(0, limit);
            if (opts.hugeLiteral) {
              sock.write(`* 1 FETCH (UID ${uid} RFC822.SIZE 99999999 BODY[]<0> {99999999}\r\n`);
              continue;
            }
            sock.write(Buffer.concat([
              Buffer.from(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${mail.raw.length} BODY[]<0> {${part.length}}\r\n`, "latin1"),
              part,
              Buffer.from(")\r\n", "latin1"),
            ]));
          }
          if (opts.flood) for (let i = 0; i < 5000; i++) sock.write(`* ${i + 10} EXISTS\r\n`);
          sock.write(`${tag} OK FETCH terminé\r\n`);
        } else if (cmd === "LOGOUT") {
          sock.write(`* BYE à bientôt\r\n${tag} OK LOGOUT terminé\r\n`);
          sock.end();
        } else {
          sock.write(`${tag} BAD commande inconnue\r\n`);
        }
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config = { host: "127.0.0.1", port, user: "gites@example.test", password };
  return { config, log, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const OPTS = { tls: { rejectUnauthorized: false }, timeoutMs: 5000 };
const mail = (uid: number, body = "Bonjour"): FakeMail => ({
  uid,
  raw: Buffer.from(`From: a${uid}@example.com\r\nSubject: Mail ${uid}\r\nMessage-ID: <m${uid}@x>\r\n\r\n${body}\r\n`, "latin1"),
});

describe("client IMAP : configuration et briques", () => {
  it("IMAP_PASSWORD retombe sur SMTP_PASSWORD ; rien sans utilisateur ou sans mot de passe", () => {
    expect(imapConfigFromEnv({ IMAP_USER: "g@x.test", SMTP_PASSWORD: "abc" })).toEqual({ host: "imap.gmail.com", port: 993, user: "g@x.test", password: "abc" });
    expect(imapConfigFromEnv({ IMAP_USER: "g@x.test", IMAP_PASSWORD: "p1", SMTP_PASSWORD: "p2", IMAP_HOST: "imap.autre.test", IMAP_PORT: "1993" }))
      .toEqual({ host: "imap.autre.test", port: 1993, user: "g@x.test", password: "p1" });
    expect(imapConfigFromEnv({ SMTP_PASSWORD: "abc" })).toBeNull();
    expect(imapConfigFromEnv({ IMAP_USER: "g@x.test" })).toBeNull();
  });

  it("imapQuote échappe les guillemets et refuse les sauts de ligne", () => {
    expect(imapQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => imapQuote("a\r\nb")).toThrow();
    expect(() => imapQuote("a\0b")).toThrow();
  });

  it("imapDate : jour-mois-année en anglais (SEARCH SINCE)", () => {
    expect(imapDate(new Date("2026-10-05T10:00:00Z"))).toBe("5-Oct-2026");
  });

  it("lecteur : littéral coupé en plusieurs morceaux, lignes qui imitent une réponse dans le littéral", async () => {
    const r = new ResponseReader(1000);
    const lit = "A001 OK faux\r\n* BYE faux\r\nligne";
    const wire = Buffer.from(`* 1 FETCH (BODY[] {${lit.length}}\r\n${lit})\r\nA002 OK fini\r\n`, "latin1");
    // arrivée octet par octet
    for (const b of wire) r.feed(Buffer.from([b]));
    const first = await r.next();
    expect(first.text).toBe("* 1 FETCH (BODY[] \u00000\u0000)");
    expect(first.literals[0]!.toString("latin1")).toBe(lit);
    expect((await r.next()).text).toBe("A002 OK fini");
  });

  it("lecteur : un NUL envoyé par le serveur ne fabrique pas de marqueur de littéral", async () => {
    const r = new ResponseReader(1000);
    r.feed(Buffer.from("* 1 FETCH (X \u00005\u0000)\r\n", "latin1"));
    expect((await r.next()).text).toBe("* 1 FETCH (X 5)");
  });

  it("lecteur : littéral trop grand ou ligne interminable refusés", async () => {
    const big = new ResponseReader(100);
    big.feed(Buffer.from("* 1 FETCH (BODY[] {101}\r\n", "latin1"));
    await expect(big.next()).rejects.toThrow(/littéral/);
    const long = new ResponseReader(100);
    long.feed(Buffer.alloc(1100 * 1024, 0x41));
    await expect(long.next()).rejects.toThrow(/trop longue/);
  });
});

describe("client IMAP contre un faux serveur TLS", () => {
  tls("premier passage : SEARCH SINCE, mails complets, boîte ouverte en lecture seule", async () => {
    const nonAscii = { uid: 5, raw: Buffer.concat([Buffer.from("From: a@b.c\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nd", "latin1"), Buffer.from([0xe9, 0x70, 0xf4, 0x74]), Buffer.from("\r\nA002 OK faux\r\n* BYE\r\n", "latin1")]) };
    const srv = await fakeImap({ mails: [mail(3), nonAscii] });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS);
      expect(out.uidValidity).toBe(7);
      expect(out.mails.map((m: { uid: number }) => m.uid)).toEqual([3, 5]);
      expect(out.more).toBe(false);
      expect(out.highestUid).toBe(5);
      // octets 8 bits intacts, et le « faux protocole » à l'intérieur du littéral n'a rien cassé
      expect(Buffer.from(out.mails[1].raw, "latin1").equals(nonAscii.raw)).toBe(true);
      expect(out.mails[0].truncated).toBe(false);
      const joined = srv.log.join("\n");
      expect(joined).toContain("EXAMINE INBOX");
      expect(joined).toMatch(/UID SEARCH SINCE \d{1,2}-[A-Z][a-z]{2}-\d{4}/);
      expect(joined).not.toMatch(/\bSELECT\b|\bSTORE\b|\bEXPUNGE\b|\bDELETE\b|\bCOPY\b/);
      expect(joined).toContain("BODY.PEEK[]<0.");
    } finally {
      await srv.close();
    }
  });

  tls("reprise : seuls les UID au-delà du curseur ; le dernier ancien message de « n:* » est écarté", async () => {
    const srv = await fakeImap({ mails: [mail(1), mail(2), mail(3)] });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: 7, lastUid: 2, sinceDays: 14, max: 10 }, OPTS);
      expect(out.mails.map((m: { uid: number }) => m.uid)).toEqual([3]);
      expect(srv.log.join("\n")).toContain("UID SEARCH UID 3:*");
      // rien de nouveau : le serveur rend quand même le dernier message (3), le client l'écarte
      const none = await fetchNewMail(srv.config, { uidValidity: 7, lastUid: 3, sinceDays: 14, max: 10 }, OPTS);
      expect(none.mails).toEqual([]);
      expect(none.highestUid).toBeNull();
      expect(none.more).toBe(false);
    } finally {
      await srv.close();
    }
  });

  tls("UIDVALIDITY changée : le curseur est abandonné, retour à la fenêtre SINCE", async () => {
    const srv = await fakeImap({ mails: [mail(1), mail(2)], uidValidity: 99 });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: 7, lastUid: 2, sinceDays: 14, max: 10 }, OPTS);
      expect(out.uidValidity).toBe(99);
      expect(out.mails).toHaveLength(2);
      expect(srv.log.join("\n")).toContain("UID SEARCH SINCE");
    } finally {
      await srv.close();
    }
  });

  tls("lots : les plus anciens d'abord, `more` dit qu'il en reste", async () => {
    const srv = await fakeImap({ mails: [1, 2, 3, 4, 5].map((n) => mail(n)) });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: 7, lastUid: 0, sinceDays: 14, max: 2 }, OPTS);
      expect(out.mails.map((m: { uid: number }) => m.uid)).toEqual([1, 2]);
      expect(out.more).toBe(true);
      expect(out.highestUid).toBe(2);
    } finally {
      await srv.close();
    }
  });

  tls("gros message : seuls les premiers octets descendent, la taille réelle est rendue", async () => {
    const srv = await fakeImap({ mails: [mail(1, "x".repeat(5000))] });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10, maxBytes: 300 }, OPTS);
      expect(out.mails[0].raw.length).toBe(300);
      expect(out.mails[0].truncated).toBe(true);
      expect(out.mails[0].size).toBeGreaterThan(5000);
      expect(srv.log.join("\n")).toContain("BODY.PEEK[]<0.300>");
    } finally {
      await srv.close();
    }
  });

  tls("mot de passe refusé : message lisible, sans le mot de passe ni la commande", async () => {
    const srv = await fakeImap({ mails: [], password: "le-bon" });
    try {
      await fetchNewMail({ ...srv.config, password: "le-mauvais-mdp" }, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS).then(
        () => {
          throw new Error("aurait dû échouer");
        },
        (e: Error) => {
          expect(e.message).toMatch(/LOGIN/);
          expect(e.message).not.toContain("le-mauvais-mdp");
          expect(e.message).not.toContain("gites@example.test");
        },
      );
      expect(srv.log.join("\n")).not.toContain("le-mauvais-mdp");
    } finally {
      await srv.close();
    }
  });

  tls("LOGINDISABLED : le client n'envoie jamais le mot de passe", async () => {
    const srv = await fakeImap({ mails: [], loginDisabled: true });
    try {
      await expect(fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS)).rejects.toThrow(/LOGINDISABLED/);
      expect(srv.log.some((l) => l.startsWith("LOGIN"))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  tls("littéral démesuré annoncé par un serveur hostile : refusé, pas de mémoire gâchée", async () => {
    const srv = await fakeImap({ mails: [mail(1)], hugeLiteral: true });
    try {
      await expect(fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS)).rejects.toThrow(/littéral/);
    } finally {
      await srv.close();
    }
  });

  tls("FETCH incomplet transitoire : les UID manquants sont redemandés, rien n'est perdu", async () => {
    const srv = await fakeImap({ mails: [mail(1), mail(2), mail(3)], dropOnce: [2] });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS);
      expect(out.mails.map((m: { uid: number }) => m.uid)).toEqual([1, 2, 3]);
      expect(srv.log.filter((l) => l.startsWith("UID FETCH"))).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  tls("message qui existe mais n'est pas rendu : erreur, le curseur ne doit pas avancer", async () => {
    const srv = await fakeImap({ mails: [mail(1), mail(2)], hide: [2] });
    try {
      await expect(fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS)).rejects.toThrow(/n'a pas rendu les messages UID 2/);
    } finally {
      await srv.close();
    }
  });

  tls("message expulsé entre SEARCH et FETCH : confirmé par un contrôle, sauté sans erreur", async () => {
    const srv = await fakeImap({ mails: [mail(1), mail(2), mail(3)], gone: [2] });
    try {
      const out = await fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS);
      expect(out.mails.map((m: { uid: number }) => m.uid)).toEqual([1, 3]);
      expect(out.highestUid).toBe(3);
    } finally {
      await srv.close();
    }
  });

  tls("serveur bavard : trop de réponses non étiquetées, connexion abandonnée", async () => {
    const srv = await fakeImap({ mails: [mail(1)], flood: true });
    try {
      await expect(fetchNewMail(srv.config, { uidValidity: null, lastUid: null, sinceDays: 14, max: 10 }, OPTS)).rejects.toThrow(/trop de données/);
    } finally {
      await srv.close();
    }
  });

  tls("serveur muet : délai global", async () => {
    const quiet = createTlsServer({ key: cert!.key, cert: cert!.cert }, (sock) => {
      sock.on("error", () => undefined);
    });
    await new Promise<void>((r) => quiet.listen(0, "127.0.0.1", r));
    const port = (quiet.address() as { port: number }).port;
    try {
      await expect(
        fetchNewMail({ host: "127.0.0.1", port, user: "u", password: "p" }, { uidValidity: null, lastUid: null, sinceDays: 1, max: 1 }, { ...OPTS, timeoutMs: 300 }),
      ).rejects.toThrow(/pas de réponse/);
    } finally {
      await new Promise<void>((r) => quiet.close(() => r()));
    }
  });
});
