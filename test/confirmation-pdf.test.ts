// Mail de confirmation + PDF « Confirmation de réservation et conditions
// générales » (11/10/2026, renommé le 12/10/2026) : contenu FR/NL,
// pièce jointe, journal, envoi unique, routes protégées, transports SMTP et
// Resend. Aucune donnée réelle : tout est fictif (example.*). Aucun réseau.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createTestDb, type TestDb } from "./helpers/d1";
import { pdfPageCount, pdfPagesText, pdfStructureProblems, pdfText, pdfAsString } from "./helpers/pdf-lire";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { sendConfirmation } from "../src/services/booking-flow";
import { buildConfirmationEmail } from "../src/services/confirmation";
import { acceptedVersionLabel, buildConfirmationPdf, cgvArticle, cgvVersionLabel, confirmationFileName, loadConfirmationPdfContext } from "../src/services/confirmation-pdf";
import { queueEmail } from "../src/services/email";
import { buildMessage } from "../node/smtp.mjs";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const CHECKIN = addDays(todayInZone(), 140);
const CHECKOUT = addDays(CHECKIN, 7);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["confirmation_claims", "payments", "email_log", "audit_log", "bookings", "guests"]) await t.db.prepare(`DELETE FROM ${table}`).run();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const auth = path.startsWith("/api/admin") && !("authorization" in headers) ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...auth, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return res;
}
const callJson = async (...a: Parameters<typeof call>) => {
  const res = await call(...a);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

/** Réservation en ligne payée (simulateur), langue au choix. */
async function bookAndPay(opts: { nl?: boolean; lastName?: string; email?: string; unitId?: number } = {}) {
  const email = opts.email ?? (opts.nl ? "pieter@example.be" : "claire@example.be");
  const created = await callJson("POST", "/api/public/bookings", {
    unitId: opts.unitId ?? 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 1, paymentMode: "deposit",
    guest: { firstName: opts.nl ? "Pieter" : "Claire", lastName: opts.lastName ?? (opts.nl ? "Janssens" : "Dubois"), email, phone: "+32 470 00 00 09" },
    cgvAccepted: true, ...(opts.nl ? { lang: "nl" } : {}),
  }, opts.nl ? { "x-gites-lang": "nl" } : {});
  expect(created.status).toBe(201);
  const session = new URL(created.data.checkoutUrl as string).searchParams.get("session")!;
  expect((await callJson("POST", "/api/public/dev-pay/confirm", { session })).status).toBe(200);
  const row = await t.db.prepare("SELECT id, reference FROM bookings WHERE reference = ?1").bind(created.data.reference).first<{ id: number; reference: string }>();
  return { id: row!.id, reference: row!.reference, email };
}

const mails = async (bookingId: number) =>
  (await t.db.prepare("SELECT * FROM email_log WHERE booking_id = ?1 ORDER BY id").bind(bookingId).all<Record<string, any>>()).results;

describe("à la confirmation par paiement", () => {
  it("un seul mail de confirmation part, avec le PDF de confirmation en pièce jointe (journal)", async () => {
    const b = await bookAndPay();
    const log = await mails(b.id);
    const conf = log.filter((m) => m.kind === "confirmation");
    expect(conf).toHaveLength(1);
    expect(log.filter((m) => m.kind === "voucher")).toHaveLength(0); // remplacé, pas doublé
    expect(conf[0]!.subject).toBe(`[${b.reference}] Votre réservation est confirmée — ${(await t.db.prepare("SELECT name FROM properties WHERE id = 1").first<{ name: string }>())!.name}`);
    const att = JSON.parse(conf[0]!.attachments) as { filename: string; bytes: number }[];
    expect(att).toEqual([{ filename: `Confirmation-${b.reference}.pdf`, bytes: expect.any(Number) }]);
    expect(att[0]!.bytes).toBeGreaterThan(3000);
    expect(conf[0]!.status).toBe("stub"); // EMAILS_ENABLED=false : rien n'est parti
    expect(conf[0]!.body_text).toContain(b.reference);
  });

  it("l'envoi automatique ne se répète pas ; « renvoyer » (force) repart", async () => {
    const b = await bookAndPay();
    expect(await sendConfirmation(t.db, env, b.id)).toBe(false);
    expect(await sendConfirmation(t.db, env, b.id)).toBe(false);
    expect((await mails(b.id)).filter((m) => m.kind === "confirmation")).toHaveLength(1);
    expect(await sendConfirmation(t.db, env, b.id, { force: true })).toBe(true);
    expect((await mails(b.id)).filter((m) => m.kind === "confirmation")).toHaveLength(2);
  });

  it("appels simultanés : un seul mail part (verrou posé avant l'envoi)", async () => {
    const b = await bookAndPay();
    await t.db.prepare("DELETE FROM email_log").run();
    await t.db.prepare("DELETE FROM confirmation_claims").run();
    const results = await Promise.all(Array.from({ length: 6 }, () => sendConfirmation(t.db, env, b.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await mails(b.id)).filter((m) => m.kind === "confirmation")).toHaveLength(1);
  });

  it("un envoi échoué rend le verrou : le suivant peut repartir ; sans e-mail ou réservation inconnue, rien ne part", async () => {
    const b = await bookAndPay();
    await t.db.prepare("DELETE FROM email_log").run();
    await t.db.prepare("DELETE FROM confirmation_claims").run();
    const failing: Env = { ...env, EMAILS_ENABLED: "true", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "r@example.be", SMTP_SEND: async () => { throw new Error("SMTP 451 indisponible"); } };
    expect(await sendConfirmation(t.db, failing, b.id)).toBe(true);
    expect((await mails(b.id))[0]).toMatchObject({ kind: "confirmation", status: "failed", error_detail: "SMTP 451 indisponible" });
    expect(await sendConfirmation(t.db, env, b.id)).toBe(true); // retenté, et cette fois journalisé
    expect(await sendConfirmation(t.db, env, b.id)).toBe(false); // puis plus jamais en automatique
    await t.db.prepare("UPDATE guests SET email = NULL").run();
    expect(await sendConfirmation(t.db, env, b.id, { force: true })).toBe(false);
    expect(await sendConfirmation(t.db, env, 999999, { force: true })).toBe(false);
  });

  it("une réservation d'avant (mail « voucher » déjà journalisé) ne reçoit pas de second mail automatique", async () => {
    const b = await bookAndPay();
    await t.db.prepare("UPDATE email_log SET kind = 'voucher' WHERE booking_id = ?1 AND kind = 'confirmation'").bind(b.id).run();
    expect(await sendConfirmation(t.db, env, b.id)).toBe(false);
  });
});

describe("vente du back-office : une option, puis le client confirme en payant", () => {
  const sale = (extra: Record<string, unknown> = {}, email = "mertens@example.com", guest: Record<string, unknown> = {}) =>
    callJson("POST", "/api/admin/bookings", { unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, guest: { lastName: "Mertens", email, ...guest }, ...extra });

  it("la vente crée une option (confirmNow est ignoré) et envoie le lien vers la réservation, pas la confirmation", async () => {
    const res = await sale({ confirmNow: true });
    expect(res.status).toBe(201);
    const booking = res.data.booking as { id: number; status: string; reference: string };
    expect(booking.status).toBe("pending");
    expect(res.data.optionMailQueued).toBe(true);
    expect(res.data.optionUrl).toMatch(/\/book\/voucher\.html\?ref=.*&email=mertens%40example\.com/);
    const log = await mails(booking.id);
    expect(log.map((m) => m.kind)).toEqual(["payment_link"]);
    expect(log[0]!.body_text).toContain(res.data.optionUrl as string);
    expect(log[0]!.body_text).toContain("acceptez les conditions générales");
    expect(log[0]!.body_text).toMatch(/Vos dates sont gardées jusqu'au \d\d\/\d\d\/\d{4}/);
  });

  it("client néerlandophone : le lien part en néerlandais", async () => {
    const res = await sale({}, "pieter@example.be", { lang: "nl" });
    const log = await mails((res.data.booking as { id: number }).id);
    expect(log[0]!.subject).toMatch(/Voorschot/);
    expect(log[0]!.body_text).toContain("aanvaardt er de algemene voorwaarden");
    expect(log[0]!.body_text).toMatch(/&lang=nl/);
  });

  it("sans e-mail : pas de mail, mais le lien reste dans la réponse", async () => {
    const res = await sale({}, "");
    expect(res.data.optionMailQueued).toBe(false);
    expect(res.data.optionUrl).toContain("/book/voucher.html?ref=");
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>())!.n).toBe(0);
  });

  it("le client ouvre le lien, accepte les CGV, paie les arrhes : confirmation + PDF, avec l'acceptation du client", async () => {
    const res = await sale();
    const b = res.data.booking as { id: number; reference: string };
    const view = async () => (await callJson("GET", `/api/public/bookings/${b.reference}?email=mertens%40example.com`)).data;
    expect((await view()).cgvAccepted).toBe(false);
    const pay = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      callJson("POST", `/api/public/bookings/${b.reference}/pay`, { email: "mertens@example.com", ...body }, headers);
    // sans acceptation : refus, rien d'enregistré
    const refused = await pay({});
    expect(refused.status).toBe(400);
    expect(refused.data.code).toBe("cgv_required");
    expect((await pay({ cgvAccepted: "oui" })).status).toBe(400);
    expect((await view()).cgvAccepted).toBe(false);
    // avec acceptation : version, heure, IP enregistrées et paiement lancé
    const ok = await pay({ cgvAccepted: true }, { "cf-connecting-ip": "203.0.113.7" });
    expect(ok.status).toBe(200);
    expect((await view()).cgvAccepted).toBe(true);
    const row = await t.db.prepare("SELECT cgv_version, cgv_accepted_at, cgv_ip FROM bookings WHERE id = ?1").bind(b.id).first<Record<string, string>>();
    expect(row!.cgv_version).toMatch(/^v3\.1\+sha256:[0-9a-f]{16}-len\d+$/);
    expect(acceptedVersionLabel(row!.cgv_version)).toBe("3.1");
    expect(row!.cgv_accepted_at).toMatch(/^\d{4}-/);
    expect(row!.cgv_ip).toBe("203.0.113.7");
    // un second paiement n'a plus besoin de l'acceptation
    expect((await pay({})).status).toBe(200);
    // paiement des arrhes → confirmation envoyée une fois, avec son PDF
    const session = new URL(ok.data.checkoutUrl as string).searchParams.get("session")!;
    expect((await callJson("POST", "/api/public/dev-pay/confirm", { session })).status).toBe(200);
    const conf = (await mails(b.id)).filter((m) => m.kind === "confirmation");
    expect(conf).toHaveLength(1);
    expect(JSON.parse(conf[0]!.attachments)[0].filename).toBe(`Confirmation-${b.reference}.pdf`);
    const text = pdfText(buildConfirmationPdf((await loadConfirmationPdfContext(t.db, b.id))!));
    expect(text.replace(/\s+/g, " ")).toMatch(/Réservation conclue par l'acceptation des conditions générales v3\.1 le \d\d\/\d\d\/\d{4} à \d\d:\d\d depuis l'adresse IP 203\.0\.113\.7 et le paiement des arrhes\./);
  });

  it("une réservation en ligne (tunnel) n'est pas redemandée : le paiement part sans case à cocher", async () => {
    const b = await bookAndPay(); // le tunnel a déjà enregistré l'acceptation
    expect((await callJson("GET", `/api/public/bookings/${b.reference}?email=${encodeURIComponent(b.email)}`)).data.cgvAccepted).toBe(true);
  });

  it("« renvoyer la confirmation » : nouvelle route et ancien nom, journalisés", async () => {
    const b = await bookAndPay();
    expect((await call("POST", `/api/admin/bookings/${b.id}/resend-confirmation`)).status).toBe(200);
    expect((await call("POST", `/api/admin/bookings/${b.id}/resend-voucher`)).status).toBe(200);
    expect((await mails(b.id)).filter((m) => m.kind === "confirmation")).toHaveLength(3);
    const fiche = await callJson("GET", `/api/admin/bookings/${b.id}`);
    const emails = fiche.data.emails as { kind: string; attachments: { filename: string }[] }[];
    expect(emails.filter((e) => e.kind === "confirmation").every((e) => e.attachments[0]!.filename.startsWith("Confirmation-"))).toBe(true);
  });
});

describe("le mail", () => {
  it("français : objet, HTML et texte portent les mêmes faits", async () => {
    const b = await bookAndPay();
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const mail = buildConfirmationEmail({ booking: ctx.booking, property: ctx.property, settings: ctx.settings, voucherUrl: `http://test.local/book/voucher.html?ref=${b.reference}`, attachmentName: confirmationFileName(b.reference) });
    expect(mail.subject).toMatch(/^\[[A-Z]{2}-\d{4}-\d+\] Votre réservation est confirmée/);
    for (const body of [mail.bodyText, mail.bodyHtml]) {
      expect(body).toContain(b.reference);
      expect(body).toContain("Confirmation-" + b.reference + ".pdf");
      expect(body).toContain("Déjà payé");
      expect(body).toContain("Solde restant");
      expect(body).not.toMatch(/contrat|locataire|propriétaire/i);
      expect(body).toContain("acceptation des conditions générales et le paiement des arrhes");
    }
    // les coordonnées « TODO_… » de la graine ne sortent jamais, et la commune n'est pas répétée
    expect(mail.bodyHtml + mail.bodyText).not.toContain("TODO_");
    expect(mail.bodyText).not.toMatch(/Daverdisse\), Daverdisse/);
    expect(mail.bodyHtml).toContain("<table");
    expect(mail.bodyHtml).toContain('href="http://test.local/book/voucher.html?ref=');
    expect(mail.bodyHtml).toContain("Voir ma réservation");
    expect(mail.bodyText).toContain("CE QUE VOUS DEVEZ SAVOIR");
    expect(mail.bodyText).toMatch(/Arrivée le \d\d\/\d\d\/\d{4}, à partir de 18:00|à partir de \d\d:\d\d/);
  });

  it("néerlandais : tout le mail est en néerlandais, avec la mention sur les CGV", async () => {
    const b = await bookAndPay({ nl: true });
    const conf = (await mails(b.id)).find((m) => m.kind === "confirmation")!;
    expect(conf.subject).toMatch(/^\[[A-Z]{2}-\d{4}-\d+\] Uw reservering is bevestigd/);
    expect(conf.body_text).toContain("Uw reservering is bevestigd");
    expect(conf.body_text).toContain("GOED OM TE WETEN");
    expect(conf.body_text).toContain("De Franse versie is rechtsgeldend");
    expect(conf.body_text).toMatch(/voucher\.html\?ref=.*&lang=nl/);
    expect(conf.body_text).not.toMatch(/Bonjour|Déjà payé/);
    expect(conf.body_text).not.toMatch(/contract|huurder|eigenaar/i);
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const mail = buildConfirmationEmail({ booking: ctx.booking, property: ctx.property, settings: ctx.settings, voucherUrl: "http://test.local/x", attachmentName: "Confirmation-X.pdf" });
    expect(mail.bodyHtml).toContain('<html lang="nl">');
    expect(mail.bodyHtml).toContain("Mijn reservering bekijken");
    expect(mail.bodyHtml).toContain("Resterend saldo");
  });

  it("les données du client sont échappées dans le HTML, et aucun saut de ligne n'entre dans l'objet", async () => {
    const b = await bookAndPay({ lastName: `Dupont <img src=x onerror=alert(1)> & "Fils"` });
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    await t.db.prepare("UPDATE units SET name = ?1 WHERE id = 2").bind("Gîte <b>\r\nBcc: x@example.com").run();
    const ctx2 = (await loadConfirmationPdfContext(t.db, b.id))!;
    const mail = buildConfirmationEmail({ booking: { ...ctx2.booking, guestName: `Claire\r\nBcc: pirate@example.com <script>` }, property: { ...ctx.property, name: "Les Gîtes\r\nBcc: z@example.com" }, settings: ctx.settings, voucherUrl: 'http://test.local/x?a="b"&c=<d>', attachmentName: "Confirmation-X.pdf" });
    expect(mail.bodyHtml).not.toMatch(/<script|<img |onerror=alert/);
    expect(mail.bodyHtml).toContain("&lt;b&gt;");
    expect(mail.bodyHtml).toContain("&lt;script&gt;");
    expect(mail.bodyHtml).toContain('href="http://test.local/x?a=&quot;b&quot;&amp;c=&lt;d&gt;"');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.bodyText).not.toMatch(/^Bcc:/m);
    expect(mail.bodyHtml).not.toMatch(/^Bcc:/m);
    // et dans le PDF, le nom est bien celui saisi, sans casser le fichier
    const pdf = buildConfirmationPdf({ ...ctx, booking: { ...ctx.booking, guestName: `Dupont <img src=x> & "Fils" (x) \\ y` } });
    expect(pdfStructureProblems(pdf)).toEqual([]);
    expect(pdfText(pdf)).toContain(`Dupont <img src=x> & "Fils" (x) \\ y`);
  });
});

describe("le PDF « Confirmation de réservation et conditions générales »", () => {
  it("français : PDF valide, récapitulatif, conclusion de la réservation, CGV v3.1 en annexe, aucun « contrat »", async () => {
    const b = await bookAndPay();
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const pdf = buildConfirmationPdf({ ...ctx, issuedAt: new Date("2026-10-11T10:00:00Z") });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdfStructureProblems(pdf)).toEqual([]);
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(3); // récapitulatif + annexe
    const text = pdfText(pdf);
    expect(text).not.toContain("TODO_");
    const recap = text.split("ANNEXE —")[0]!;
    // ni signature, ni lieu de signature, ni « contrat », « bail », « locataire », « propriétaire »
    expect(recap).not.toMatch(/Fait à|Signatures|signé|accord écrit|sous-traitant|valent signature/);
    expect(text).not.toMatch(/contrat|bail\b|locataire|propriétaire/i);
    for (const needle of [
      "CONFIRMATION DE RÉSERVATION", b.reference, "Claire Dubois", "claire@example.be", "1. Exploitant et client", "L'exploitant", "Le client",
      "3. Le séjour", "4. Le prix", "Prix total du séjour", "5. Paiement", "Arrhes payées à la réservation", "à payer au plus tard le",
      "Annulation : article 5 des conditions générales", "6. Conclusion de la réservation",
      "ANNEXE — CONDITIONS GÉNÉRALES DE LOCATION", "Comment ça se passe", "Article 5 — Caution et annulation", "Article 13 — Droit applicable et litiges",
    ]) expect(text, needle).toContain(needle);
    expect(text.replace(/\s+/g, " ")).toMatch(/Réservation conclue par l'acceptation des conditions générales v3\.1 le \d\d\/\d\d\/\d{4} à \d\d:\d\d .*et le paiement des arrhes\./);
    // les articles 4 et 5 ne sont plus recopiés en page 1 : ils sont en annexe
    const cgv = ctx.settings.cgvText;
    expect(recap).not.toContain("Article 5 —");
    expect(text.replace(/\s+/g, " ")).toContain(cgvArticle(cgv, 5)!.split("\n").slice(2, 3)[0]!.replace(/\s+/g, " ").slice(0, 60));
    expect(cgvVersionLabel(cgv)).toBe("3.1");
    // le total est celui de la réservation
    const total = ctx.booking.totalCents;
    const eur = `${Math.floor(total / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${String(total % 100).padStart(2, "0")} €`;
    expect(text).toContain(eur);
    // pagination : chaque page a son pied
    pdfPagesText(pdf).forEach((p, i, all) => expect(p).toContain(`Page ${i + 1} / ${all.length}`));
    expect(pdfPagesText(pdf)[0]).toContain("Confirmation de réservation " + b.reference);
  });

  it("néerlandais : libellés en néerlandais, CGV françaises en annexe avec la mention", async () => {
    const b = await bookAndPay({ nl: true });
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const pdf = buildConfirmationPdf(ctx);
    expect(pdfStructureProblems(pdf)).toEqual([]);
    const text = pdfText(pdf);
    for (const needle of ["BEVESTIGING VAN RESERVERING", "1. Uitbater en klant", "3. Het verblijf", "Totale prijs van het verblijf", "voorschot", "Reservering tot stand gekomen door de aanvaarding van de algemene voorwaarden v3.1", "BIJLAGE", "De Franse versie is rechtsgeldend", "Article 4 — Arrhes"]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toMatch(/CONTRAT|contract|huurder|verhuurder|eigenaar/i);
    expect(text).not.toMatch(/Opgemaakt te|Handtekeningen|ondertekend door|onderhandse/);
  });

  it("sans acceptation enregistrée (réservation d'avant), le PDF n'invente ni date ni IP ; la caution n'apparaît que si elle est demandée", async () => {
    const res = await callJson("POST", "/api/admin/bookings", { unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, guest: { lastName: "Mertens", email: "mertens@example.com" } });
    const id = (res.data.booking as { id: number }).id;
    let ctx = (await loadConfirmationPdfContext(t.db, id))!;
    expect(ctx.acceptance.acceptedAt).toBeNull();
    let text = pdfText(buildConfirmationPdf(ctx));
    expect(text).not.toMatch(/ depuis l'adresse IP|v3\.1 le \d/);
    expect(text).toContain("Réservation conclue par l'acceptation des conditions générales v3.1 et le paiement des arrhes.");
    expect(text.split("ANNEXE —")[0]).not.toMatch(/signé|accord écrit|Fait à/);
    expect(text).not.toContain("Une caution de");
    ctx = { ...ctx, settings: { ...ctx.settings, cautionCents: 30000 } };
    text = pdfText(buildConfirmationPdf(ctx));
    expect(text).toMatch(/Une caution de 300,00 € est demandée/);
  });

  it("prix payé d'avance : le PDF garde la part d'arrhes du devis (CGV 4.3)", async () => {
    const b = await bookAndPay();
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const total = ctx.booking.totalCents;
    const text = pdfText(buildConfirmationPdf({ ...ctx, booking: { ...ctx.booking, balanceDueDate: null, depositCents: total } })).replace(/\s+/g, " ");
    expect(text).toContain("La totalité du prix");
    expect(text).toMatch(/Dont arrhes : [\d ]+,\d\d € \(50 % du prix total\), au sens des articles 4 et 5 des conditions générales\./);
  });

  it("sans CGV en base, le PDF part quand même et le signale", async () => {
    const b = await bookAndPay();
    const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
    const pdf = buildConfirmationPdf({ ...ctx, settings: { ...ctx.settings, cgvText: "" } });
    expect(pdfStructureProblems(pdf)).toEqual([]);
    expect(pdfText(pdf)).toContain("(CGV à compléter)");
  });

  it("exemple écrit sur disque quand SAMPLE_PDF_DIR est posé", async () => {
    const dir = process.env.SAMPLE_PDF_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const nl of [false, true]) {
      const b = await bookAndPay({ nl, unitId: nl ? 1 : 2, email: nl ? "nl2@example.be" : "fr2@example.be" });
      const pdf = buildConfirmationPdf((await loadConfirmationPdfContext(t.db, b.id))!);
      writeFileSync(`${dir}/Confirmation-exemple-${nl ? "NL" : "FR"}.pdf`, pdf);
      const ctx = (await loadConfirmationPdfContext(t.db, b.id))!;
      const mail = buildConfirmationEmail({ booking: ctx.booking, property: ctx.property, settings: ctx.settings, voucherUrl: "http://test.local/book/voucher.html?ref=X", attachmentName: confirmationFileName(b.reference) });
      writeFileSync(`${dir}/Mail-exemple-${nl ? "NL" : "FR"}.html`, mail.bodyHtml);
      writeFileSync(`${dir}/Mail-exemple-${nl ? "NL" : "FR"}.txt`, mail.bodyText);
    }
  });
});

describe("routes du PDF de confirmation (et l'alias contrat.pdf)", () => {
  for (const file of ["confirmation.pdf", "contrat.pdf"]) {
    it(`admin ${file} : protégée, PDF pour une réservation connue, 404 sinon`, async () => {
      const b = await bookAndPay();
      expect((await call("GET", `/api/admin/bookings/${b.id}/${file}`, undefined, { authorization: "Bearer faux" })).status).toBe(401);
      const noAuthReq = new Request(`http://test.local/api/admin/bookings/${b.id}/${file}`);
      expect((await router.handle(noAuthReq, env))!.status).toBe(401);
      const ok = await call("GET", `/api/admin/bookings/${b.id}/${file}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("application/pdf");
      expect(ok.headers.get("content-disposition")).toContain(`Confirmation-${b.reference}.pdf`);
      expect(ok.headers.get("cache-control")).toContain("no-store");
      const bytes = new Uint8Array(await ok.arrayBuffer());
      expect(pdfAsString(bytes.slice(0, 5))).toBe("%PDF-");
      expect(pdfStructureProblems(bytes)).toEqual([]);
      expect((await call("GET", `/api/admin/bookings/999999/${file}`)).status).toBe(404);
    });

    it(`client ${file} : référence + e-mail exigés, réservation confirmée seulement`, async () => {
      const b = await bookAndPay();
      const url = (email: string) => `/api/public/bookings/${b.reference}/${file}?email=${encodeURIComponent(email)}`;
      expect((await call("GET", url("autre@example.be"))).status).toBe(404);
      expect((await call("GET", `/api/public/bookings/${b.reference}/${file}`)).status).toBe(404);
      expect((await call("GET", `/api/public/bookings/INCONNUE-1/${file}?email=${b.email}`)).status).toBe(404);
      const ok = await call("GET", url(b.email.toUpperCase()));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("application/pdf");
      expect(ok.headers.get("content-disposition")).toContain(`Confirmation-${b.reference}.pdf`);
      expect(pdfStructureProblems(new Uint8Array(await ok.arrayBuffer()))).toEqual([]);
      // option non confirmée : pas de PDF
      await t.db.prepare("UPDATE bookings SET status = 'pending' WHERE id = ?1").bind(b.id).run();
      expect((await call("GET", url(b.email))).status).toBe(404);
    });
  }
});

describe("transports", () => {
  const attachment = { filename: "Confirmation-X.pdf", contentType: "application/pdf", content: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) };

  it("SMTP : html et pièces jointes sont transmis au transport, et le journal garde nom + taille", async () => {
    const send = vi.fn(async () => ({ id: "<id@x>" }));
    const smtpEnv: Env = { ...env, EMAILS_ENABLED: "true", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "r@example.be", SMTP_SEND: send };
    const status = await queueEmail(t.db, smtpEnv, { to: "c@example.com", subject: "S", bodyText: "T", bodyHtml: "<p>H</p>", attachments: [attachment], kind: "confirmation" });
    expect(status).toBe("sent");
    expect(send).toHaveBeenCalledWith({ to: "c@example.com", subject: "S", text: "T", html: "<p>H</p>", attachments: [attachment] });
    const row = await t.db.prepare("SELECT attachments, body_text FROM email_log ORDER BY id DESC LIMIT 1").first<{ attachments: string; body_text: string }>();
    expect(JSON.parse(row!.attachments)).toEqual([{ filename: "Confirmation-X.pdf", bytes: 8 }]);
    expect(row!.body_text).toBe("T");
  });

  it("Resend : html et pièce jointe en base64 dans la requête", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const resendEnv: Env = { ...env, EMAILS_ENABLED: "true", RESEND_API_KEY: "k" };
      await queueEmail(t.db, resendEnv, { to: "c@example.com", subject: "S", bodyText: "T", bodyHtml: "<p>H</p>", attachments: [attachment], kind: "confirmation" });
      const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(sent.html).toBe("<p>H</p>");
      expect(sent.attachments).toEqual([{ filename: "Confirmation-X.pdf", content: btoa("%PDF-1.4") }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("message MIME : multipart/mixed + alternative, pièce jointe base64 et nom assaini", () => {
    const pdf = new Uint8Array(500).map((_, i) => 32 + (i % 90));
    const raw = buildMessage({
      from: "Gîtes <r@example.be>", to: "c@example.com", subject: "Confirmation", text: "Bonjour é\n.point", html: "<p>é</p>",
      attachments: [{ filename: 'Confirmation\r\nBcc: x@example.com "../a.pdf', contentType: "application/pdf", content: pdf }],
      messageId: "<1@example.be>", date: new Date("2026-10-11T10:00:00Z"),
    });
    const [head, ...rest] = raw.split("\r\n\r\n");
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="=_mix_[0-9a-f]+"/);
    expect(head).not.toMatch(/^Bcc:/m);
    const body = rest.join("\r\n\r\n");
    expect(body).toContain("Content-Type: multipart/alternative");
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toContain("Content-Type: text/html; charset=UTF-8");
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toMatch(/Content-Disposition: attachment; filename="[A-Za-z0-9._-]+"/);
    expect(body).not.toMatch(/^Bcc:/m);
    expect(body).toContain("..point"); // dot-stuffing
    const b64 = body.split('Content-Disposition: attachment; filename="')[1]!.split("\r\n\r\n")[1]!.split("\r\n--=_mix_")[0]!;
    expect(b64.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(b64.replace(/\r\n/g, ""), "base64").equals(Buffer.from(pdf))).toBe(true);
    const mixedBoundary = /boundary="(=_mix_[0-9a-f]+)"/.exec(head!)![1]!;
    expect(body.trimEnd().endsWith(`--${mixedBoundary}--`)).toBe(true);
  });

  it("message sans html ni pièce jointe : inchangé (texte seul)", () => {
    const raw = buildMessage({ from: "r@example.be", to: "c@example.com", subject: "S", text: "Bonjour", messageId: "<1@x>" });
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).not.toContain("multipart");
  });
});
