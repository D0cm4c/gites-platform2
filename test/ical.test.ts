// Tests iCal : parseur (dépliage, VALUE=DATE, date-time), export, et
// synchronisation complète d'un flux contre une vraie base D1 (fetch mocké) —
// import, déplacement, annulation, conflits, erreurs réseau.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { applyDepartureDayIncluded, buildIcs, parseIcs, syncFeed } from "../src/services/ical";
import { createBookingAtomic, createFeed, getFeed, listFeedBookings, listBookings, getBooking } from "../src/db/repo";

const SCIERIE = 2;
const DOMAINE = 3;

let t: TestDb;
let db: D1Database;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "ical_feeds"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

// Un calendrier façon Airbnb : lignes CRLF, description repliée sur 2 lignes.
const AIRBNB_ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTAMP:20260701T120000Z",
  "DTSTART;VALUE=DATE:20261005",
  "DTEND;VALUE=DATE:20261009",
  "UID:airbnb-HMKAXY123@airbnb.com",
  "SUMMARY:Reserved - Airbnb HMKAXY123",
  "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de",
  " tails/HMKAXY123", // ligne repliée (continuation par espace)
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260701T120000Z",
  "DTSTART;VALUE=DATE:20261101",
  "DTEND;VALUE=DATE:20261103",
  "UID:airbnb-HMZZZ999@airbnb.com",
  "SUMMARY:Airbnb (Not available)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("lit les VEVENT Airbnb (VALUE=DATE, lignes repliées, CRLF)", () => {
    const events = parseIcs(AIRBNB_ICS);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      uid: "airbnb-HMKAXY123@airbnb.com",
      dtstart: "2026-10-05",
      dtend: "2026-10-09",
      summary: "Reserved - Airbnb HMKAXY123",
      allDay: true,
    });
  });

  it("convention « jour de départ inclus » : retire un jour aux journées entières, pas aux heures", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:j@x", "DTSTART;VALUE=DATE:20261222", "DTEND;VALUE=DATE:20261227", "END:VEVENT",
      "BEGIN:VEVENT", "UID:h@x", "DTSTART:20261222T150000Z", "DTEND:20261226T090000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:un-jour@x", "DTSTART;VALUE=DATE:20261230", "DTEND;VALUE=DATE:20261231", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const events = applyDepartureDayIncluded(parseIcs(ics));
    // « du 22 au 26 » affiché (DTEND exclusif 27) = départ le 26, 4 nuits
    expect(events.map((e) => [e.uid, e.dtstart, e.dtend])).toEqual([
      ["j@x", "2026-12-22", "2026-12-26"],
      ["h@x", "2026-12-22", "2026-12-26"],
    ]);
  });

  it("accepte les DTSTART en date-time et ignore les événements incomplets", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a@x", "DTSTART:20260810T140000Z", "DTEND:20260812T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:sans-dtend@x", "DTSTART;VALUE=DATE:20260901",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]?.dtstart).toBe("2026-08-10");
    expect(events[0]?.dtend).toBe("2026-08-12");
  });

  it("convertit un date-time UTC à la date de Bruxelles (minuit local = 23:00Z la veille)", () => {
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT",
      "UID:google@x", "DTSTART:20261101T230000Z", "DTEND:20261108T090000Z",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\n");
    const events = parseIcs(ics);
    expect(events[0]?.dtstart).toBe("2026-11-02");
    expect(events[0]?.dtend).toBe("2026-11-08");
  });
});

describe("buildIcs", () => {
  it("produit un calendrier RFC 5545 (CRLF, DTEND exclusif) relisible par notre parseur", () => {
    const ics = buildIcs("La Scierie", "Les Gîtes du Pré Moré", [
      { checkin: "2026-08-15", checkout: "2026-08-22" },
    ], "2026-07-12 15:00:00");
    expect(ics).toContain("\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260815");
    expect(ics).toContain("DTEND;VALUE=DATE:20260822");
    const roundtrip = parseIcs(ics);
    expect(roundtrip).toHaveLength(1);
    expect(roundtrip[0]?.dtstart).toBe("2026-08-15");
    expect(roundtrip[0]?.dtend).toBe("2026-08-22");
  });
});

function mockFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

const NOW = new Date("2026-07-12T10:00:00Z");

async function makeFeed(): Promise<NonNullable<Awaited<ReturnType<typeof getFeed>>>> {
  const id = await createFeed(db, { unitId: SCIERIE, name: "Airbnb — Test", url: "https://example.com/cal.ics" });
  const feed = await getFeed(db, id);
  if (!feed) throw new Error("feed non créé");
  return feed;
}

describe("syncFeed (import complet sur vraie D1)", () => {
  it("un flux « jour de départ inclus » libère le jour du départ pour l'arrivée suivante", async () => {
    const id = await createFeed(db, { unitId: SCIERIE, name: "Agenda papa", url: "https://example.com/papa.ics", departureDayIncluded: true });
    const feed = await getFeed(db, id);
    if (!feed) throw new Error("feed non créé");
    expect(feed.departureDayIncluded).toBe(true);
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:papa-1@google.com", "DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261010", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const result = await syncFeed(db, feed, mockFetch(ics), NOW);
    expect(result.error).toBeNull();
    expect(result.imported).toBe(1);
    const [b] = await listFeedBookings(db, feed.id);
    expect([b!.checkin, b!.checkout]).toEqual(["2026-10-05", "2026-10-09"]);
    // le 9 (jour du départ) est libre : une arrivée le 9 passe
    const suivant = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: "2026-10-09", checkout: "2026-10-11",
      adults: 2, children: 0, status: "confirmed", source: "manual", now: NOW,
    });
    expect(suivant.ok).toBe(true);
  });

  it("importe les événements futurs en résas confirmées, avec liaison active", async () => {
    const feed = await makeFeed();
    const result = await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    expect(result.error).toBeNull();
    expect(result.imported).toBe(2);
    const imported = await listFeedBookings(db, feed.id);
    expect(imported).toHaveLength(2);
    expect(imported.every((b) => b.status === "confirmed" && b.source === "ical")).toBe(true);
    // la liaison joue : le Domaine est bloqué pendant l'événement Airbnb
    const domaine = await createBookingAtomic(db, {
      unitId: DOMAINE, checkin: "2026-10-05", checkout: "2026-10-09",
      adults: 10, children: 0, status: "confirmed", source: "manual", now: NOW,
    });
    expect(domaine.ok).toBe(false);
  });

  it("est idempotent : re-relever le même flux n'importe rien de nouveau", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const again = await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    expect(again.imported).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.cancelled).toBe(0);
    expect(await listFeedBookings(db, feed.id)).toHaveLength(2);
  });

  it("déplace une résa quand les dates changent côté canal (re-vérif de conflit)", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const moved = AIRBNB_ICS.replace("DTSTART;VALUE=DATE:20261005", "DTSTART;VALUE=DATE:20261006")
      .replace("DTEND;VALUE=DATE:20261009", "DTEND;VALUE=DATE:20261010");
    const result = await syncFeed(db, feed, mockFetch(moved), NOW);
    expect(result.updated).toBe(1);
    const bookings = await listFeedBookings(db, feed.id);
    const b = bookings.find((x) => x.externalUid?.includes("HMKAXY123"));
    expect(b?.checkin).toBe("2026-10-06");
    expect(b?.checkout).toBe("2026-10-10");
  });

  it("annule les résas futures disparues du flux (annulation côté canal)", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const shorter = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:airbnb-HMKAXY123@airbnb.com",
      "DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261009",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = await syncFeed(db, feed, mockFetch(shorter), NOW);
    expect(result.cancelled).toBe(1); // HMZZZ999 a disparu → libéré
    expect(await listFeedBookings(db, feed.id)).toHaveLength(1);
  });

  it("détecte le conflit : l'événement entrant chevauche une résa directe → alerte, pas d'écrasement", async () => {
    // une résa directe existe déjà sur la Scierie du 05 au 09/10
    const direct = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: "2026-10-05", checkout: "2026-10-09",
      adults: 4, children: 0, status: "confirmed", source: "direct", now: NOW,
    });
    expect(direct.ok).toBe(true);
    const feed = await makeFeed();
    const result = await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    expect(result.imported).toBe(1); // seul HMZZZ999 (novembre) passe
    expect(result.conflicts).toHaveLength(1);
    const updatedFeed = await getFeed(db, feed.id);
    expect(updatedFeed?.lastStatus).toContain("conflit");
    // la résa directe est intacte
    if (direct.ok) expect((await getBooking(db, direct.id))?.status).toBe("confirmed");
  });

  it("ignore les événements déjà terminés (dtend ≤ aujourd'hui)", async () => {
    const feed = await makeFeed();
    const past = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:past@x", "DTSTART;VALUE=DATE:20260101", "DTEND;VALUE=DATE:20260105",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = await syncFeed(db, feed, mockFetch(past), NOW);
    expect(result.imported).toBe(0);
    expect((await listBookings(db, {})).length).toBe(0);
  });

  // Issue #18, même défaut côté flux iCal : un événement qui disparaît du flux
  // (annulé) puis réapparaît repartait sur une création avec le même
  // external_uid → violation d'unicité → TOUTE la relève du flux échouait.
  it("événement disparu puis réapparu : réactivation, aucune exception", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const withoutFirst = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:airbnb-HMZZZ999@airbnb.com",
      "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261103",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect((await syncFeed(db, feed, mockFetch(withoutFirst), NOW)).cancelled).toBe(1);

    const back = await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    expect(back.error).toBeNull();
    expect(back.conflicts).toEqual([]);
    expect(back.reactivated).toBe(1);
    const bookings = await listFeedBookings(db, feed.id);
    expect(bookings).toHaveLength(2);
    // pas de doublon : une seule ligne porte cet external_uid
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE external_uid LIKE '%HMKAXY123%'")
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("réapparition impossible (créneau revendu) → conflit signalé, pas d'exception", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const withoutFirst = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:airbnb-HMZZZ999@airbnb.com",
      "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261103",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await syncFeed(db, feed, mockFetch(withoutFirst), NOW);
    // le créneau libéré est revendu en direct
    const direct = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: "2026-10-06", checkout: "2026-10-08",
      adults: 4, children: 0, status: "confirmed", source: "direct", now: NOW,
    });
    expect(direct.ok).toBe(true);

    const back = await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    expect(back.error).toBeNull();
    expect(back.reactivated).toBe(0);
    expect(back.conflicts).toHaveLength(1);
    expect(back.conflicts[0]).toContain("réactivation");
    if (direct.ok) expect((await getBooking(db, direct.id))?.status).toBe("confirmed");
  });

  it("nouvel événement listé AVANT le déplacement qui lui libère la place : importé au même passage", async () => {
    // Cas réel du 10/10/2026 (agenda Google de papa, dates UTC d'avant #112) :
    // la résa connue passe du 01/11 au 02/11, et le séjour 30/10→02/11, écrit
    // plus haut dans le fichier, n'entre qu'une fois ce déplacement fait.
    const feed = await makeFeed();
    const cal = (events: string[][]) =>
      ["BEGIN:VCALENDAR", ...events.flatMap(([uid, a, b]) => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Busy", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
    await syncFeed(db, feed, mockFetch(cal([["suivant@google.com", "20271101", "20271108"]])), NOW);
    const r = await syncFeed(db, feed, mockFetch(cal([
      ["avant@google.com", "20271030", "20271102"],
      ["suivant@google.com", "20271102", "20271108"],
    ])), NOW);
    expect(r).toMatchObject({ imported: 1, updated: 1, conflicts: [] });
  });

  it("erreur réseau → statut d'erreur sur le flux, aucune résa touchée", async () => {
    const feed = await makeFeed();
    await syncFeed(db, feed, mockFetch(AIRBNB_ICS), NOW);
    const result = await syncFeed(db, feed, mockFetch("boom", 500), NOW);
    expect(result.error).toContain("500");
    expect(await listFeedBookings(db, feed.id)).toHaveLength(2); // rien annulé
    const updatedFeed = await getFeed(db, feed.id);
    expect(updatedFeed?.lastStatus).toContain("erreur");
  });
});
