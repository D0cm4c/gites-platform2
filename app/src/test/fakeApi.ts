// Fausse API admin pour les essais d'écran : un jeu de données fixe (noms
// inventés) et un journal des appels pour vérifier ce que l'écran envoie.
import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

type Handler = (c: Call) => { status?: number; body: unknown } | undefined;

const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

export const UNITS = [
  { id: 1, propertyId: 1, name: "La Maison du Scieur", capacityBase: 10, capacityMax: 11, isComposite: false, compositePricing: "own", active: true, sortOrder: 1, cleaningFeeCents: 12000 },
  { id: 2, propertyId: 1, name: "La Scierie", capacityBase: 6, capacityMax: 8, isComposite: false, compositePricing: "own", active: true, sortOrder: 2, cleaningFeeCents: 9000 },
];

export const BOOKING = {
  id: 7,
  reference: "PM-2026-007",
  unitId: 1,
  unitName: "La Maison du Scieur",
  propertyId: 1,
  guestId: 3,
  guestName: "Gwenola Oudewaeter",
  guestEmail: "oudewaeter@example.com",
  checkin: "2026-10-23",
  checkout: "2026-10-30",
  adults: 9,
  children: 0,
  status: "confirmed",
  holdExpiresAt: null,
  source: "manual",
  channelLabel: null,
  totalCents: 201000,
  depositCents: 100500,
  paidCents: 100500,
  balanceDueDate: "2026-09-23",
  internalNotes: null,
  guestNotes: null,
  cancelReason: null,
  createdAt: "2026-09-01 10:00:00",
};

export function makeFakeApi(extra: Handler[] = []) {
  const calls: Call[] = [];
  const handlers: Handler[] = [
    ...extra,
    (c) => (c.path === "/properties" ? { body: { properties: [{ id: 1, slug: "pre-more", name: "Les Gîtes du Pré Moré", commune: "Daverdisse", contactPhone: null, contactEmail: null }] } } : undefined),
    (c) => (c.path === "/units" ? { body: { units: UNITS, links: [] } } : undefined),
    (c) => (c.path === "/settings" ? { body: { settings: { checkinTime: "16:00", checkoutTime: "10:00", depositPct: 50, balanceDueDays: 30, holdMinutes: 4320 } } } : undefined),
    (c) =>
      c.path === "/planning"
        ? {
            body: {
              from: c.query.from,
              to: c.query.to,
              units: UNITS,
              bookings: [
                { id: 7, reference: "PM-2026-007", unitId: 1, checkin: "2026-10-23", checkout: "2026-10-30", status: "confirmed", source: "manual", channelLabel: null, guestName: "Gwenola Oudewaeter", persons: 9, isComposite: false, paidState: "acompte", balanceCents: 100500 },
              ],
              blocks: [],
              manualBlocks: [],
            },
          }
        : undefined,
    (c) =>
      c.path === "/rate-calendar"
        ? {
            body: {
              units: UNITS.map((u) => ({
                unit: { id: u.id, name: u.name, editable: true, priceMinCents: null, priceMaxCents: null },
                days: days(c.query.from ?? "2026-10-01", 60).map((date) => ({
                  date,
                  priceCents: u.id === 1 ? 18000 : 12000,
                  source: "base",
                  minNights: 2,
                  weekend: false,
                  holidayRated: false,
                  fallbackPriceCents: null,
                  overridePriceCents: null,
                  overrideMinNights: null,
                })),
              })),
            },
          }
        : undefined,
    (c) => (c.path === "/messages" ? { body: { messages: [] } } : undefined),
    (c) => (c.path === "/overview" ? { body: { property: { id: 1, name: "x" }, today: "2026-10-10", kpis: { balanceDueTotalCents: 0, balanceDueCount: 0 }, alerts: { overdueBalances: [], activeHolds: [], newEmails: 0 } } } : undefined),
    (c) => (c.path === "/bookings/7" && c.method === "GET" ? { body: { booking: BOOKING, payments: [], emails: [], history: [] } } : undefined),
    (c) => (c.path === "/guests/3" ? { body: { guest: { id: 3, email: "oudewaeter@example.com", firstName: "Gwenola", lastName: "Oudewaeter", phone: "+32 470 00 01 05" } } } : undefined),
    // Simulation d'annulation : le plan que calcule le serveur (arrhes 300 €, solde 700 € payés).
    (c) => {
      const body = c.body as { simuler?: boolean; par?: string } | undefined;
      if (c.method !== "POST" || !/^\/bookings\/\d+\/cancel$/.test(c.path) || !body?.simuler) return undefined;
      const owner = body.par === "proprietaire";
      return {
        body: {
          ok: true,
          simule: true,
          plan: {
            mode: "arrhes", par: owner ? "proprietaire" : "locataire", paidCents: 100000, arrhesCents: 30000,
            keptCents: owner ? 0 : 30000, refundCents: owner ? 100000 : 70000,
            stripeRefunds: [], stripeRefundCents: owner ? 100000 : 70000, manualRefundCents: 0,
            indemnityCents: owner ? 30000 : 0, forceMajeure: false, sejourEntame: false, note: "",
          },
        },
      };
    },
    (c) => (c.method !== "GET" ? { body: { ok: true, refunds: [] } } : undefined),
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/admin/, "");
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "route inconnue" }), { status: 404 });
  });
  return { calls, fetchMock };
}
