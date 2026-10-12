// Règle de Julien (12/10/2026) : tout mail lié à une réservation porte sa
// référence EN TÊTE de l'objet, entre crochets — jamais le nom du client.
import { describe, expect, it } from "vitest";
import { buildBalanceReminderEmail, buildCancellationEmail, buildContactAckEmail, buildPaymentLinkEmail, buildPaymentReceiptEmail, refSubject } from "../src/services/email";
import type { BookingRow, PropertyRow } from "../src/db/repo";

const property = { name: "Les Gîtes du Pré Moré", contactEmail: "lesgitesdupremore@gmail.com" } as PropertyRow;
const booking = (lang: string) =>
  ({ reference: "PM-2026-123", guestName: "Camille Dupont", guestLang: lang, unitName: "La Scierie", checkin: "2026-11-11", checkout: "2026-11-14", adults: 2, children: 0, totalCents: 70000, paidCents: 35000, balanceDueDate: "2026-10-12", quoteJson: null }) as unknown as BookingRow;

describe("objets des mails", () => {
  for (const lang of ["fr", "nl"]) {
    it(`[${lang}] la référence ouvre l'objet, le nom du client n'y est jamais`, () => {
      const b = booking(lang);
      const subjects = [
        buildPaymentLinkEmail(b, property, "Solde", 35000, "http://x/v").subject,
        buildPaymentReceiptEmail(b, property, { kind: "deposit", amountCents: 35000 }).subject,
        buildBalanceReminderEmail(b, property, "http://x/v").subject,
        buildCancellationEmail(b, property, { par: "locataire", keptCents: 0, refundCents: 0, indemnityCents: 0 }).subject,
        buildContactAckEmail({ reference: b.reference, propertyName: property.name, guestName: "Camille Dupont", message: "Bonjour", nl: lang === "nl" }).subject,
      ];
      for (const s of subjects) {
        expect(s.startsWith("[PM-2026-123] ")).toBe(true);
        expect(s).not.toContain("Camille");
        expect(s).not.toMatch(/[\r\n]/);
      }
    });
  }
  it("refSubject neutralise les retours à la ligne", () => {
    expect(refSubject("PM-2026-1", "a\r\nBcc: x@y.z")).not.toMatch(/[\r\n]/);
  });
  it("l'accusé de réception cite le message en texte brut et invite à répondre", () => {
    const m = buildContactAckEmail({ reference: "QU-2026-0001", propertyName: "X", guestName: null, message: "ligne 1\nligne 2 <b>gras</b>" });
    expect(m.bodyText).toContain("> ligne 1\n> ligne 2 <b>gras</b>");
    expect(m.bodyText).toContain("Répondez simplement à cet e-mail");
  });
});
