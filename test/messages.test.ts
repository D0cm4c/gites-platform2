// Les échanges clients vivent dans la plateforme — sans email nécessaire :
// formulaire public → boîte Messages → réponse de l'équipe → visible sur le
// voucher du client. L'email n'est qu'une notification optionnelle (stub ici).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;

const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Marie", lastName: "Lambert", email: "marie@example.com" };
const ADMIN = "test-admin-token";

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["messages", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : auth,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function createBookingViaAdmin() {
  const sale = await call("POST", "/api/admin/bookings", {
    unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, guest: GUEST,
  });
  return sale.data.booking as { id: number; reference: string };
}

describe("formulaire public de contact (avant réservation)", () => {
  it("crée un message 'form' visible dans la boîte admin, lié au client connu", async () => {
    await createBookingViaAdmin(); // crée le client marie@example.com
    const res = await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Marie Lambert", email: "marie@example.com",
      message: "Le sauna est-il accessible en hiver ?", website: "",
    });
    expect(res.status).toBe(201);
    const inbox = await call("GET", "/api/admin/messages?property=1");
    const messages = inbox.data.messages as { channel: string; guestId: number | null; status: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe("form");
    expect(messages[0]!.guestId).not.toBeNull();
    expect(messages[0]!.status).toBe("nouveau");
  });

  it("pot de miel et validations", async () => {
    // bot : champ caché rempli → accepté en façade, rien stocké
    const bot = await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Bot", email: "bot@spam.com", message: "spam spam spam", website: "http://spam",
    });
    expect(bot.status).toBe(200);
    expect(((await call("GET", "/api/admin/messages")).data.messages as unknown[])).toHaveLength(0);
    // validations
    expect((await call("POST", "/api/public/contact", { property: "pre-more", name: "X", email: "pas-un-email", message: "hello world" })).status).toBe(400);
    expect((await call("POST", "/api/public/contact", { property: "inconnu", name: "Marie", email: "m@x.be", message: "hello world" })).status).toBe(404);
  });
});

describe("fil de conversation du voucher (sans email)", () => {
  it("client écrit depuis son voucher → équipe répond → réponse visible côté client", async () => {
    const booking = await createBookingViaAdmin();
    const threadPath = `/api/public/bookings/${booking.reference}/messages`;

    // auth : référence + email exacts requis
    expect((await call("GET", `${threadPath}?email=autre@example.com`)).status).toBe(404);

    // 1. le client écrit depuis son voucher
    const sent = await call("POST", threadPath, { email: GUEST.email, message: "Peut-on arriver vers 20h ?" });
    expect(sent.status).toBe(201);

    // 2. l'équipe voit le message et répond DEPUIS LA PLATEFORME
    const inbox = await call("GET", "/api/admin/messages?property=1");
    const msg = (inbox.data.messages as { id: number; bookingReference: string }[])[0]!;
    expect(msg.bookingReference).toBe(booking.reference);
    const reply = await call("POST", `/api/admin/messages/${msg.id}/reply`, { body: "Oui bien sûr, à 20h — bonne route !" });
    expect(reply.status).toBe(200);
    expect(reply.data.delivery).toBe("stub"); // email non activé → notification en stub

    // 3. le client voit la réponse sur son voucher (aucun email nécessaire)
    const thread = await call("GET", `${threadPath}?email=${encodeURIComponent(GUEST.email)}`);
    const messages = thread.data.messages as { direction: string; body: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[1]!.direction).toBe("out");
    expect(messages[1]!.body).toContain("bonne route");

    // 4. le message d'origine est passé « traité », la notification est journalisée
    const after = await call("GET", "/api/admin/messages?property=1&status=nouveau");
    expect(after.data.messages as unknown[]).toHaveLength(0);
    const log = await call("GET", "/api/admin/email-log");
    expect((log.data.emails as { kind: string; status: string }[])[0]).toMatchObject({ kind: "reply", status: "stub" });
  });

  it("message proactif de l'équipe depuis la fiche résa", async () => {
    const booking = await createBookingViaAdmin();
    const res = await call("POST", `/api/admin/bookings/${booking.id}/messages`, { body: "Petit rappel : arrivée dès 16h samedi !" });
    expect(res.status).toBe(200);
    const thread = await call("GET", `/api/public/bookings/${booking.reference}/messages?email=${encodeURIComponent(GUEST.email)}`);
    const messages = thread.data.messages as { direction: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe("out");
  });

  it("le fil du voucher regroupe messages de résa ET du même client (contact form)", async () => {
    const booking = await createBookingViaAdmin();
    await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Marie Lambert", email: GUEST.email, message: "Question générale avant séjour",
    });
    const thread = await call("GET", `/api/public/bookings/${booking.reference}/messages?email=${encodeURIComponent(GUEST.email)}`);
    expect((thread.data.messages as unknown[]).length).toBe(1); // le message contact est lié au guest → visible
  });
});

describe("accusé de réception (passe « client » du 12/10/2026)", () => {
  const mails = async () =>
    (await t.db.prepare("SELECT to_email, subject, body_text, kind, booking_id FROM email_log WHERE kind = 'contact_ack' ORDER BY id").all<{ to_email: string; subject: string; body_text: string; kind: string; booking_id: number | null }>()).results;

  it("question avant réservation : référence QU-… dans l'objet, mail journalisé, message repris", async () => {
    const res = await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Léa Martin", email: "lea@example.com",
      message: "Le sauna est-il chauffé ?\n<script>alert(1)</script>",
    });
    expect(res.status).toBe(201);
    const ref = res.data.reference as string;
    expect(ref).toMatch(/^QU-\d{4}-\d{4}$/);
    expect(res.data.ackSent).toBe(true);
    const [m] = await mails();
    expect(m!.to_email).toBe("lea@example.com");
    expect(m!.subject).toBe(`[${ref}] Nous avons bien reçu votre message — Les Gîtes du Pré Moré`);
    expect(m!.subject).not.toContain("Léa");
    expect(m!.body_text).toContain(ref);
    expect(m!.body_text).toContain("> Le sauna est-il chauffé ?");
    // le message stocké porte la référence dans son objet : la réponse y sera rattachée
    const stored = await t.db.prepare("SELECT subject FROM messages").first<{ subject: string }>();
    expect(stored!.subject.startsWith(`[${ref}]`)).toBe(true);
  });

  it("depuis le voucher : la référence de la réservation, et le lien au dossier", async () => {
    const booking = await createBookingViaAdmin();
    const sent = await call("POST", `/api/public/bookings/${booking.reference}/messages`, { email: GUEST.email, message: "Peut-on arriver vers 20h ?" });
    expect(sent.status).toBe(201);
    expect(sent.data.ackSent).toBe(true);
    const [m] = await mails();
    expect(m!.subject.startsWith(`[${booking.reference}] `)).toBe(true);
    expect(m!.booking_id).toBe(booking.id);
  });

  it("plus de 3 messages par heure et par adresse : le message est gardé, l'accusé ne part plus", async () => {
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      last = (await call("POST", "/api/public/contact", { property: "pre-more", name: "Lou", email: "lou@example.com", message: `question numéro ${i}` })).data;
    }
    expect(last.ackSent).toBe(false);
    expect((await mails()).length).toBe(3);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 5 });
  });
});
