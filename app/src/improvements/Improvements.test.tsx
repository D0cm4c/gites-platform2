// Bouton « Amélioration ? » (toutes les pages) et écran de suivi
// (Réglages › Améliorations).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/render";
import { setWide } from "../test/setup";
import type { Call } from "../test/fakeApi";
import { csvCell, improvementsCsv } from "./csv";
import type { Improvement } from "./types";

const ROW = (id: number, over: Partial<Improvement> = {}): Improvement => ({
  id, createdAt: "2026-10-11 09:00:00", updatedAt: "2026-10-11 09:00:00", author: "arnold", pagePath: "/reglages/tarifs", pageTitle: "Prix et saisons",
  text: `Remarque ${id}`, status: "nouveau", adminNote: null, userAgent: null, viewportWidth: 390, ...over,
});

function handlers(rows: Improvement[]) {
  const counts = () => ({ nouveau: rows.filter((r) => r.status === "nouveau").length, en_cours: rows.filter((r) => r.status === "en_cours").length, fait: rows.filter((r) => r.status === "fait").length, ecarte: rows.filter((r) => r.status === "ecarte").length });
  return [
    (c: Call) => {
      if (c.path === "/improvements" && c.method === "GET") {
        const list = c.query.status ? rows.filter((r) => r.status === c.query.status) : rows;
        return { body: { improvements: [...list].sort((a, b) => b.id - a.id), counts: counts() } };
      }
      if (c.path === "/improvements" && c.method === "POST") {
        const b = c.body as { text: string; pagePath: string; pageTitle: string };
        const row = ROW(rows.length + 1, { text: b.text, pagePath: b.pagePath, pageTitle: b.pageTitle });
        rows.push(row);
        return { body: { ok: true, improvement: row } };
      }
      const m = /^\/improvements\/(\d+)$/.exec(c.path);
      if (m && c.method === "PATCH") {
        const row = rows.find((r) => r.id === Number(m[1]))!;
        const b = c.body as { status?: Improvement["status"]; adminNote?: string | null };
        if (b.status) row.status = b.status;
        if (b.adminNote !== undefined) row.adminNote = b.adminNote;
        return { body: { ok: true, improvement: row } };
      }
      return undefined;
    },
  ];
}

beforeEach(() => setWide(true));
afterEach(() => vi.unstubAllGlobals());

describe("bouton « Amélioration ? »", () => {
  it("présent sur une page, retient la page, envoie et remercie", async () => {
    const user = userEvent.setup();
    const rows: Improvement[] = [];
    const { calls } = renderApp("/reglages/aide", handlers(rows));
    await user.click(await screen.findByRole("button", { name: /Amélioration souhaitée/ }));
    const dialog = await screen.findByRole("dialog");
    // rappel discret de la page, rempli tout seul
    expect(within(dialog).getByTestId("amel-page")).toHaveTextContent("Page : Comment ça marche (/reglages/aide)");
    const send = within(dialog).getByRole("button", { name: "Envoyer" });
    expect(send).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "Le texte est trop petit");
    await user.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/improvements")).toBe(true));
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: "Le texte est trop petit", pagePath: "/reglages/aide", pageTitle: "Comment ça marche" });
    expect(await screen.findByText("Merci, c'est noté.")).toBeInTheDocument();
  });

  it("au téléphone aussi, et la fenêtre se ferme à Échap", async () => {
    setWide(false);
    const user = userEvent.setup();
    renderApp("/messages", handlers([]));
    const fab = await screen.findByRole("button", { name: /Amélioration souhaitée/ });
    expect(fab).toHaveClass("amel-B");
    await user.click(fab);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("une erreur du serveur s'affiche, la remarque reste saisie", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/aide", [(c: Call) => (c.path === "/improvements" && c.method === "POST" ? { status: 400, body: { error: "la remarque est trop courte" } } : undefined), ...handlers([])]);
    await user.click(await screen.findByRole("button", { name: /Amélioration souhaitée/ }));
    const box = await screen.findByRole("textbox");
    await user.type(box, "abcd");
    await user.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText(/trop courte/)).toBeInTheDocument();
    expect(box).toHaveValue("abcd");
  });
});

describe("écran Améliorations", () => {
  it("liste, filtre par statut, badge du nombre de « nouveau » dans le menu", async () => {
    const user = userEvent.setup();
    const rows = [ROW(1), ROW(2, { status: "fait", text: "Déjà réglé" }), ROW(3, { text: "<img src=x onerror=alert(1)>" })];
    renderApp("/reglages/ameliorations", handlers(rows));
    expect(await screen.findByText("Remarque 1")).toBeInTheDocument();
    // le HTML reste du texte
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
    // badge : 2 nouveaux
    const link = screen.getByRole("link", { name: /Améliorations.*2 nouvelles/ });
    expect(link).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fait (1)" }));
    expect(screen.getByText("Déjà réglé")).toBeInTheDocument();
    expect(screen.queryByText("Remarque 1")).not.toBeInTheDocument();
  });

  it("fiche : texte, page cliquable, statut et note enregistrés", async () => {
    const user = userEvent.setup();
    const rows = [ROW(1, { text: "Le bouton est trop petit" })];
    const { calls, router } = renderApp("/reglages/ameliorations", handlers(rows));
    await user.click(await screen.findByRole("button", { name: /Le bouton est trop petit/ }));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByRole("link", { name: "Prix et saisons" })).toHaveAttribute("href", "#/reglages/tarifs");
    const save = within(panel).getByRole("button", { name: "Enregistrer" });
    expect(save).toBeDisabled();
    await user.type(within(panel).getByLabelText(/Note interne/), "À voir lundi");
    await user.click(within(panel).getByLabelText("Statut"));
    await user.click(await screen.findByRole("option", { name: "En cours", hidden: true }));
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "en_cours", adminNote: "À voir lundi" });
    expect(router.state.location.pathname).toBe("/reglages/ameliorations");
  });

  it("aucune remarque : message clair", async () => {
    renderApp("/reglages/ameliorations", handlers([]));
    expect(await screen.findByText("Aucune remarque pour l'instant")).toBeInTheDocument();
  });
});

describe("export CSV", () => {
  it("neutralise les formules et double les guillemets", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell('dit "oui"')).toBe(`"dit ""oui"""`);
    expect(csvCell(null)).toBe('""');
    const csv = improvementsCsv([ROW(1, { text: "@cmd\nligne 2" })], ["A", "B"], (s) => s);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`"'@cmd\nligne 2"`);
  });
});
