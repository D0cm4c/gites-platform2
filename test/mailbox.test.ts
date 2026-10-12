// Relève de la boîte de contact (services/mailbox.ts) sur vraie D1, avec un faux
// IMAP_FETCH qui rejoue le contrat de node/imap.mjs : curseur UID, UIDVALIDITY, lots.
// Idempotence, rattachement (référence, fil, adresse = réservation la plus proche),
// expéditeur qui usurpe l'adresse des gîtes, pièces listées, Workers sans socket.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { createBookingAtomic, insertOutboundMessage, listMessages, upsertGuest } from "../src/db/repo";
import { MAILBOX_LEASE_KEY, MAILBOX_STATE_KEY, NO_SOCKET_MESSAGE, closestBooking, getMailboxState, pullMailbox } from "../src/services/mailbox";
import { getSetting } from "../src/services/settings";

let t: TestDb;
let db: D1Database;
const NOW = new Date("2026-07-12T10:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["messages", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM app_settings WHERE key IN (?1, ?2)").bind(MAILBOX_STATE_KEY, MAILBOX_LEASE_KEY).run();
});

// --- faux serveur IMAP -------------------------------------------------------

interface Stored {
  uid: number;
  raw: string;
  size?: number;
  truncated?: boolean;
}

/** Rejoue ImapQuery → ImapBatch comme node/imap.mjs : UID > curseur si UIDVALIDITY inchangée, lots, plus anciens d'abord. */
function fakeMailbox(initial: Stored[], uidValidity = 1) {
  const state = { mails: [...initial], uidValidity, calls: [] as ImapQuery[], failWith: null as Error | null };
  const fetch = async (q: ImapQuery): Promise<ImapBatch> => {
    state.calls.push({ ...q });
    if (state.failWith) throw state.failWith;
    const resume = q.lastUid != null && q.uidValidity === state.uidValidity;
    const wanted = state.mails.filter((m) => (resume ? m.uid > q.lastUid! : true)).sort((a, b) => a.uid - b.uid);
    const batch = wanted.slice(0, q.max);
    return {
      uidValidity: state.uidValidity,
      mails: batch.map((m) => ({ uid: m.uid, raw: m.raw, size: m.size ?? m.raw.length, truncated: m.truncated ?? false })),
      more: wanted.length > batch.length,
      highestUid: batch.length ? batch[batch.length - 1]!.uid : null,
    };
  };
  return { state, fetch };
}

const envWith = (fetch?: Env["IMAP_FETCH"], extra: Partial<Env> = {}): Env =>
  ({ DB: db, PUBLIC_BASE_URL: "http://test.local", IMAP_USER: "lesgitesdupremore@gmail.com", IMAP_PASSWORD: "x", IMAP_FETCH: fetch, ...extra }) as Env;

const raw = (headers: Record<string, string>, body: string) =>
  [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", body].join("\r\n");

const simple = (n: number, extra: Record<string, string> = {}, body = "Bonjour, une question.") =>
  raw({ From: `Jean <jean${n}@example.com>`, To: "lesgitesdupremore@gmail.com", Subject: `Question ${n}`, "Message-ID": `<q${n}@mail.example.com>`, Date: "Sun, 12 Jul 2026 08:00:00 +0000", ...extra }, body);

async function guestWithStay(email: string, checkin: string, checkout: string, status: "confirmed" | "cancelled" = "confirmed") {
  const guestId = await upsertGuest(db, { email, lastName: "Durand" });
  const created = await createBookingAtomic(db, {
    unitId: 2, checkin, checkout, adults: 2, children: 0, status: "confirmed", source: "manual", guestId, now: NOW,
  });
  if (!created.ok) throw new Error("réservation de test refusée");
  if (status === "cancelled") await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(created.id).run();
  return { guestId, bookingId: created.id, reference: created.reference };
}

describe("pullMailbox : désactivée proprement", () => {
  it("pas de IMAP_USER : rien, sans bruit", async () => {
    const r = await pullMailbox({ DB: db } as Env, NOW);
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/non configurée/);
  });

  it("Workers (pas de socket) : message clair, une seule ligne de journal, état gardé", async () => {
    const env = envWith(undefined);
    const r1 = await pullMailbox(env, NOW);
    const r2 = await pullMailbox(env, NOW);
    expect(r1.ran).toBe(false);
    expect(r1.reason).toBe(NO_SOCKET_MESSAGE);
    expect(r2.reason).toBe(NO_SOCKET_MESSAGE);
    expect((await getMailboxState(db)).disabled).toBe(NO_SOCKET_MESSAGE);
    const { results } = await db.prepare("SELECT action FROM audit_log WHERE action = 'mailbox.imap.disabled'").all();
    expect(results).toHaveLength(1);
  });

  it("IMAP_PASSWORD absent mais SMTP_PASSWORD posé : la relève est configurée", async () => {
    const box = fakeMailbox([{ uid: 1, raw: simple(1) }]);
    const env = envWith(box.fetch, { IMAP_PASSWORD: undefined, SMTP_PASSWORD: "app-pw" });
    expect((await pullMailbox(env, NOW)).imported).toBe(1);
  });
});

describe("pullMailbox : import, curseur, idempotence", () => {
  it("importe, avance le curseur, ne relit jamais ce qui est déjà passé", async () => {
    const box = fakeMailbox([{ uid: 10, raw: simple(1) }, { uid: 11, raw: simple(2) }]);
    const env = envWith(box.fetch);
    const r1 = await pullMailbox(env, NOW);
    expect(r1).toMatchObject({ ran: true, fetched: 2, imported: 2, duplicates: 0, more: false });
    expect(box.state.calls[0]).toMatchObject({ lastUid: null, uidValidity: null, sinceDays: 14 });
    expect(await getMailboxState(db)).toMatchObject({ uidValidity: 1, lastUid: 11, error: null });

    // passage suivant : le curseur est repris, rien n'est redemandé
    const r2 = await pullMailbox(env, NOW);
    expect(r2).toMatchObject({ fetched: 0, imported: 0 });
    expect(box.state.calls[1]).toMatchObject({ lastUid: 11, uidValidity: 1 });

    // un mail de plus : lui seul vient
    box.state.mails.push({ uid: 12, raw: simple(3) });
    expect(await pullMailbox(env, NOW)).toMatchObject({ fetched: 1, imported: 1 });
    expect(await listMessages(db, {})).toHaveLength(3);
  });

  it("idempotent par Message-ID même si le curseur est perdu (UIDVALIDITY changée, boîte reconstruite)", async () => {
    const box = fakeMailbox([{ uid: 10, raw: simple(1) }, { uid: 11, raw: simple(2) }]);
    const env = envWith(box.fetch);
    await pullMailbox(env, NOW);
    // le serveur renumérote tout : mêmes mails, nouveaux UID, nouvelle UIDVALIDITY
    box.state.uidValidity = 2;
    box.state.mails = [{ uid: 1, raw: simple(1) }, { uid: 2, raw: simple(2) }, { uid: 3, raw: simple(9) }];
    const r = await pullMailbox(env, NOW);
    expect(r).toMatchObject({ fetched: 3, imported: 1, duplicates: 2 });
    expect(box.state.calls[1]).toMatchObject({ uidValidity: 1, lastUid: 11 }); // le client voit la différence
    expect(await getMailboxState(db)).toMatchObject({ uidValidity: 2, lastUid: 3 });
    expect(await listMessages(db, {})).toHaveLength(3);
  });

  it("lots : trois lots de 40 au plus par passage, le reste au passage suivant", async () => {
    const mails = Array.from({ length: 130 }, (_, i) => ({ uid: i + 1, raw: simple(i + 1) }));
    const box = fakeMailbox(mails);
    const env = envWith(box.fetch);
    const r1 = await pullMailbox(env, NOW);
    expect(r1).toMatchObject({ imported: 120, more: true });
    expect(box.state.calls).toHaveLength(3);
    const r2 = await pullMailbox(env, NOW);
    expect(r2).toMatchObject({ imported: 10, more: false });
    expect((await getMailboxState(db)).lastUid).toBe(130);
  });

  it("panne IMAP : jamais d'exception, l'état la garde, le journal ne se répète pas", async () => {
    const box = fakeMailbox([]);
    box.state.failWith = new Error("IMAP à l'étape LOGIN : NO identifiants refusés");
    const env = envWith(box.fetch);
    const r1 = await pullMailbox(env, NOW);
    const r2 = await pullMailbox(env, NOW);
    expect(r1.error).toMatch(/LOGIN/);
    expect(r2.error).toMatch(/LOGIN/);
    expect((await getMailboxState(db)).error).toMatch(/LOGIN/);
    const { results } = await db.prepare("SELECT action FROM audit_log WHERE action = 'mailbox.imap.error'").all();
    expect(results).toHaveLength(1);
    // la panne passée, le curseur n'a pas bougé et tout revient
    box.state.failWith = null;
    box.state.mails = [{ uid: 5, raw: simple(5) }];
    expect(await pullMailbox(env, NOW)).toMatchObject({ imported: 1 });
    expect((await getMailboxState(db)).error).toBeNull();
  });

  it("deux relèves à la fois : la seconde attend son tour", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const box = fakeMailbox([{ uid: 1, raw: simple(1) }]);
    const slow: Env["IMAP_FETCH"] = async (q) => {
      await gate;
      return box.fetch(q);
    };
    const env = envWith(slow);
    const first = pullMailbox(env, NOW);
    await new Promise((r) => setTimeout(r, 20));
    const second = await pullMailbox(env, NOW);
    expect(second.ran).toBe(false);
    expect(second.reason).toMatch(/déjà en cours/);
    release();
    expect((await first).imported).toBe(1);
    // bail rendu : la relève suivante passe
    expect((await pullMailbox(env, NOW)).ran).toBe(true);
  });

  it("bail laissé par une instance plantée : il expire seul, et le curseur ne recule jamais", async () => {
    const box = fakeMailbox([{ uid: 1, raw: simple(1) }, { uid: 2, raw: simple(2) }]);
    const env = envWith(box.fetch);
    // un bail vivant : refus
    await db.prepare("INSERT INTO app_settings (key, value) VALUES (?1, ?2)").bind(MAILBOX_LEASE_KEY, "2026-07-12T10:03:00.000Z").run();
    expect((await pullMailbox(env, NOW)).ran).toBe(false);
    // 10 minutes plus tard, le bail est périmé
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect((await pullMailbox(env, later)).imported).toBe(2);
    expect((await getMailboxState(db)).lastUid).toBe(2);
    // une instance lente qui finirait avec un vieux curseur ne fait pas reculer l'état
    const slow = fakeMailbox([{ uid: 1, raw: simple(1) }], 1);
    const state = await getMailboxState(db);
    expect(state.lastUid).toBe(2);
    await pullMailbox(envWith(slow.fetch), new Date(later.getTime() + 10 * 60_000));
    expect((await getMailboxState(db)).lastUid).toBe(2);
  });

  it("une relève lente ne libère pas le bail qu'une autre a repris", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const box = fakeMailbox([]);
    const slow: Env["IMAP_FETCH"] = async (q) => {
      await gate;
      return box.fetch(q);
    };
    const first = pullMailbox(envWith(slow), NOW);
    await new Promise((r) => setTimeout(r, 20));
    // 10 minutes plus tard, une autre instance reprend le bail périmé
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const second = pullMailbox(envWith(slow), later);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    // les deux ont fini : le bail est libre pour le passage suivant
    expect((await pullMailbox(envWith(box.fetch), new Date(later.getTime() + 1000))).ran).toBe(true);
  });
});

describe("pullMailbox : rattachement", () => {
  it("expéditeur = client : la réservation la plus proche dans le temps (séjour en cours > prochain > passé)", async () => {
    const past = await guestWithStay("marie@example.com", "2026-05-01", "2026-05-05");
    const current = await guestWithStay("marie@example.com", "2026-07-10", "2026-07-14");
    await guestWithStay("marie@example.com", "2026-09-01", "2026-09-05");
    const box = fakeMailbox([{ uid: 1, raw: raw({ From: "Marie <marie@example.com>", Subject: "Où est la clé ?", "Message-ID": "<k1@x>" }, "Bonjour") }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.bookingId).toBe(current.bookingId);
    expect(msg!.guestId).toBe(current.guestId);
    expect(msg!.channel).toBe("email");
    expect(past.bookingId).not.toBe(current.bookingId);
  });

  it("sans séjour en cours : la plus proche, une annulée ne passe qu'en dernier recours", async () => {
    const soon = await guestWithStay("luc@example.com", "2026-07-20", "2026-07-25");
    await guestWithStay("luc@example.com", "2026-07-14", "2026-07-16", "cancelled");
    const box = fakeMailbox([{ uid: 1, raw: raw({ From: "luc@example.com", Subject: "Arrivée", "Message-ID": "<l1@x>" }, "Salut") }]);
    await pullMailbox(envWith(box.fetch), NOW);
    expect((await listMessages(db, {}))[0]!.bookingId).toBe(soon.bookingId);
    // closestBooking seul : uniquement des annulées → la plus proche quand même
    expect(closestBooking([{ status: "cancelled", checkin: "2026-07-01", checkout: "2026-07-03" } as never], "2026-07-12")).not.toBeNull();
    expect(closestBooking([], "2026-07-12")).toBeNull();
  });

  it("référence dans le sujet : prime sur l'adresse", async () => {
    const a = await guestWithStay("ref@example.com", "2026-08-01", "2026-08-05");
    const box = fakeMailbox([{ uid: 1, raw: raw({ From: "inconnu@example.com", Subject: `Re: ${a.reference} acompte`, "Message-ID": "<r1@x>" }, "Voici la preuve") }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.bookingId).toBe(a.bookingId);
    expect(msg!.bookingReference).toBe(a.reference);
  });

  it("réponse à l'un de nos mails (In-Reply-To) : le fil retrouve la réservation même depuis une autre adresse", async () => {
    const a = await guestWithStay("couple@example.com", "2026-08-01", "2026-08-05");
    await insertOutboundMessage(db, {
      propertyId: 1, toEmail: "couple@example.com", fromEmail: "gites@x.be", subject: "Votre séjour", bodyText: "Bonjour",
      bookingId: a.bookingId, guestId: a.guestId, delivery: "sent", channel: "email", messageId: "<sortant-1@gites>",
    });
    const box = fakeMailbox([{ uid: 1, raw: raw({ From: "Son ami <ami@autre.test>", Subject: "Re: Votre séjour", "Message-ID": "<rep1@x>", "In-Reply-To": "<sortant-1@gites>", References: "<vieux@x> <sortant-1@gites>" }, "C'est moi qui réponds") }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const inbound = (await listMessages(db, { direction: "in" }))[0]!;
    expect(inbound.bookingId).toBe(a.bookingId);
    expect(inbound.inReplyTo).toBe("<sortant-1@gites>");
    expect(inbound.refs).toBe("<vieux@x> <sortant-1@gites>");
  });

  it("inconnu : fil « sans réservation », visible quand même", async () => {
    const box = fakeMailbox([{ uid: 1, raw: simple(1) }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg).toMatchObject({ bookingId: null, guestId: null, fromEmail: "jean1@example.com", fromName: "Jean", status: "nouveau", direction: "in" });
  });
});

describe("pullMailbox : contenu et sécurité", () => {
  it("pièces jointes listées (nom, taille), pas lues comme corps ; texte HTML converti", async () => {
    const mime = [
      "From: a@example.com", "Subject: Photos", "Message-ID: <p1@x>", 'Content-Type: multipart/mixed; boundary="B1"', "",
      "--B1", "Content-Type: text/html; charset=utf-8", "", "<p>Voici les <b>photos</b> &amp; le plan.</p>",
      "--B1", 'Content-Type: image/jpeg; name="chalet.jpg"', 'Content-Disposition: attachment; filename="chalet.jpg"', "Content-Transfer-Encoding: base64", "",
      "A".repeat(400), "--B1", 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', "", "texte de la pièce, pas du mail", "--B1--", "",
    ].join("\r\n");
    const box = fakeMailbox([{ uid: 1, raw: mime }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.bodyText).toBe("Voici les photos & le plan.");
    expect(msg!.attachments).toEqual([{ name: "chalet.jpg", size: 300 }, { name: "note.txt", size: 30 }]);
  });

  it("XSS : le contenu reste du texte, balises et scripts supprimés, jamais interprétés", async () => {
    const html = raw({ From: "x@example.com", Subject: "<script>alert(1)</script>", "Message-ID": "<x1@x>", "Content-Type": "text/html; charset=utf-8" },
      '<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">cliquez</a><a href="http://evil.test/p">Mon compte</a>&lt;b&gt;gras&lt;/b&gt;');
    const box = fakeMailbox([{ uid: 1, raw: html }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.bodyText).not.toMatch(/<script|<img|onerror=|javascript:/i);
    expect(msg!.bodyText).toContain("cliquez");
    // la vraie cible d'un lien est écrite en clair à côté de son texte
    expect(msg!.bodyText).toContain("Mon compte (http://evil.test/p)");
    expect(msg!.bodyText).toContain("<b>gras</b>"); // du texte, pas du HTML : l'écran l'échappe
  });

  it("injection par en-têtes : saut de ligne dans l'objet ou le nom effacé, Message-ID/References nettoyés", async () => {
    const evil = [
      "From: =?utf-8?Q?Pirate=0D=0ABcc:_x@y.z?= <p@example.com>", "Subject: =?utf-8?Q?a=0D=0ABcc:_victime@x.be?=",
      "Message-ID: <ok@x>", "In-Reply-To: <a@x>\r\n Bcc: y@z", "References: <r1@x> junk <r2@x>", "", "texte",
    ].join("\r\n");
    const box = fakeMailbox([{ uid: 1, raw: evil }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.subject).not.toMatch(/[\r\n]/);
    expect(msg!.fromName).not.toMatch(/[\r\n]/);
    expect(msg!.inReplyTo).toBe("<a@x>");
    expect(msg!.refs).toBe("<r1@x> <r2@x>");
  });

  it("expéditeur qui usurpe l'adresse des gîtes : signalé, sauf si Gmail l'atteste", async () => {
    const forged = raw({ From: "Les Gîtes <lesgitesdupremore@gmail.com>", Subject: "Virement urgent", "Message-ID": "<f1@x>",
      "Authentication-Results": "mx.evil.test; dmarc=pass" }, "Payez ici");
    const genuine = raw({ From: "lesgitesdupremore@gmail.com", Subject: "Note perso", "Message-ID": "<g1@x>",
      "Authentication-Results": "mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass (p=NONE)" }, "Rappel");
    const stranger = raw({ From: "tiers@example.com", Subject: "Bonjour", "Message-ID": "<s1@x>" }, "Salut");
    const box = fakeMailbox([{ uid: 1, raw: forged }, { uid: 2, raw: genuine }, { uid: 3, raw: stranger }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const by = Object.fromEntries((await listMessages(db, {})).map((m) => [m.messageId, m.spoofed]));
    expect(by["<f1@x>"]).toBe(true);
    expect(by["<g1@x>"]).toBe(false);
    expect(by["<s1@x>"]).toBe(false);
  });

  it("gros message coupé : mention claire, tailles des pièces inconnues, corps plafonné", async () => {
    const box = fakeMailbox([{ uid: 1, raw: raw({ From: "g@example.com", Subject: "Gros", "Message-ID": "<big@x>" }, "début"), size: 12 * 1024 * 1024, truncated: true }]);
    await pullMailbox(envWith(box.fetch), NOW);
    const [msg] = await listMessages(db, {});
    expect(msg!.bodyText).toContain("début");
    expect(msg!.bodyText).toMatch(/Message volumineux \(12,0 Mo\)/);
    const long = fakeMailbox([{ uid: 1, raw: raw({ From: "g@example.com", Subject: "Long", "Message-ID": "<long@x>" }, "z".repeat(60000)) }]);
    await db.prepare("DELETE FROM messages").run();
    await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(MAILBOX_STATE_KEY).run();
    await pullMailbox(envWith(long.fetch), NOW);
    const [msg2] = await listMessages(db, {});
    expect(msg2!.bodyText.length).toBeLessThan(20100);
    expect(msg2!.bodyText).toMatch(/message tronqué/);
  });

  it("mail sans Message-ID : identifiant de remplacement stable (pas de doublon au second passage)", async () => {
    const box = fakeMailbox([{ uid: 4, raw: raw({ From: "n@example.com", Subject: "Sans id" }, "corps") }]);
    const env = envWith(box.fetch);
    await pullMailbox(env, NOW);
    box.state.uidValidity = 1;
    // curseur perdu : on rejoue
    await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(MAILBOX_STATE_KEY).run();
    expect((await pullMailbox(env, NOW)).duplicates).toBe(1);
    expect(await listMessages(db, {})).toHaveLength(1);
    expect(await getSetting(db, MAILBOX_STATE_KEY)).toContain('"lastUid":4');
  });

  it("date : celle du mail, ramenée à maintenant si elle est dans le futur", async () => {
    const box = fakeMailbox([
      { uid: 1, raw: simple(1, { Date: "Sat, 11 Jul 2026 10:00:00 +0000" }) },
      { uid: 2, raw: simple(2, { Date: "Mon, 01 Jan 2035 10:00:00 +0000" }) },
    ]);
    await pullMailbox(envWith(box.fetch), NOW);
    const list = await listMessages(db, {});
    const byId = Object.fromEntries(list.map((m) => [m.messageId, m.receivedAt]));
    expect(byId["<q1@mail.example.com>"]).toBe("2026-07-11 10:00:00");
    expect(byId["<q2@mail.example.com>"]).toBe("2026-07-12 10:00:00");
  });
});
