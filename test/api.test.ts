// Test d'intégration de l'API — le parcours client complet contre une vraie
// base D1, en mode stub (sans Stripe) : recherche → réservation (hold) →
// paiement simulé → confirmation + voucher journalisé → conflits rejetés.
// Les montants exacts sont couverts par pricing.test.ts ; ici on vérifie les
// invariants de flux, robustes quelle que soit la date d'exécution.
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

// Séjour de 7 nuits, ~120 j dans le futur : satisfait tous les min-nuits du
// seed (2 ou 7) quelle que soit la saison où il tombe.
const ADMIN = "test-admin-token";
const ADMIN_HEADER = { authorization: `Bearer ${ADMIN}` };

const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher, // jamais touché par le routeur
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    // La garde admin est fail-closed : sans jeton NI en-tête Cloudflare Access,
    // /api/admin/* refuse tout (audit ECC 2026-07-30).
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  overrideEnv?: Env,
): Promise<{ status: number; data: Record<string, unknown> }> {
  // Jeton admin par défaut ; un en-tête explicite reste prioritaire.
  const auth = path.startsWith("/api/admin") && !("authorization" in headers) ? ADMIN_HEADER : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth, ...headers } : { ...auth, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, overrideEnv ?? env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

const GUEST = {
  firstName: "Jean",
  lastName: "Dupont",
  email: "jean.dupont@example.com",
  phone: "+32 470 00 00 00",
};

function bookingBody(unitId: number, over: Record<string, unknown> = {}) {
  return {
    unitId,
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 4,
    children: 0,
    paymentMode: "deposit",
    guest: GUEST,
    cgvAccepted: true,
    ...over,
  };
}

describe("fiche domaine et disponibilité", () => {
  it("expose la fiche du Pré Moré (3 unités, options, réglages)", async () => {
    const { status, data } = await call("GET", "/api/public/properties/pre-more");
    expect(status).toBe(200);
    const units = data.units as { name: string }[];
    expect(units.map((u) => u.name)).toEqual(["La Maison du Scieur", "La Scierie", "Le Domaine entier"]);
    expect((data.options as unknown[]).length).toBeGreaterThan(0);
  });

  it("recherche : tout est libre au départ, devis joints", async () => {
    const { status, data } = await call(
      "GET",
      `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=4`,
    );
    expect(status).toBe(200);
    const units = data.units as { unitId: number; available: boolean; quote: { totalCents: number; ok: boolean } | null }[];
    expect(units.every((u) => u.available)).toBe(true);
    const scierie = units.find((u) => u.unitId === 2)!;
    expect(scierie.quote?.ok).toBe(true);
    expect(scierie.quote!.totalCents).toBeGreaterThan(0);
  });

  it("refuse les dates passées et les formats invalides", async () => {
    const past = addDays(todayInZone(), -5);
    expect((await call("GET", `/api/public/availability?property=pre-more&checkin=${past}&checkout=${CHECKOUT}&adults=2`)).status).toBe(400);
    expect((await call("GET", `/api/public/availability?property=pre-more&checkin=demain&checkout=${CHECKOUT}&adults=2`)).status).toBe(400);
  });
});

describe("parcours de réservation complet (mode stub)", () => {
  it("réserve, paie l'acompte, confirme, journalise la confirmation, bloque la liaison", async () => {
    // 1. Création → hold + URL de paiement stub
    const created = await call("POST", "/api/public/bookings", bookingBody(2));
    expect(created.status).toBe(201);
    const reference = created.data.reference as string;
    expect(reference).toMatch(/^PM-\d{4}-\d{3,}$/);
    const checkoutUrl = created.data.checkoutUrl as string;
    expect(checkoutUrl).toContain("/book/dev-pay.html?session=");
    const session = new URL(checkoutUrl).searchParams.get("session")!;
    const amountDue = created.data.amountDueCents as number;
    expect(amountDue).toBeGreaterThan(0);

    // 2. Pendant le hold : l'unité ET le Domaine sont indisponibles
    const during = await call("GET", `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=4`);
    const dUnits = during.data.units as { unitId: number; available: boolean }[];
    expect(dUnits.find((u) => u.unitId === 2)!.available).toBe(false);
    expect(dUnits.find((u) => u.unitId === 3)!.available).toBe(false);
    expect(dUnits.find((u) => u.unitId === 1)!.available).toBe(true);

    // 3. Info paiement stub puis confirmation
    const info = await call("GET", `/api/public/dev-pay/info?session=${encodeURIComponent(session)}`);
    expect(info.status).toBe(200);
    expect(info.data.amountCents).toBe(amountDue);
    const confirmed = await call("POST", "/api/public/dev-pay/confirm", { session });
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.reference).toBe(reference);

    // 4. Voucher public : statut confirmé, acompte encaissé
    const voucher = await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`);
    expect(voucher.status).toBe(200);
    const b = voucher.data.booking as Record<string, unknown>;
    expect(b.status).toBe("confirmed");
    expect(b.paidCents).toBe(amountDue);
    expect((b.balanceCents as number) + amountDue).toBe(b.totalCents);

    // idempotence : rejouer la confirmation ne double pas l'encaissement
    await call("POST", "/api/public/dev-pay/confirm", { session });
    const voucher2 = await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`);
    expect((voucher2.data.booking as Record<string, unknown>).paidCents).toBe(amountDue);

    // sans email correct → introuvable (pas de fuite)
    expect((await call("GET", `/api/public/bookings/${reference}?email=autre@example.com`)).status).toBe(404);

    // 5. Voucher journalisé en stub (aucun envoi réel)
    const emails = await call("GET", "/api/admin/email-log");
    const kinds = (emails.data.emails as { kind: string; status: string }[]).map((e) => [e.kind, e.status].join(":"));
    expect(kinds).toContain("confirmation:stub");

    // 6. Doubles réservations rejetées (même unité, puis Domaine via liaison)
    expect((await call("POST", "/api/public/bookings", bookingBody(2, { guest: { ...GUEST, email: "x@y.be" } }))).status).toBe(409);
    expect((await call("POST", "/api/public/bookings", bookingBody(3, { adults: 12, guest: { ...GUEST, email: "x@y.be" } }))).status).toBe(409);

    // 7. L'export iCal du Domaine contient le blocage par liaison
    const ics = await router.handle(new Request("http://test.local/ical/local-dev-token-domaine.ics"), env);
    const icsText = await ics!.text();
    expect(icsText).toContain("BEGIN:VEVENT");
    expect(icsText).toContain(`DTSTART;VALUE=DATE:${CHECKIN.replaceAll("-", "")}`);
  });

  it("valide les entrées : capacité, promo invalide, client incomplet", async () => {
    expect((await call("POST", "/api/public/bookings", bookingBody(2, { adults: 25 }))).status).toBe(400);
    expect((await call("POST", "/api/public/bookings", bookingBody(2, { promoCode: "NEXISTEPAS" }))).status).toBe(400);
    expect((await call("POST", "/api/public/bookings", bookingBody(2, { guest: { lastName: "X", email: "pas-un-email" } }))).status).toBe(400);
  });
});

describe("admin", () => {
  it("vente du back-office = option (jamais confirmée d'office) + lien de paiement stub + annulation → libération", async () => {
    const sale = await call("POST", "/api/admin/bookings", {
      unitId: 1,
      checkin: CHECKIN,
      checkout: CHECKOUT,
      adults: 8,
      guest: { lastName: "Peeters", email: "peeters@example.com" },
      internalNotes: "résa téléphone",
      generatePaymentLink: true,
    });
    expect(sale.status).toBe(201);
    const booking = sale.data.booking as Record<string, unknown>;
    expect(booking.status).toBe("pending"); // décision du 11/10/2026 : le client confirme en payant les arrhes
    expect(sale.data.paymentUrl as string).toContain("dev-pay.html");
    expect(sale.data.optionUrl as string).toContain("/book/voucher.html?ref=");

    // le Domaine est bloqué par liaison
    const avail = await call("GET", `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=4`);
    const availUnits = avail.data.units as { unitId: number; available: boolean; blockedByUnitIds: number[] }[];
    expect(availUnits.find((u) => u.unitId === 3)!.available).toBe(false);
    // issue #45 : la réponse DIT quelle unité fait tomber le Domaine, et la
    // maison restée libre ne porte aucune explication.
    expect(availUnits.find((u) => u.unitId === 3)!.blockedByUnitIds).toEqual([1]);
    expect(availUnits.find((u) => u.unitId === 2)!.blockedByUnitIds).toEqual([]);

    // planning : la ligne Domaine porte un blocage par liaison
    const planning = await call("GET", `/api/admin/planning?property=1&from=${CHECKIN}&to=${CHECKOUT}`);
    const blocks = planning.data.blocks as { unitId: number; sourceReference: string }[];
    expect(blocks.some((b) => b.unitId === 3 && b.sourceReference === booking.reference)).toBe(true);

    // annulation → tout se libère
    const cancel = await call("POST", `/api/admin/bookings/${booking.id}/cancel`, { reason: "test" });
    expect(cancel.status).toBe(200);
    const after = await call("GET", `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=4`);
    expect((after.data.units as { unitId: number; available: boolean }[]).every((u) => u.available)).toBe(true);
  });

  it("paiement manuel (virement) crédite la réservation", async () => {
    const sale = await call("POST", "/api/admin/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4,
      guest: { lastName: "Vranckx" },
    });
    const booking = sale.data.booking as { id: number; totalCents: number };
    const pay = await call("POST", `/api/admin/bookings/${booking.id}/payments`, {
      kind: "deposit", method: "transfer", amountCents: 10000, note: "virement reçu",
    });
    expect(pay.status).toBe(200);
    expect((pay.data.booking as { paidCents: number }).paidCents).toBe(10000);
  });

  it("stats et overview répondent avec une forme cohérente", async () => {
    const year = Number(CHECKIN.slice(0, 4));
    const wedding = await call("POST", "/api/admin/bookings", {
      unitId: 3, checkin: CHECKIN, checkout: CHECKOUT, adults: 15,
      guest: { lastName: "Mariage Dubois" },
    });
    // le back-office crée une option : la confirmation se fait à part
    expect((await call("POST", `/api/admin/bookings/${(wedding.data.booking as { id: number }).id}/confirm`)).status).toBe(200);
    const stats = await call("GET", `/api/admin/stats?property=1&year=${year}`);
    expect(stats.status).toBe(200);
    const current = stats.data.current as { soldNights: number; occupancyPct: number; perUnit: { nights: number }[] };
    // le séjour tombe 120 jours après aujourd'hui : fin août, il chevauche le Nouvel An —
    // on ne compte que les nuits qui appartiennent à l'année interrogée
    let nightsInYear = 0;
    for (let d = CHECKIN; d < CHECKOUT; d = addDays(d, 1)) if (d.startsWith(`${year}-`)) nightsInYear += 1;
    expect(current.soldNights).toBe(nightsInYear);
    // le Domaine occupe SES DEUX maisons : l'occupation compte le double de nuits physiques
    const months = (stats.data.current as { months: { occupiedNights: number }[] }).months;
    expect(months.reduce((s, m) => s + m.occupiedNights, 0)).toBe(nightsInYear * 2);

    const overview = await call("GET", "/api/admin/overview?property=1");
    expect(overview.status).toBe(200);
    expect((overview.data.alerts as { linkAlerts: unknown[] }).linkAlerts).toBeDefined();

    const csv = await router.handle(
      new Request(`http://test.local/api/admin/stats.csv?property=1&year=${year}`, { headers: ADMIN_HEADER }),
      env,
    );
    expect(csv!.headers.get("content-type")).toContain("text/csv");
  });

  it("tableau de bord : chaque alerte porte de quoi mener à sa cible (#48)", async () => {
    // Résa confirmée sur le Domaine entier → alerte « liaison active ».
    // Dans les 60 jours : c'est la fenêtre que regarde l'alerte de liaison.
    const linkIn = addDays(todayInZone(), 30);
    const sale = await call("POST", "/api/admin/bookings", {
      unitId: 3, checkin: linkIn, checkout: addDays(linkIn, 7), adults: 12,
      guest: { lastName: "Janssens", email: "janssens@example.com" },
    });
    expect(sale.status).toBe(201);
    const booking = sale.data.booking as { id: number; reference: string };
    expect((await call("POST", `/api/admin/bookings/${booking.id}/confirm`)).status).toBe(200);

    // Option en cours sur une autre unité et d'autres dates → alerte « option ».
    const hold = await call(
      "POST",
      "/api/public/bookings",
      bookingBody(1, { adults: 4, checkin: addDays(CHECKIN, 30), checkout: addDays(CHECKIN, 37) }),
    );
    expect(hold.status).toBe(201);

    // Envoi d'e-mail en échec rattaché à la résa → signal « Santé » cliquable.
    await t.db
      .prepare(
        `INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status, error_detail)
         VALUES (?1, ?2, 'Votre voucher', 'corps', 'voucher', 'failed', 'HTTP 500 - fournisseur indisponible')`,
      )
      .bind(booking.id, "janssens@example.com")
      .run();

    const overview = await call("GET", "/api/admin/overview?property=1");
    expect(overview.status).toBe(200);
    const alerts = overview.data.alerts as {
      linkAlerts: { id: number }[];
      activeHolds: { id: number }[];
      overdueBalances: { id: number }[];
    };
    // Sans identifiant, l'alerte reste du texte mort : l'exploitant doit
    // retrouver lui-même la réservation concernée.
    expect(alerts.linkAlerts.map((a) => a.id)).toContain(booking.id);
    expect(alerts.activeHolds.length).toBeGreaterThan(0);
    expect(alerts.activeHolds.every((a) => Number.isInteger(a.id) && a.id > 0)).toBe(true);
    expect(alerts.overdueBalances.every((a) => Number.isInteger(a.id) && a.id > 0)).toBe(true);

    const health = overview.data.health as { failedEmails: { bookingId: number | null; reference: string | null }[] };
    expect(health.failedEmails.length).toBe(1);
    expect(health.failedEmails[0]!.bookingId).toBe(booking.id);
    expect(health.failedEmails[0]!.reference).toBe(booking.reference);

    // Un flux en erreur, comme un envoi rate, n'appartient qu'a SON domaine :
    // sinon l'alerte du Moulin nomme un flux du Pre More, et cliquable elle
    // mene a une vue Synchro ou ce flux n'existe pas.
    await t.db
      .prepare("INSERT INTO ical_feeds (unit_id, name, url, last_status) VALUES (2, 'Airbnb test', 'https://example.com/a.ics', 'erreur HTTP 404')")
      .run();
    try {
      const mine = await call("GET", "/api/admin/overview?property=1");
      const other = await call("GET", "/api/admin/overview?property=2");
      expect((mine.data.alerts as { feedAlerts: unknown[] }).feedAlerts.length).toBe(1);
      expect((other.data.alerts as { feedAlerts: unknown[] }).feedAlerts.length).toBe(0);
      expect((other.data.health as { failedEmails: unknown[] }).failedEmails.length).toBe(0);
    } finally {
      await t.db.prepare("DELETE FROM ical_feeds WHERE name = 'Airbnb test'").run();
    }
  });

  it("fiche réservation : le journal d'e-mails porte type, destinataire et statut (#49)", async () => {
    const sale = await call("POST", "/api/admin/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4,
      guest: { lastName: "Mertens", email: "mertens@example.com" },
    });
    const booking = sale.data.booking as { id: number };
    const resent = await call("POST", `/api/admin/bookings/${booking.id}/resend-voucher`);
    expect(resent.status).toBe(200);

    const fiche = await call("GET", `/api/admin/bookings/${booking.id}`);
    expect(fiche.status).toBe(200);
    const emails = fiche.data.emails as {
      kind: string; toEmail: string; status: string; createdAt: string; errorDetail: string | null;
    }[];
    const voucher = emails.find((e) => e.kind === "confirmation");
    expect(voucher).toBeDefined();
    expect(voucher!.toEmail).toBe("mertens@example.com");
    // EMAILS_ENABLED=false : journalisé, donc RIEN n'est parti — la fiche doit
    // pouvoir le dire, c'est toute la différence avec un envoi réussi.
    expect(voucher!.status).toBe("stub");
    expect(voucher!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(voucher!).toHaveProperty("errorDetail");
  });

  it("le jeton ADMIN_TOKEN protège l'API admin quand il est configuré", async () => {
    const secured: Env = { ...env, ADMIN_TOKEN: "secret-jeton" };
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer faux" }, secured)).status).toBe(401);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer secret-jeton" }, secured)).status).toBe(200);
    // les routes publiques restent ouvertes
    expect((await call("GET", "/api/public/today", undefined, {}, secured)).status).toBe(200);
  });

  it("comptes multi-utilisateurs « id:mdp,… » : couple lié exigé, formats legacy tolérés", async () => {
    const secured: Env = { ...env, ADMIN_TOKEN: "julien:mdp-a, matthieu:mdp-b" };
    // format nominal id:mdp — le couple doit correspondre
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer julien:mdp-a" }, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer matthieu:mdp-b" }, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer matthieu:mdp-a" }, secured)).status).toBe(401);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer inconnu:mdp-a" }, secured)).status).toBe(401);
    // mot de passe nu (verify-deploy, sessions historiques) : accepté quel que soit le compte
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer mdp-b" }, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer mdp-x" }, secured)).status).toBe(401);
    // rétro-compatibilité : jeton unique sans identifiant
    const legacy: Env = { ...env, ADMIN_TOKEN: "jeton-seul" };
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer jeton-seul" }, legacy)).status).toBe(200);
  });

  it("POST /api/admin/login : seule route admin hors garde — oui/non, jamais de donnée", async () => {
    const secured: Env = { ...env, ADMIN_TOKEN: "secours:mdp-a, papa:mdp-c" };
    expect((await call("POST", "/api/admin/login", { user: "secours", password: "mdp-a" }, {}, secured)).status).toBe(200);
    expect((await call("POST", "/api/admin/login", { user: "papa", password: "mdp-c" }, {}, secured)).status).toBe(200);
    expect((await call("POST", "/api/admin/login", { user: "secours", password: "mdp-c" }, {}, secured)).status).toBe(401);
    expect((await call("POST", "/api/admin/login", { user: "intrus", password: "mdp-a" }, {}, secured)).status).toBe(401);
    expect((await call("POST", "/api/admin/login", { user: "secours" }, {}, secured)).status).toBe(400);
    // verrou pas posé → 503 explicite (le front affiche le bandeau « verrou inactif »)
    // depuis 0027 un compte « julien » vit en base : sans secret, la route répond 401 (plus 503)
    const nu: Env = { ...env, ADMIN_TOKEN: undefined };
    expect((await call("POST", "/api/admin/login", { user: "secours", password: "x" }, {}, nu)).status).toBe(401);
    // et le compte initial de 0027 ouvre avec son mot de passe provisoire
    expect((await call("POST", "/api/admin/login", { user: "julien", password: "premore-2026" }, {}, nu)).status).toBe(200); // migration 0033
  });

  it("comptes en base : création → login avec session → reset/désactivation coupent tout", async () => {
    const secured: Env = { ...env, ADMIN_TOKEN: ADMIN };
    const created = (await call("POST", "/api/admin/users", { username: "Matthieu" }, ADMIN_HEADER, secured)).data as unknown as {
      id: number; username: string; password: string;
    };
    expect(created.username).toBe("matthieu"); // normalisé en minuscules
    expect(created.password).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    // doublon refusé
    expect((await call("POST", "/api/admin/users", { username: "matthieu" }, ADMIN_HEADER, secured)).status).toBe(409);

    const login = (await call("POST", "/api/admin/login", { user: "matthieu", password: created.password }, {}, secured)).data as unknown as {
      ok: boolean; session?: string;
    };
    expect(login.ok).toBe(true);
    expect(login.session).toBeTruthy();
    const sess = { authorization: `Bearer session:${login.session}` };
    expect((await call("GET", "/api/admin/bookings", undefined, sess, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "Bearer session:deadbeef" }, secured)).status).toBe(401);

    // reset : l'ancien mot de passe ET la session tombent ensemble
    const reset = (await call("POST", `/api/admin/users/${created.id}/reset-password`, {}, ADMIN_HEADER, secured)).data as unknown as { password: string };
    expect((await call("GET", "/api/admin/bookings", undefined, sess, secured)).status).toBe(401);
    expect((await call("POST", "/api/admin/login", { user: "matthieu", password: created.password }, {}, secured)).status).toBe(401);
    const login2 = (await call("POST", "/api/admin/login", { user: "matthieu", password: reset.password }, {}, secured)).data as unknown as { session?: string };
    expect(login2.session).toBeTruthy();

    // désactivation : sessions coupées + login refusé ; réactivation → login OK
    expect((await call("PATCH", `/api/admin/users/${created.id}`, { active: false }, ADMIN_HEADER, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: `Bearer session:${login2.session}` }, secured)).status).toBe(401);
    expect((await call("POST", "/api/admin/login", { user: "matthieu", password: reset.password }, {}, secured)).status).toBe(401);
    expect((await call("PATCH", `/api/admin/users/${created.id}`, { active: true }, ADMIN_HEADER, secured)).status).toBe(200);
    expect((await call("POST", "/api/admin/login", { user: "matthieu", password: reset.password }, {}, secured)).status).toBe(200);

    // ménage : suppression du compte de test
    expect((await call("DELETE", `/api/admin/users/${created.id}`, undefined, ADMIN_HEADER, secured)).status).toBe(200);
  });

  it("anti-verrouillage : pas de désactivation ni suppression de son propre compte ; logout coupe la session", async () => {
    const secured: Env = { ...env, ADMIN_TOKEN: ADMIN };
    const created = (await call("POST", "/api/admin/users", { username: "papa" }, ADMIN_HEADER, secured)).data as unknown as {
      id: number; password: string;
    };
    const login = (await call("POST", "/api/admin/login", { user: "papa", password: created.password }, {}, secured)).data as unknown as { session: string };
    const sess = { authorization: `Bearer session:${login.session}` };
    expect((await call("PATCH", `/api/admin/users/${created.id}`, { active: false }, sess, secured)).status).toBe(400);
    expect((await call("DELETE", `/api/admin/users/${created.id}`, undefined, sess, secured)).status).toBe(400);
    expect((await call("POST", "/api/admin/logout", {}, sess, secured)).status).toBe(200);
    expect((await call("GET", "/api/admin/bookings", undefined, sess, secured)).status).toBe(401);
    expect((await call("DELETE", `/api/admin/users/${created.id}`, undefined, ADMIN_HEADER, secured)).status).toBe(200);
  });

  it("garde FAIL-CLOSED : sans ADMIN_TOKEN ni Cloudflare Access, l'admin refuse tout", async () => {
    // le 503 « verrou pas posé » suppose AUCUN compte : ni secret, ni base
    await t.db.prepare("DELETE FROM admin_sessions").run();
    await t.db.prepare("DELETE FROM admin_users").run();
    const nu: Env = { ...env, ADMIN_TOKEN: undefined };
    // avant le correctif, cette requête renvoyait 200 et exposait le fichier clients
    expect((await call("GET", "/api/admin/bookings", undefined, { authorization: "" }, nu)).status).toBe(503);
    // Cloudflare Access authentifie en amont : l'en-tête qu'il injecte suffit
    const viaAccess = await call("GET", "/api/admin/bookings", undefined, { "cf-access-jwt-assertion": "jwt-factice" }, nu);
    expect(viaAccess.status).toBe(200);
    // les routes publiques ne sont pas affectées
    expect((await call("GET", "/api/public/today", undefined, {}, nu)).status).toBe(200);
  });

  it("webhook Stripe refusé quand Stripe n'est pas configuré", async () => {
    expect((await call("POST", "/api/webhooks/stripe", { type: "x" })).status).toBe(400);
  });
});

describe("calendriers et multi-biens (v2)", () => {
  it("calendrier public : prix par jour, jour réservé indisponible, liaison propagée", async () => {
    await call("POST", "/api/admin/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, guest: { lastName: "Cal" },
    });
    const month = CHECKIN.slice(0, 7);
    const { status, data } = await call("GET", `/api/public/calendar?property=pre-more&month=${month}`);
    expect(status).toBe(200);
    const byId = new Map((data.units as { unitId: number; days: { date: string; available: boolean; priceCents: number | null }[] }[]).map((u) => [u.unitId, u]));
    const scierieDay = byId.get(2)!.days.find((d) => d.date === CHECKIN)!;
    expect(scierieDay.available).toBe(false);
    expect(scierieDay.priceCents).toBeGreaterThan(0);
    // liaison : le Domaine est indisponible le même jour, et son prix = somme des maisons
    const domaineDay = byId.get(3)!.days.find((d) => d.date === CHECKIN)!;
    expect(domaineDay.available).toBe(false);
    const scieurDay = byId.get(1)!.days.find((d) => d.date === CHECKIN)!;
    expect(scieurDay.available).toBe(true);
    expect(domaineDay.priceCents).toBe((scieurDay.priceCents ?? 0) + (scierieDay.priceCents ?? 0));
  });

  it("rate-calendar admin : tarif jour par jour d'un bien", async () => {
    const to = addDays(CHECKIN, 3);
    const { status, data } = await call("GET", `/api/admin/rate-calendar?unit=2&from=${CHECKIN}&to=${to}`);
    expect(status).toBe(200);
    const days = data.days as { priceCents: number | null; minNights: number | null }[];
    expect(days).toHaveLength(3);
    expect(days[0]!.priceCents).toBeGreaterThan(0);
    expect(days[0]!.minNights).toBeGreaterThanOrEqual(1);
  });

  it("maison C : création avec liaison mutuelle au Domaine, la liaison joue immédiatement", async () => {
    const created = await call("POST", "/api/admin/units", {
      propertyId: 1, name: "Maison C", capacityBase: 4, capacityMax: 6,
      cleaningFeeCents: 8000, priceWeekCents: 10000, priceWeekendCents: 12000,
      linkedUnitIds: [3],
    });
    expect(created.status).toBe(201);
    const unitId = created.data.id as number;
    try {
      const sale = await call("POST", "/api/admin/bookings", {
        unitId, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, guest: { lastName: "TestC" },
      });
      expect(sale.status).toBe(201);
      const avail = await call("GET", `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=2`);
      const units = avail.data.units as { unitId: number; available: boolean }[];
      expect(units.find((u) => u.unitId === 3)!.available).toBe(false); // Domaine bloqué par C
      expect(units.find((u) => u.unitId === 1)!.available).toBe(true); // Scieur libre
      expect(units.find((u) => u.unitId === 2)!.available).toBe(true); // Scierie libre
    } finally {
      // nettoie l'unité de test pour ne pas polluer les autres tests
      for (const sql of [
        "DELETE FROM bookings WHERE unit_id = ?1",
        "DELETE FROM rate_rules WHERE unit_id = ?1",
        "DELETE FROM unit_links WHERE unit_id = ?1 OR blocks_unit_id = ?1",
        "DELETE FROM units WHERE id = ?1",
      ]) {
        await t.db.prepare(sql).bind(unitId).run();
      }
    }
  });

  it("le devis public inclut les frais de ménage réels (Scierie 90 €)", async () => {
    const { data } = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
    });
    const quote = data.quote as { cleaningFeeCents: number; lines: { kind: string; amountCents: number }[] };
    expect(quote.cleaningFeeCents).toBe(9000);
    expect(quote.lines.find((l) => l.kind === "fee")?.amountCents).toBe(9000);
    // et le Domaine cumule 120 + 90 €
    const dom = await call("POST", "/api/public/quote", {
      unitId: 3, checkin: CHECKIN, checkout: CHECKOUT, adults: 12, children: 0,
    });
    expect((dom.data.quote as { cleaningFeeCents: number }).cleaningFeeCents).toBe(21000);
  });
});

describe("Lot 2 — tunnel de réservation", () => {
  const CGV = "CGV Les Gîtes du Pré Moré — version de test. Arrhes 30 %, pas de rétractation (art. VI.53 12° CDE).";

  beforeEach(async () => {
    await t.db
      .prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'cgv_text', ?1)")
      .bind(CGV)
      .run();
  });

  it("régime fiscal 27/07 : draps hors options, taxe absente du devis, horaires 18h/18h", async () => {
    const fiche = await call("GET", "/api/public/properties/pre-more");
    const options = fiche.data.options as { name: string }[];
    expect(options.some((o) => o.name.startsWith("Draps"))).toBe(false);
    expect(options.some((o) => o.name === "Ménage de fin de séjour")).toBe(false);
    expect(options.map((o) => o.name)).toContain("Sauna");
    const settings = fiche.data.settings as { checkinTime: string; checkoutTime: string };
    expect(settings.checkinTime).toBe("18:00");
    expect(settings.checkoutTime).toBe("18:00");

    const quote = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
    });
    const lines = (quote.data.quote as { lines: { kind: string; label: string }[] }).lines;
    expect(lines.some((l) => l.kind === "tax")).toBe(false);
    expect(lines.find((l) => l.kind === "fee")?.label).toBe("Frais généraux — ménage et charges");
  });

  it("expose le texte des CGV et le hold sur la fiche domaine", async () => {
    const res = await call("GET", "/api/public/properties/pre-more");
    expect(res.status).toBe(200);
    expect(res.data.cgvText).toBe(CGV);
    expect((res.data.settings as { holdMinutes: number }).holdMinutes).toBe(30);
  });

  it("refuse une réservation sans acceptation des CGV", async () => {
    const res = await call("POST", "/api/public/bookings", bookingBody(2, { cgvAccepted: undefined }));
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("conditions générales");
  });

  it("trace la preuve d'acceptation : version hashée du texte, horodatage, IP", async () => {
    const res = await call("POST", "/api/public/bookings", bookingBody(2), { "cf-connecting-ip": "203.0.113.7" });
    expect(res.status).toBe(201);
    const row = await t.db
      .prepare("SELECT cgv_version, cgv_accepted_at, cgv_ip FROM bookings WHERE reference = ?1")
      .bind(res.data.reference)
      .first<{ cgv_version: string; cgv_accepted_at: string; cgv_ip: string }>();
    expect(row?.cgv_version).toMatch(/^sha256:[0-9a-f]{16}-len\d+$/);
    expect(row?.cgv_version).toContain(`len${CGV.length}`);
    expect(row?.cgv_accepted_at).toBeTruthy();
    expect(row?.cgv_ip).toBe("203.0.113.7");
  });

  it("opt-in marketing : enregistré avec horodatage, jamais rétrogradé", async () => {
    const first = await call("POST", "/api/public/bookings", bookingBody(2, { marketingOptIn: true }));
    expect(first.status).toBe(201);
    const guest = () =>
      t.db
        .prepare("SELECT marketing_opt_in, marketing_opt_in_at FROM guests WHERE lower(email) = ?1")
        .bind(GUEST.email.toLowerCase())
        .first<{ marketing_opt_in: number; marketing_opt_in_at: string | null }>();
    const after1 = await guest();
    expect(after1?.marketing_opt_in).toBe(1);
    expect(after1?.marketing_opt_in_at).toBeTruthy();

    // une résa ultérieure sans la case ne retire pas le consentement
    const CHECKIN2 = addDays(CHECKOUT, 7);
    const second = await call("POST", "/api/public/bookings", bookingBody(2, { checkin: CHECKIN2, checkout: addDays(CHECKIN2, 7) }));
    expect(second.status).toBe(201);
    const after2 = await guest();
    expect(after2?.marketing_opt_in).toBe(1);
    expect(after2?.marketing_opt_in_at).toBe(after1?.marketing_opt_in_at);
  });

  it("reprise du paiement d'une résa en attente : nouvelle session, l'ancienne soldée", async () => {
    const created = await call("POST", "/api/public/bookings", bookingBody(2));
    expect(created.status).toBe(201);
    const reference = created.data.reference as string;

    const retry = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(retry.status).toBe(200);
    expect(String(retry.data.checkoutUrl)).toContain("/book/dev-pay.html?session=");
    expect(retry.data.holdExpiresAt).toBeTruthy();

    // l'ancien paiement est marqué failed, un seul reste pending
    const booking = await t.db
      .prepare("SELECT id FROM bookings WHERE reference = ?1")
      .bind(reference)
      .first<{ id: number }>();
    const payments = await t.db
      .prepare("SELECT status FROM payments WHERE booking_id = ?1 ORDER BY id")
      .bind(booking?.id)
      .all<{ status: string }>();
    expect(payments.results.map((p) => p.status)).toEqual(["failed", "pending"]);

    // la nouvelle session paie et confirme normalement
    const session = new URL(String(retry.data.checkoutUrl)).searchParams.get("session")!;
    const paid = await call("POST", "/api/public/dev-pay/confirm", { session });
    expect(paid.status).toBe(200);
    const confirmed = await call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`);
    expect((confirmed.data.booking as { status: string }).status).toBe("confirmed");

    // une résa confirmée ne repasse plus par l'acompte : le même endpoint
    // bascule sur le SOLDE (issue #67), couvert en détail par solde.test.ts
    const balance = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(balance.status).toBe(200);
    expect(balance.data.kind).toBe("balance");
    // mauvais email → introuvable
    expect((await call("POST", `/api/public/bookings/${reference}/pay`, { email: "autre@example.com" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Vente téléphone (issue #70) : le devis dit COMBIEN et SI c'est vendable.
// Avant, le devis se calculait sans regarder le planning : on annonçait un
// prix au téléphone sur un créneau déjà pris, et on ne l'apprenait qu'au 409
// de la création — le client encore en ligne.
// ---------------------------------------------------------------------------
describe("vente téléphone — disponibilité vérifiée dans le devis", () => {
  const quoteBody = (unitId: number) => ({
    unitId,
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 4,
    children: 0,
  });

  it("créneau libre : le devis est calculé ET annoncé disponible", async () => {
    const { status, data } = await call("POST", "/api/admin/quote", quoteBody(2));
    expect(status).toBe(200);
    expect((data.quote as { ok: boolean; totalCents: number }).ok).toBe(true);
    const availability = data.availability as { available: boolean; conflicts: unknown[] };
    expect(availability.available).toBe(true);
    expect(availability.conflicts).toEqual([]);
  });

  it("créneau pris : le devis se calcule toujours, mais le conflit est NOMMÉ", async () => {
    const created = await call("POST", "/api/public/bookings", bookingBody(2));
    expect(created.status).toBe(201);
    const reference = created.data.reference as string;

    const { status, data } = await call("POST", "/api/admin/quote", quoteBody(2));
    expect(status).toBe(200);
    // Le prix reste calculable — c'est la disponibilité qui change de camp.
    expect((data.quote as { ok: boolean }).ok).toBe(true);
    const availability = data.availability as {
      available: boolean;
      conflicts: { reference: string; unitName: string; viaLink: boolean; status: string }[];
    };
    expect(availability.available).toBe(false);
    expect(availability.conflicts).toHaveLength(1);
    expect(availability.conflicts[0]!.reference).toBe(reference);
    expect(availability.conflicts[0]!.unitName).toBe("La Scierie");
    expect(availability.conflicts[0]!.viaLink).toBe(false);
  });

  it("même règle de liaison que le public : la Scierie prise ferme le Domaine entier", async () => {
    const created = await call("POST", "/api/public/bookings", bookingBody(2));
    expect(created.status).toBe(201);

    const { data } = await call("POST", "/api/admin/quote", { ...quoteBody(3), adults: 12 });
    const availability = data.availability as {
      available: boolean;
      conflicts: { unitName: string; viaLink: boolean }[];
    };
    expect(availability.available).toBe(false);
    expect(availability.conflicts[0]!.viaLink).toBe(true);
    expect(availability.conflicts[0]!.unitName).toBe("La Scierie");

    // ... et l'autre maison, elle, reste vendable
    const libre = await call("POST", "/api/admin/quote", quoteBody(1));
    expect((libre.data.availability as { available: boolean }).available).toBe(true);
  });

  it("l'affichage n'est qu'une annonce : la création reste refusée en 409", async () => {
    await call("POST", "/api/public/bookings", bookingBody(2));
    const sale = await call("POST", "/api/admin/bookings", {
      ...quoteBody(2),
      guest: { lastName: "Vandenberghe", firstName: "Sophie", phone: "+32 470 11 22 33" },
      confirmNow: true,
      generatePaymentLink: false,
    });
    expect(sale.status).toBe(409);
    expect(String(sale.data.error)).toContain("indisponible");
  });

  it("une option expirée ne bloque plus rien : le devis redevient disponible", async () => {
    const created = await call("POST", "/api/public/bookings", bookingBody(2));
    const reference = created.data.reference as string;
    // On périme le hold à la main — c'est exactement ce que fait le cron.
    await t.db
      .prepare("UPDATE bookings SET hold_expires_at = '2020-01-01 00:00:00' WHERE reference = ?1")
      .bind(reference)
      .run();
    const { data } = await call("POST", "/api/admin/quote", quoteBody(2));
    expect((data.availability as { available: boolean }).available).toBe(true);
  });
});
