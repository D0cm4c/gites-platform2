// Générateur PDF (src/core/pdf.ts) : structure valide, accents, pagination,
// tableaux, texte hostile. Les offsets et longueurs sont recomptés par le
// lecteur de test (test/helpers/pdf-lire.ts), pas par le générateur.
import { describe, expect, it } from "vitest";
import { PdfDocument, textWidth } from "../src/core/pdf";
import { pdfPageCount, pdfPagesText, pdfStructureProblems, pdfText } from "./helpers/pdf-lire";

const FIXED = new Date("2026-10-11T08:00:00Z");

describe("PdfDocument", () => {
  it("un document court est un PDF valide d'une page", () => {
    const doc = new PdfDocument({ title: "Essai", date: FIXED, footer: "Pied" });
    doc.heading("Titre", 1);
    doc.paragraph("Bonjour le monde.");
    const bytes = doc.build();
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe("%PDF-1.4");
    expect(pdfStructureProblems(bytes)).toEqual([]);
    expect(pdfPageCount(bytes)).toBe(1);
    expect(pdfText(bytes)).toContain("Bonjour le monde.");
    expect(pdfText(bytes)).toContain("Page 1 / 1");
    expect(pdfText(bytes)).toContain("Pied");
  });

  it("accents, guillemets, tirets et euro passent par WinAnsi", () => {
    const doc = new PdfDocument({ title: "Accents" });
    doc.paragraph("Réservation « confirmée » à Daverdisse — 1 234,56 € · l’été, œuvre, ç, ñ");
    const text = pdfText(doc.build());
    expect(text).toContain("Réservation « confirmée » à Daverdisse — 1 234,56 € · l’été, œuvre, ç, ñ");
  });

  it("≥ et ≤ (absents de WinAnsi) sont écrits >= et <=", () => {
    const doc = new PdfDocument({ title: "Signes" });
    doc.paragraph("Long séjour ≥ 7 nuits, groupe ≤ 6");
    expect(pdfText(doc.build())).toContain("Long séjour >= 7 nuits, groupe <= 6");
  });

  it("un caractère que la police ne sait pas dessiner devient « ? », jamais un fichier cassé", () => {
    const doc = new PdfDocument({ title: "Chinois" });
    doc.paragraph("Nom : 山田 (test)");
    const bytes = doc.build();
    expect(pdfStructureProblems(bytes)).toEqual([]);
    expect(pdfText(bytes)).toContain("Nom : ?? (test)");
  });

  it("parenthèses, antislash et chevrons dans le texte ne cassent rien", () => {
    const doc = new PdfDocument({ title: "Hostile (a) \\ <b>" });
    doc.paragraph("a ) ( \\ << >> /Type /Page endstream endobj %%EOF");
    const bytes = doc.build();
    expect(pdfStructureProblems(bytes)).toEqual([]);
    expect(pdfPageCount(bytes)).toBe(1);
    expect(pdfText(bytes)).toContain("a ) ( \\ << >> /Type /Page endstream endobj %%EOF");
  });

  it("pagination : un long texte passe sur plusieurs pages, numérotées, sans ligne hors marges", () => {
    const doc = new PdfDocument({ title: "Long", footer: "Pied" });
    for (let i = 0; i < 60; i += 1) doc.paragraph(`Paragraphe ${i} — ${"mot ".repeat(40)}`);
    const bytes = doc.build();
    const n = pdfPageCount(bytes);
    expect(n).toBeGreaterThan(2);
    expect(pdfStructureProblems(bytes)).toEqual([]);
    const pages = pdfPagesText(bytes);
    expect(pages).toHaveLength(n);
    expect(pages[0]).toContain(`Page 1 / ${n}`);
    expect(pages[n - 1]).toContain(`Page ${n} / ${n}`);
    // aucun paragraphe perdu
    const all = pdfText(bytes);
    for (let i = 0; i < 60; i += 1) expect(all).toContain(`Paragraphe ${i} —`);
  });

  it("le retour à la ligne respecte la largeur et coupe un mot trop long", () => {
    const doc = new PdfDocument({ title: "Largeur" });
    const lines = doc.wrap(`${"x".repeat(300)} fin`, 10, false, doc.contentWidth);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(doc.contentWidth + 0.01);
    expect(lines.join("").replace(/ /g, "")).toBe(`${"x".repeat(300)}fin`);
  });

  it("tableau : en-tête répété à chaque page, lignes entières, total en dernière ligne", () => {
    const doc = new PdfDocument({ title: "Tableau" });
    const rows = Array.from({ length: 90 }, (_, i) => [`Ligne ${i}`, `${i},00 €`]);
    rows.push(["Total", "999,00 €"]);
    doc.table(rows, { header: ["Désignation", "Montant"], columns: [{ width: 75 }, { width: 25, align: "right" }], totalRow: true });
    const bytes = doc.build();
    const pages = pdfPagesText(bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p).toContain("Désignation");
    expect(pdfText(bytes)).toContain("999,00 €");
    expect(pdfStructureProblems(bytes)).toEqual([]);
  });

  it("une cellule de tableau multiligne grandit la ligne au lieu de déborder", () => {
    const doc = new PdfDocument({ title: "Cellule" });
    doc.table([["A", `${"phrase longue ".repeat(30)}`]], { columns: [{ width: 20 }, { width: 80 }] });
    const text = pdfText(doc.build());
    expect(text.replace(/\s+/g, " ")).toContain("phrase longue phrase longue");
  });

  it("les métadonnées sont en UTF-16 et la date est celle fournie", () => {
    const doc = new PdfDocument({ title: "Contrat été", author: "Gîtes", date: FIXED });
    const raw = new TextDecoder("latin1").decode(doc.build());
    expect(raw).toContain("/CreationDate (D:20261011080000Z)");
    expect(raw).toMatch(/\/Title <feff[0-9a-f]+>/);
  });
});
