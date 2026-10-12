// Répondre depuis Messages à un mail de la boîte de contact : envoi SMTP depuis
// l'adresse des gîtes avec In-Reply-To / References (le fil Gmail est conservé),
// journal email_log, message sortant visible dans le fil, réponse du client qui
// retombe dans le même fil. Refus de répondre à l'adresse des gîtes (boucle).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { createBookingAtomic, insertInboundMessage, upsertGuest } from "../src/db/repo";
import { MAILBOX_STATE_KEY, pullMailbox } from "../src/services/mailbox";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN = "test-admin-token";
const sent: { to: string; subject: string; text: string; inReplyTo?: string | null; references?: string | null }[] = [];

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "true", ADMIN_TOKEN: ADMIN,
    SMTP_HOST: "smtp.test", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "Les Gîtes <lesgitesdupremore@gmail.com>",
    IMAP_USER: "lesgitesdupremore@gmail.com",
    SMTP_SEND: async (mail) => {
      sent.push(mail);
      return { id: `<sortant-${sent.length}@gites.test>` };
    },
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  sent.length = 0;
  for (const table of ["messages", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
  await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(MAILBOX_STATE_KEY).run();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function inbound(extra: Partial<Parameters<typeof insertInboundMessage>[1]> = {}) {
  return insertInboundMessage(t.db, {
    propertyId: 1, messageId: "<client-1@mail.example.com>", channel: "email", fromEmail: "marie@example.com", fromName: "Marie",
    toEmail: "lesgitesdupremore@gmail.com", subject: "Question sur le sauna", bodyText: "Est-il chauffé ?", references: "<ancien@x>", ...extra,
  });
}

describe("réponse à un mail depuis Messages", () => {
  it("part par SMTP avec le fil, est journalisée, et s'affiche dans le fil avec l'origine e-mail", async () => {
    const id = (await inbound())!;
    const res = await call("POST", `/api/admin/messages/${id}/reply`, { body: "Oui, il est chauffé dès 16 h." });
    expect(res.status).toBe(200);
    expect(res.data.delivery).toBe("sent");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "marie@example.com", subject: "Re: Question sur le sauna",
      inReplyTo: "<client-1@mail.example.com>", references: "<ancien@x> <client-1@mail.example.com>",
    });

    const log = await t.db.prepare("SELECT to_email, kind, status, provider_id FROM email_log").all<{ to_email: string; kind: string; status: string; provider_id: string }>();
    expect(log.results).toEqual([{ to_email: "marie@example.com", kind: "reply", status: "sent", provider_id: "<sortant-1@gites.test>" }]);

    const thread = await call("GET", `/api/admin/messages/${id}/thread`);
    const items = thread.data.thread as { direction: string; channel: string; subject: string; messageId?: string }[];
    expect(items.map((m) => [m.direction, m.channel])).toEqual([["in", "email"], ["out", "email"]]);
    // le message ouvert est « traité »
    expect(((await call("GET", "/api/admin/messages?status=nouveau")).data.messages as unknown[])).toHaveLength(0);
  });

  it("la réponse du client (In-Reply-To = notre Message-ID) retombe dans la même réservation", async () => {
    const guestId = await upsertGuest(t.db, { email: "marie@example.com", lastName: "Lambert" });
    const created = await createBookingAtomic(t.db, {
      unitId: 2, checkin: "2026-12-10", checkout: "2026-12-14", adults: 2, children: 0, status: "confirmed", source: "manual", guestId,
    });
    expect(created.ok).toBe(true);
    const bookingId = created.ok ? created.id : 0;
    const id = (await inbound({ bookingId, guestId }))!;
    await call("POST", `/api/admin/messages/${id}/reply`, { body: "Bien sûr." });

    const mime = ["From: Autre Adresse <partenaire@autre.test>", "To: lesgitesdupremore@gmail.com", "Subject: Re: Question sur le sauna",
      "Message-ID: <suite@autre.test>", "In-Reply-To: <sortant-1@gites.test>", "", "Merci !"].join("\r\n");
    const box = async (): Promise<ImapBatch> => ({ uidValidity: 1, mails: [{ uid: 1, raw: mime, size: mime.length, truncated: false }], more: false, highestUid: 1 });
    const out = await pullMailbox({ ...env, IMAP_PASSWORD: "x", IMAP_FETCH: box }, new Date());
    expect(out.imported).toBe(1);
    const row = await t.db.prepare("SELECT booking_id FROM messages WHERE message_id = '<suite@autre.test>'").first<{ booking_id: number }>();
    expect(row?.booking_id).toBe(bookingId);
  });

  it("envoi SMTP en échec : le message reste « à répondre », l'échec est visible", async () => {
    const id = (await inbound())!;
    const failing = { ...env, SMTP_SEND: async () => { throw new Error("SMTP 421 indisponible"); } } as Env;
    const req = new Request(`http://test.local/api/admin/messages/${id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ body: "Réponse qui ne part pas" }),
    });
    const data = (await (await router.handle(req, failing))!.json()) as { delivery: string };
    expect(data.delivery).toBe("failed");
    expect(((await call("GET", "/api/admin/messages?status=nouveau")).data.messages as unknown[])).toHaveLength(1);
    const log = await t.db.prepare("SELECT status, error_detail FROM email_log").first<{ status: string; error_detail: string }>();
    expect(log).toMatchObject({ status: "failed" });
    expect(log?.error_detail).toContain("421");
  });

  it("jamais de réponse à l'adresse des gîtes ni à un expéditeur qui s'en réclame sans preuve", async () => {
    const own = (await inbound({ messageId: "<own@x>", fromEmail: "lesgitesdupremore@gmail.com" }))!;
    const r1 = await call("POST", `/api/admin/messages/${own}/reply`, { body: "test" });
    expect(r1.status).toBe(400);
    const spoof = (await inbound({ messageId: "<spoof@x>", fromEmail: "client@example.com", spoofed: true }))!;
    expect((await call("POST", `/api/admin/messages/${spoof}/reply`, { body: "test" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("envoi réel non actif : stub journalisé, le message sortant apparaît quand même dans le fil", async () => {
    const id = (await inbound())!;
    const stubEnv = { ...env, EMAILS_ENABLED: "false" } as Env;
    const req = new Request(`http://test.local/api/admin/messages/${id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ body: "Réponse en stub" }),
    });
    const res = await router.handle(req, stubEnv);
    expect(((await res!.json()) as { delivery: string }).delivery).toBe("stub");
    expect(sent).toHaveLength(0);
    const thread = await call("GET", `/api/admin/messages/${id}/thread`);
    expect((thread.data.thread as unknown[]).length).toBe(2);
  });

  it("les pièces jointes listées et l'alerte d'usurpation sortent par l'API", async () => {
    const id = (await inbound({ attachments: [{ name: "plan.pdf", size: 2048 }], spoofed: false }))!;
    const list = (await call("GET", "/api/admin/messages")).data.messages as { id: number; attachments: unknown[]; spoofed: boolean }[];
    expect(list.find((m) => m.id === id)).toMatchObject({ attachments: [{ name: "plan.pdf", size: 2048 }], spoofed: false });
  });

  it("GET /api/admin/mailbox et POST /api/admin/mailbox/poll", async () => {
    const status = await call("GET", "/api/admin/mailbox");
    // IMAP_USER + SMTP_PASSWORD suffisent, mais cette instance n'a pas de socket IMAP
    expect(status.data).toMatchObject({ configured: true, supported: false });
    expect(String(status.data.note)).toMatch(/socket/);
    const withBox: Env = { ...env, IMAP_PASSWORD: "x", IMAP_FETCH: async () => ({ uidValidity: 1, mails: [], more: false, highestUid: null }) };
    const req = new Request("http://test.local/api/admin/mailbox/poll", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    const res = await router.handle(req, withBox);
    expect(((await res!.json()) as { ok: boolean }).ok).toBe(true);
  });
});
