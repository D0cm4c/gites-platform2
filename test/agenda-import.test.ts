// Import des agendas Google de papa : POST /api/admin/import/agenda-google.
//
// Joué DEUX fois, comme test/lot2.test.ts : D1 (Miniflare) et la base du serveur
// Node (node:sqlite), qui est la production.
//
// Ce qui compte : une réservation « Busy » de la synchro est COMPLÉTÉE, pas
// recréée ; une création porte l'UID du flux, que syncFeed reconnaît ensuite ;
// un blocage ou une annulation de l'import n'est jamais défait par la synchro ;
// un second passage ne double ni les paiements ni les notes ; `essai` n'écrit rien.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { createNodeTestDb } from "./helpers/node-db";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { syncFeed } from "../src/services/ical";
import { parseAgendaEvenement } from "../src/services/agenda-import";
import { createBookingAtomic, createFeed, getFeed, getUnit, listPayments, type FeedRow } from "../src/db/repo";

const router = new Router();
registerAdminRoutes(router);

const ADMIN = "julien:secret-de-test-agenda";
const TODAY = todayInZone();
const D = (n: number) => addDays(TODAY, n);
const ymd = (d: string) => d.replaceAll("-", "");

function ics(events: { uid: string; from: string; to: string }[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTART;VALUE=DATE:${ymd(e.from)}`, `DTEND;VALUE=DATE:${ymd(e.to)}`, "SUMMARY:Busy", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
const fetchOf = (body: string) => (async () => new Response(body)) as unknown as typeof fetch;

type Call = { status: number; data: Record<string, unknown> };

describe("lecture d'une ligne", () => {
  const ok = { uid: "abc@google.com", checkin: "2026-11-02", checkout: "2026-11-05", nom: "Jean Dupont", statut: "confirmee", paiements: [] };
  it("accepte une ligne complète et normalise l'adresse", () => {
    const r = parseAgendaEvenement({ ...ok, email: " Jean.Dupont@Example.test ", paiements: [{ cents: 137900, date: "2025-12-25", methode: "transfer" }] });
    expect(r.ok && r.ev.email).toBe("jean.dupont@example.test");
    expect(r.ok && r.ev.paiements[0]).toEqual({ cents: 137900, date: "2025-12-25", methode: "transfer" });
  });
  it("refuse dates à l'envers, statut inconnu, blocage sans motif, paiement nul, ligne sans client", () => {
    expect(parseAgendaEvenement({ ...ok, checkout: "2026-11-01" })).toMatchObject({ ok: false, raison: "dates invalides" });
    expect(parseAgendaEvenement({ ...ok, statut: "vendue" }).ok).toBe(false);
    expect(parseAgendaEvenement({ ...ok, statut: "blocage", motif: "" })).toMatchObject({ ok: false, raison: "motif de blocage requis" });
    expect(parseAgendaEvenement({ ...ok, paiements: [{ cents: 0, date: null }] }).ok).toBe(false);
    expect(parseAgendaEvenement({ ...ok, nom: null, email: null })).toMatchObject({ ok: false });
    expect(parseAgendaEvenement({ ...ok, email: "pas-une-adresse" }).ok).toBe(false);
  });
  it("refuse les montants qui ne sont pas des entiers JSON, une méthode inconnue, des paiements qui ne sont pas une liste", () => {
    expect(parseAgendaEvenement({ ...ok, paiements: [{ cents: "137900", date: null }] }).ok).toBe(false);
    expect(parseAgendaEvenement({ ...ok, paiements: [{ cents: 1379.5, date: null }] }).ok).toBe(false);
    expect(parseAgendaEvenement({ ...ok, paiements: [{ cents: 137900, date: null, methode: "bitcoin" }] })).toMatchObject({ ok: false });
    expect(parseAgendaEvenement({ ...ok, paiements: { cents: 1 } })).toMatchObject({ ok: false, raison: "paiements : liste attendue" });
    expect(parseAgendaEvenement({ ...ok, personnes: "4" }).ok).toBe(false);
    expect(parseAgendaEvenement({ ...ok, paiements: [{ cents: 137900, date: null }] }).ok).toBe(true);
  });
});

for (const [backend, create] of [
  ["Workers (D1 Miniflare)", createTestDb],
  ["Node (node:sqlite)", createNodeTestDb],
] as const) {
  describe(`import agenda Google — ${backend}`, () => {
    let t: TestDb;
    let env: Env;
    let feed1: FeedRow;
    let feed2: FeedRow;
    let capaScieur = 0;

    beforeAll(async () => {
      t = await create();
      env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
      feed1 = (await getFeed(t.db, await createFeed(t.db, { unitId: 1, name: "Agenda Google — Scieur", url: "https://example.test/1.ics" })))!;
      feed2 = (await getFeed(t.db, await createFeed(t.db, { unitId: 2, name: "Agenda Google — Scierie", url: "https://example.test/2.ics" })))!;
      capaScieur = (await getUnit(t.db, 1))!.capacityBase;
    });
    afterAll(async () => {
      await t.dispose();
    });

    async function call(path: string, body: unknown, auth: string | null = `Bearer ${ADMIN}`): Promise<Call> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (auth) headers.authorization = auth;
      const res = await router.handle(new Request(`http://test.local${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
      if (!res) throw new Error("route non matchée");
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    }
    const imp = (feed: FeedRow, evenements: unknown[], essai = false) =>
      call("/api/admin/import/agenda-google", { unitId: feed.unitId, feedId: feed.id, evenements, essai });
    type Result = { creees: number; completees: number; annulees: number; blocages: number; ignorees: number; lignes: Record<string, unknown>[] };
    const res = (c: Call) => c.data.result as Result;
    const bookingByUid = (feed: FeedRow, uid: string) =>
      t.db.prepare("SELECT * FROM bookings WHERE external_uid = ?1").bind(`feed${feed.id}:${uid}`).first<Record<string, unknown>>();
    const count = async (sql: string) => Number((await t.db.prepare(sql).first<{ n: number }>())?.n ?? 0);

    const ev = (uid: string, from: number, to: number, extra: Record<string, unknown> = {}) => ({
      uid, checkin: D(from), checkout: D(to), nom: "Jean Dupont", email: "jean.dupont@example.test",
      paiements: [{ cents: 137900, date: D(-30), methode: "transfer" }, { cents: 103900, date: null, methode: "transfer" }],
      notes: "Agenda Google : « 1379 25/12 1039 22/9 jean.dupont@… 12/9 »\nDemande du 2025-09-12",
      statut: "confirmee", ...extra,
    });

    it("refuse sans authentification, sur un flux d'un autre bien, sans liste", async () => {
      expect((await call("/api/admin/import/agenda-google", { unitId: 1, feedId: feed1.id, evenements: [ev("x@google.com", 1, 2)] }, null)).status).toBe(401);
      expect((await call("/api/admin/import/agenda-google", { unitId: 2, feedId: feed1.id, evenements: [ev("x@google.com", 1, 2)] })).status).toBe(400);
      expect((await call("/api/admin/import/agenda-google", { unitId: 1, feedId: feed1.id, evenements: [] })).status).toBe(400);
      expect((await call("/api/admin/import/agenda-google", { unitId: 1, feedId: 999, evenements: [ev("x@google.com", 1, 2)] })).status).toBe(404);
    });

    it("complète la réservation « Busy » de la synchro au lieu de la recréer, puis la synchro la reconnaît", async () => {
      const busy = ics([{ uid: "busy1@google.com", from: D(10), to: D(13) }]);
      expect((await syncFeed(t.db, feed1, fetchOf(busy))).imported).toBe(1);
      const avant = await bookingByUid(feed1, "busy1@google.com");
      expect(avant).toMatchObject({ adults: 0, guest_id: null, internal_notes: "iCal : Busy" });

      const r = res(await imp(feed1, [ev("busy1@google.com", 10, 13, { totalCents: 300000 })]));
      expect(r).toMatchObject({ creees: 0, completees: 1, ignorees: 0 });
      const apres = (await bookingByUid(feed1, "busy1@google.com"))!;
      expect(apres.id).toBe(avant!.id);
      expect(apres).toMatchObject({ status: "confirmed", source: "ical", adults: capaScieur, total_cents: 300000, paid_cents: 241800, balance_due_date: null });
      expect(String(apres.internal_notes)).toContain("Import agenda Google");
      expect(String(apres.internal_notes)).toContain(`capacité par défaut du bien : ${capaScieur}`);
      expect(String(apres.internal_notes)).not.toContain("iCal : Busy");
      const guest = await t.db.prepare("SELECT * FROM guests WHERE id = ?1").bind(apres.guest_id).first<Record<string, unknown>>();
      expect(guest).toMatchObject({ first_name: "Jean", last_name: "Dupont", email: "jean.dupont@example.test" });

      const sync = await syncFeed(t.db, feed1, fetchOf(busy));
      expect(sync).toMatchObject({ imported: 0, updated: 0, cancelled: 0, conflicts: [] });
    });

    it("un second passage ne double ni les paiements ni les notes", async () => {
      const b = (await bookingByUid(feed1, "busy1@google.com"))!;
      const notes = b.internal_notes;
      const r = res(await imp(feed1, [ev("busy1@google.com", 10, 13, { totalCents: 300000 })]));
      expect(r.completees).toBe(1);
      expect((await listPayments(t.db, { bookingId: Number(b.id) })).length).toBe(2);
      expect((await bookingByUid(feed1, "busy1@google.com"))!.internal_notes).toBe(notes);
    });

    it("un paiement ajouté en tête du titre ne double pas les autres ; notes et téléphone repris, notes à la main gardées", async () => {
      const b = (await bookingByUid(feed1, "busy1@google.com"))!;
      await t.db.prepare("UPDATE bookings SET internal_notes = internal_notes || '\n\nNote à la main' WHERE id = ?1").bind(b.id).run();
      const plus = ev("busy1@google.com", 10, 13, {
        totalCents: 300000, telephone: "+32470000000", notes: "Agenda Google : « titre corrigé »",
        paiements: [{ cents: 5000, date: D(-90), methode: "cash" }, { cents: 137900, date: D(-30), methode: "transfer" }, { cents: 103900, date: null, methode: "transfer" }],
      });
      expect(res(await imp(feed1, [plus])).completees).toBe(1);
      expect((await listPayments(t.db, { bookingId: Number(b.id) })).length).toBe(3);
      const notes = String((await bookingByUid(feed1, "busy1@google.com"))!.internal_notes);
      expect(notes).toContain("titre corrigé");
      expect(notes).not.toContain("1379 25/12");
      expect(notes).toContain("Note à la main");
      expect(notes.match(/Import agenda Google/g)?.length).toBe(1);
      expect(notes).toContain("capacité par défaut du bien");
      const g = await t.db.prepare("SELECT phone FROM guests WHERE id = ?1").bind(b.guest_id).first<{ phone: string }>();
      expect(g?.phone).toBe("+32470000000");
    });

    it("titre corrigé : l'ancien paiement est neutralisé, pas additionné ; le vrai nombre de personnes remplace le défaut", async () => {
      const b = (await bookingByUid(feed1, "busy1@google.com"))!;
      const corrige = ev("busy1@google.com", 10, 13, {
        totalCents: 300000, personnes: 7,
        paiements: [{ cents: 5000, date: D(-90), methode: "cash" }, { cents: 140000, date: D(-30), methode: "transfer" }, { cents: 103900, date: null, methode: "transfer" }],
      });
      res(await imp(feed1, [corrige]));
      const pays = await listPayments(t.db, { bookingId: Number(b.id) });
      expect(pays.filter((p) => p.status === "succeeded").map((p) => p.amountCents).sort()).toEqual([103900, 140000, 5000].sort());
      expect(pays.find((p) => p.amountCents === 137900)?.status).toBe("failed");
      const apres = (await bookingByUid(feed1, "busy1@google.com"))!;
      expect(apres).toMatchObject({ paid_cents: 248900, adults: 7 });
      expect(String(apres.internal_notes)).not.toContain("capacité par défaut du bien");
    });

    it("libérée par la synchro (ical_removed) alors que l'agenda la garde : rouverte et complétée", async () => {
      await syncFeed(t.db, feed1, fetchOf(ics([{ uid: "trou@google.com", from: D(100), to: D(102) }])));
      await syncFeed(t.db, feed1, fetchOf(ics([{ uid: "busy1@google.com", from: D(10), to: D(13) }])));
      expect(await bookingByUid(feed1, "trou@google.com")).toMatchObject({ status: "cancelled", cancel_reason: "ical_removed" });
      const r = res(await imp(feed1, [ev("trou@google.com", 100, 102, { email: "trou@example.test", nom: "Trou Flux", paiements: [] })]));
      expect(r.completees).toBe(1);
      expect(await bookingByUid(feed1, "trou@google.com")).toMatchObject({ status: "confirmed", cancel_reason: null });
    });

    it("conflit : aucune fiche client créée pour rien", async () => {
      const g = await count("SELECT COUNT(*) AS n FROM guests");
      const occupe = await createBookingAtomic(t.db, { unitId: 1, checkin: D(110), checkout: D(112), adults: 2, children: 0, status: "confirmed", source: "manual" });
      expect(occupe.ok).toBe(true);
      expect(res(await imp(feed1, [ev("orphelin@google.com", 110, 112, { email: "jamais.vu@example.test", nom: "Jamais Vu" })])).ignorees).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM guests")).toBe(g);
    });

    it("annulation posée à la main : son motif est gardé", async () => {
      const c = await createBookingAtomic(t.db, { unitId: 1, checkin: D(120), checkout: D(122), adults: 2, children: 0, status: "confirmed", source: "ical", externalUid: `feed${feed1.id}:main@google.com` });
      if (c.ok) await t.db.prepare("UPDATE bookings SET status = 'cancelled', cancel_reason = 'client a appelé' WHERE id = ?1").bind(c.id).run();
      const r = res(await imp(feed1, [ev("main@google.com", 120, 122, { statut: "annulee", paiements: [] })]));
      expect(r.lignes[0]!.avertissements?.join(" ")).toContain("motif gardé");
      expect(await bookingByUid(feed1, "main@google.com")).toMatchObject({ cancel_reason: "client a appelé" });
    });

    it("crée une réservation iCal portant l'UID du flux, que syncFeed reconnaît ensuite", async () => {
      const r = res(await imp(feed1, [ev("neuf@google.com", 20, 23, { email: "autre.client@example.test", nom: "Autre Client", paiements: [] })]));
      expect(r.creees).toBe(1);
      const b = (await bookingByUid(feed1, "neuf@google.com"))!;
      expect(b).toMatchObject({ status: "confirmed", source: "ical", channel_label: feed1.name, checkin: D(20), checkout: D(23) });
      const sync = await syncFeed(t.db, feed1, fetchOf(ics([
        { uid: "busy1@google.com", from: D(10), to: D(13) },
        { uid: "neuf@google.com", from: D(20), to: D(23) },
        { uid: "trou@google.com", from: D(100), to: D(102) },
      ])));
      expect(sync).toMatchObject({ imported: 0, updated: 0, cancelled: 0 });
    });

    it("garde le nom d'un client déjà connu par son adresse", async () => {
      await t.db.prepare("INSERT INTO guests (email, first_name, last_name) VALUES ('connu@example.test', 'Jean', 'Vrainom')").run();
      res(await imp(feed1, [ev("connu@google.com", 30, 32, { email: "connu@example.test", nom: "Connu", paiements: [] })]));
      const b = (await bookingByUid(feed1, "connu@google.com"))!;
      const g = await t.db.prepare("SELECT * FROM guests WHERE id = ?1").bind(b.guest_id).first<Record<string, unknown>>();
      expect(g).toMatchObject({ first_name: "Jean", last_name: "Vrainom" });
    });

    it("annulée : inscrite annulée (créneau libre), jamais rouverte par la synchro", async () => {
      const r = res(await imp(feed1, [ev("annule@google.com", 40, 43, { statut: "annulee", paiements: [{ cents: 50000, date: D(-60), methode: "transfer" }] })]));
      expect(r.annulees).toBe(1);
      const b = (await bookingByUid(feed1, "annule@google.com"))!;
      expect(b).toMatchObject({ status: "cancelled", cancel_reason: "agenda_annulee", source: "ical", paid_cents: 50000 });
      const all = [
        { uid: "busy1@google.com", from: D(10), to: D(13) },
        { uid: "neuf@google.com", from: D(20), to: D(23) },
        { uid: "connu@google.com", from: D(30), to: D(32) },
        { uid: "annule@google.com", from: D(40), to: D(43) },
        { uid: "trou@google.com", from: D(100), to: D(102) },
      ];
      const sync = await syncFeed(t.db, feed1, fetchOf(ics(all)));
      expect(sync).toMatchObject({ imported: 0, reactivated: 0, conflicts: [] });
      expect((await bookingByUid(feed1, "annule@google.com"))!.status).toBe("cancelled");
      // Le créneau est libre : une vente directe passe.
      const direct = await createBookingAtomic(t.db, { unitId: 1, checkin: D(40), checkout: D(43), adults: 2, children: 0, status: "confirmed", source: "manual" });
      expect(direct.ok).toBe(true);
    });

    it("annulée alors que la synchro l'avait déjà libérée (ical_removed) : motif remplacé, la synchro ne la rouvre plus", async () => {
      await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "parti@google.com", from: D(54), to: D(56) }])));
      await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "autre@google.com", from: D(57), to: D(58) }])));
      expect(await bookingByUid(feed2, "parti@google.com")).toMatchObject({ status: "cancelled", cancel_reason: "ical_removed" });
      res(await imp(feed2, [ev("parti@google.com", 54, 56, { statut: "annulee", paiements: [] })]));
      expect(await bookingByUid(feed2, "parti@google.com")).toMatchObject({ status: "cancelled", cancel_reason: "agenda_annulee" });
      const sync = await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "parti@google.com", from: D(54), to: D(56) }])));
      expect(sync.reactivated).toBe(0);
      expect((await bookingByUid(feed2, "parti@google.com"))!.status).toBe("cancelled");
    });

    it("annulée alors que la synchro l'avait créée : annulée et complétée", async () => {
      await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "a2@google.com", from: D(50), to: D(52) }])));
      const r = res(await imp(feed2, [ev("a2@google.com", 50, 52, { statut: "annulee", paiements: [] })]));
      expect(r.annulees).toBe(1);
      expect(await bookingByUid(feed2, "a2@google.com")).toMatchObject({ status: "cancelled", cancel_reason: "agenda_annulee" });
      const sync = await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "a2@google.com", from: D(50), to: D(52) }])));
      expect(sync).toMatchObject({ reactivated: 0, imported: 0 });
    });

    it("blocage : la « Busy » laisse la place à un blocage manuel rattaché à l'UID, que la synchro respecte", async () => {
      const flux = ics([{ uid: "tlf@google.com", from: D(60), to: D(62) }]);
      await syncFeed(t.db, feed2, fetchOf(flux));
      expect(await bookingByUid(feed2, "tlf@google.com")).toMatchObject({ status: "confirmed" });
      const r = res(await imp(feed2, [{ uid: "tlf@google.com", checkin: D(60), checkout: D(62), statut: "blocage", motif: "TLF", paiements: [] }]));
      expect(r.blocages).toBe(1);
      expect(await bookingByUid(feed2, "tlf@google.com")).toMatchObject({ status: "cancelled", cancel_reason: "agenda_blocage" });
      const k = await t.db.prepare("SELECT * FROM manual_blocks WHERE external_uid = ?1").bind(`feed${feed2.id}:tlf@google.com`).first<Record<string, unknown>>();
      expect(k).toMatchObject({ active: 1, reason: "TLF", checkin: D(60), checkout: D(62), created_by: "import agenda Google" });
      const sync = await syncFeed(t.db, feed2, fetchOf(flux));
      expect(sync).toMatchObject({ imported: 0, reactivated: 0, conflicts: [] });
      expect(await count("SELECT COUNT(*) AS n FROM sync_conflicts WHERE status = 'open'")).toBe(0);
      // Le blocage occupe le stock.
      expect((await createBookingAtomic(t.db, { unitId: 2, checkin: D(60), checkout: D(61), adults: 2, children: 0, status: "confirmed", source: "manual" })).ok).toBe(false);
      // Idempotent.
      expect(res(await imp(feed2, [{ uid: "tlf@google.com", checkin: D(60), checkout: D(62), statut: "blocage", motif: "TLF" }]))).toMatchObject({ blocages: 0, ignorees: 1 });
      expect(await count("SELECT COUNT(*) AS n FROM manual_blocks")).toBe(1);
    });

    it("blocage importé : suit l'événement déplacé dans l'agenda ; levé à la main, la synchro ne le recrée pas", async () => {
      const moved = await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "tlf@google.com", from: D(63), to: D(65) }])));
      expect(moved).toMatchObject({ updated: 1, imported: 0, conflicts: [] });
      const k = (await t.db.prepare("SELECT * FROM manual_blocks WHERE external_uid = ?1").bind(`feed${feed2.id}:tlf@google.com`).first<Record<string, unknown>>())!;
      expect(k).toMatchObject({ checkin: D(63), checkout: D(65), active: 1 });
      await t.db.prepare("UPDATE manual_blocks SET active = 0 WHERE id = ?1").bind(k.id).run();
      const after = await syncFeed(t.db, feed2, fetchOf(ics([{ uid: "tlf@google.com", from: D(63), to: D(65) }])));
      expect(after).toMatchObject({ imported: 0, reactivated: 0 });
      expect((await bookingByUid(feed2, "tlf@google.com"))!.status).toBe("cancelled");
    });

    it("conflit : rien n'est écrit, la raison nomme ce qui occupe le créneau", async () => {
      const occupe = await createBookingAtomic(t.db, { unitId: 2, checkin: D(70), checkout: D(73), adults: 2, children: 0, status: "confirmed", source: "manual" });
      expect(occupe.ok).toBe(true);
      const r = res(await imp(feed2, [
        ev("conflit@google.com", 71, 72),
        { uid: "conflit-blocage@google.com", checkin: D(72), checkout: D(74), statut: "blocage", motif: "famille" },
      ]));
      expect(r).toMatchObject({ creees: 0, blocages: 0, ignorees: 2 });
      expect(String(r.lignes[0]!.raison)).toContain(occupe.ok ? occupe.reference : "");
      expect(await bookingByUid(feed2, "conflit@google.com")).toBeNull();
    });

    it("même client sur les deux maisons aux mêmes dates : deux réservations, une par maison", async () => {
      const deux = { email: "domaine@example.test", nom: "Famille Domaine", paiements: [] };
      res(await imp(feed1, [ev("d1@google.com", 80, 83, deux)]));
      res(await imp(feed2, [ev("d2@google.com", 80, 83, deux)]));
      expect(await bookingByUid(feed1, "d1@google.com")).toMatchObject({ unit_id: 1, status: "confirmed" });
      expect(await bookingByUid(feed2, "d2@google.com")).toMatchObject({ unit_id: 2, status: "confirmed" });
    });

    it("essai : dit ce qui serait fait sans rien écrire", async () => {
      const avant = await count("SELECT (SELECT COUNT(*) FROM bookings) + (SELECT COUNT(*) FROM payments) + (SELECT COUNT(*) FROM manual_blocks) + (SELECT COUNT(*) FROM guests) AS n");
      const r = res(await imp(feed1, [
        ev("essai@google.com", 90, 92),
        ev("busy1@google.com", 10, 13),
        { uid: "essai-bloc@google.com", checkin: D(95), checkout: D(96), statut: "blocage", motif: "famille" },
        { uid: "sans-dates@google.com", checkin: D(5), checkout: D(5), statut: "confirmee", nom: "X" },
        ev("essai@google.com", 90, 92),
      ], true));
      expect(r).toMatchObject({ creees: 1, completees: 1, blocages: 1, ignorees: 2 });
      expect(r.lignes[4]!.raison).toBe("uid en double dans la requête");
      const apres = await count("SELECT (SELECT COUNT(*) FROM bookings) + (SELECT COUNT(*) FROM payments) + (SELECT COUNT(*) FROM manual_blocks) + (SELECT COUNT(*) FROM guests) AS n");
      expect(apres).toBe(avant);
    });

    it("chaque ligne écrite laisse une trace au journal, sans nom ni adresse", async () => {
      const rows = (await t.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'agenda.import%'").all()).results as { action: string; detail: string }[];
      expect(rows.some((r) => r.action === "agenda.import.creee")).toBe(true);
      expect(rows.some((r) => r.action === "agenda.import.completee")).toBe(true);
      expect(rows.some((r) => r.action === "agenda.import.blocage")).toBe(true);
      expect(rows.some((r) => r.action === "agenda.import.ignoree")).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(/Dupont|example\.test/);
    });
  });
}
