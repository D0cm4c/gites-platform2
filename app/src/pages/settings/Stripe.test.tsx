// Réglages › Comptes Stripe et Encaissements Stripe : un compte par propriété.
// Les clés ne sont jamais relues en clair, seules les zones remplies partent à
// l'enregistrement, et l'adresse du webhook de chaque propriété est affichée.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

const KEY = { set: false, setAt: null, hint: null };
const STRIPE = {
  baseUrl: "https://reservations.example",
  events: ["checkout.session.completed", "payment_intent.succeeded"],
  envFallback: { secret: false, publishable: false, webhook: false, mode: null },
  properties: [
    { propertyId: 1, name: "Les Gîtes du Pré Moré", slug: "pre-more", mode: "test", accountLabel: null, secret: { set: true, setAt: "2026-10-11 09:00:00", hint: null }, publishable: KEY, webhook: KEY, effective: "property", webhookPath: "/api/webhooks/stripe/1", updatedBy: "julien", updatedAt: "2026-10-11 09:00:00" },
    { propertyId: 2, name: "Le Moulin de Braives", slug: "moulin-braives", mode: "test", accountLabel: null, secret: KEY, publishable: KEY, webhook: KEY, effective: "none", webhookPath: "/api/webhooks/stripe/2", updatedBy: null, updatedAt: null },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const handlers = [(c: { path: string; method: string }) => (c.path === "/stripe" && c.method === "GET" ? { body: STRIPE } : undefined)];

describe("Comptes Stripe", () => {
  it("une section par propriété, avec l'adresse de son webhook, sans jamais afficher une clé", async () => {
    renderApp("/reglages/stripe", handlers);
    expect(await screen.findByRole("heading", { name: "Les Gîtes du Pré Moré" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Le Moulin de Braives" })).toBeInTheDocument();
    expect(screen.getByTestId("webhook-url-1")).toHaveTextContent("https://reservations.example/api/webhooks/stripe/1");
    expect(screen.getByTestId("webhook-url-2")).toHaveTextContent("https://reservations.example/api/webhooks/stripe/2");
    // La clé posée ne se reconnaît qu'à sa date : aucun caractère de la clé n'est montré.
    expect(screen.getByText(/posée le 11\/10\/2026/)).toBeInTheDocument();
    expect(screen.getAllByText("checkout.session.completed").length).toBe(2);
    expect(document.body.textContent).not.toMatch(/sk_(test|live)_[A-Za-z0-9]{6,}/);
  });

  it("n'envoie que les champs remplis, puis vide les zones", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/stripe", [
      ...handlers,
      (c) => (c.path === "/stripe/2" && c.method === "PUT" ? { body: { ok: true } } : undefined),
    ]);
    await screen.findByRole("heading", { name: "Le Moulin de Braives" });
    const secretFields = screen.getAllByLabelText(/Clé secrète/);
    await user.type(secretFields[1]!, "sk_test_MOULIN0002");
    const save = screen.getAllByRole("button", { name: "Enregistrer" })[1]!;
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/stripe/2")).toBe(true));
    const body = calls.find((c) => c.path === "/stripe/2")!.body as Record<string, string>;
    expect(body.secretKey).toBe("sk_test_MOULIN0002");
    expect(body.publishableKey).toBeUndefined();
    expect(body.webhookSecret).toBeUndefined();
    expect(body.mode).toBe("test");
    await waitFor(() => expect((screen.getAllByLabelText(/Clé secrète/)[1] as HTMLInputElement).value).toBe(""));
  });

  it("Retirer les clés demande confirmation, puis envoie trois champs vides", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/stripe", [
      ...handlers,
      (c) => (c.path === "/stripe/1" && c.method === "PUT" ? { body: { ok: true } } : undefined),
    ]);
    await screen.findByRole("heading", { name: "Les Gîtes du Pré Moré" });
    await user.click(screen.getByRole("button", { name: "Retirer les clés de cette propriété" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Retirer les clés" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/stripe/1")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ secretKey: "", publishableKey: "", webhookSecret: "" });
  });

  it("Tester la clé dit en clair ce que Stripe répond", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/stripe", [
      ...handlers,
      (c) => (c.path === "/stripe/1/test" ? { body: { ok: false, error: "Invalid API Key provided" } } : undefined),
    ]);
    await screen.findByRole("heading", { name: "Les Gîtes du Pré Moré" });
    await user.click(screen.getAllByRole("button", { name: "Tester la clé" })[0]!);
    expect(await screen.findByText("Invalid API Key provided")).toBeInTheDocument();
  });
});

describe("Encaissements Stripe", () => {
  const report = {
    propertyId: 1,
    rows: [{ paymentId: 5, receivedAt: "2026-10-09 14:30:00", bookingId: 7, bookingReference: "PM-2026-007", kind: "deposit", amountCents: 100500, feeCents: 1812, netCents: 98688, status: "succeeded", stripeRef: "pi_1" }],
    months: [{ month: "2026-10", count: 1, grossCents: 100500, feeCents: 1812, netCents: 98688, unknownFees: 0 }],
    totals: { count: 1, grossCents: 100500, feeCents: 1812, netCents: 98688, unknownFees: 0 },
  };
  it("liste les paiements, le total par mois et propose l'export CSV", async () => {
    renderApp("/reglages/encaissements", [(c) => (c.path === "/encaissements" ? { body: { report } } : undefined)]);
    expect(await screen.findByText("PM-2026-007")).toBeInTheDocument();
    expect(screen.getByText("2026-10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exporter en CSV/ })).toBeInTheDocument();
    // Frais connus : pas de bouton de relevé.
    expect(screen.queryByRole("button", { name: /Relever les frais/ })).toBeNull();
  });
});
