// Encaissements Stripe par propriété : ce qui est arrivé (via le webhook) sur le
// compte Stripe de chaque propriété, avec les frais réels quand Stripe les a
// donnés, le net, un total par mois et un export CSV (pour la comptabilité).
//
// Rien n'est recalculé ici : les lignes sont celles de `payments`
// (method = 'stripe', status = 'succeeded'). Les frais et le net viennent de
// `payments.stripe_fee_cents` / `stripe_net_cents` (migration 0030), relevés
// chez Stripe après l'encaissement ; NULL = inconnus (affichés comme tels, jamais
// estimés).

import { fetchPaymentFees } from "./stripe";
import { resolveStripeConfig } from "./stripe-config";

export interface Encaissement {
  paymentId: number;
  receivedAt: string;
  bookingId: number;
  bookingReference: string;
  kind: string;
  amountCents: number;
  feeCents: number | null;
  netCents: number | null;
  status: string;
  stripeRef: string | null;
}

export interface EncaissementMonth {
  month: string; // AAAA-MM
  count: number;
  grossCents: number;
  feeCents: number;
  /** Somme des nets CONNUS ; `unknownFees` dit combien de lignes n'en ont pas encore. */
  netCents: number;
  unknownFees: number;
}

export interface EncaissementsReport {
  propertyId: number;
  from: string | null;
  to: string | null;
  rows: Encaissement[];
  months: EncaissementMonth[];
  totals: { count: number; grossCents: number; feeCents: number; netCents: number; unknownFees: number };
}

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Borne de date AAAA-MM-JJ valide, sinon null. */
function isoOrNull(v: string | null | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export async function listEncaissements(
  db: D1Database,
  propertyId: number,
  range: { from?: string | null; to?: string | null } = {},
): Promise<EncaissementsReport> {
  const from = isoOrNull(range.from);
  const to = isoOrNull(range.to);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.booking_id, p.kind, p.amount_cents, p.status, p.received_at, p.created_at,
              p.stripe_fee_cents, p.stripe_net_cents, p.stripe_payment_intent, p.stripe_session_id,
              b.reference AS booking_reference
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = ?1 AND p.method = 'stripe' AND p.status = 'succeeded'
          AND (?2 IS NULL OR date(COALESCE(p.received_at, p.created_at)) >= ?2)
          AND (?3 IS NULL OR date(COALESCE(p.received_at, p.created_at)) <= ?3)
        ORDER BY COALESCE(p.received_at, p.created_at) DESC, p.id DESC
        LIMIT 5000`,
    )
    .bind(propertyId, from, to)
    .all();
  const rows: Encaissement[] = (results as Raw[]).map((r) => {
    const sign = r.kind === "refund" ? -1 : 1;
    const amount = sign * Math.abs(num(r.amount_cents));
    const fee = numOrNull(r.stripe_fee_cents);
    const net = numOrNull(r.stripe_net_cents);
    return {
      paymentId: num(r.id),
      receivedAt: String(r.received_at ?? r.created_at ?? ""),
      bookingId: num(r.booking_id),
      bookingReference: String(r.booking_reference ?? ""),
      kind: String(r.kind),
      amountCents: amount,
      feeCents: fee,
      netCents: net,
      status: String(r.status),
      stripeRef: (r.stripe_payment_intent as string | null) ?? (r.stripe_session_id as string | null) ?? null,
    };
  });

  const byMonth = new Map<string, EncaissementMonth>();
  const totals = { count: 0, grossCents: 0, feeCents: 0, netCents: 0, unknownFees: 0 };
  for (const r of rows) {
    const key = r.receivedAt.slice(0, 7);
    const m = byMonth.get(key) ?? { month: key, count: 0, grossCents: 0, feeCents: 0, netCents: 0, unknownFees: 0 };
    m.count += 1;
    m.grossCents += r.amountCents;
    if (r.feeCents === null || r.netCents === null) m.unknownFees += 1;
    else {
      m.feeCents += r.feeCents;
      m.netCents += r.netCents;
    }
    byMonth.set(key, m);
  }
  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  for (const m of months) {
    totals.count += m.count;
    totals.grossCents += m.grossCents;
    totals.feeCents += m.feeCents;
    totals.netCents += m.netCents;
    totals.unknownFees += m.unknownFees;
  }
  return { propertyId, from, to, rows, months, totals };
}

function csvCell(v: string): string {
  // Neutralise l'injection de formule (tableur) en plus du quoting CSV.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const euros = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/** CSV à la française (séparateur « ; », virgule décimale, BOM pour Excel). */
export function encaissementsCsv(report: EncaissementsReport): string {
  const head = ["Date", "Réservation", "Type", "Brut (EUR)", "Frais Stripe (EUR)", "Net (EUR)", "Statut", "Référence Stripe"];
  const lines = [head.join(";")];
  for (const r of report.rows) {
    lines.push(
      [
        csvCell(r.receivedAt), csvCell(r.bookingReference), csvCell(r.kind),
        // Montants : numériques, un remboursement est négatif (« -12,00 ») et ne doit
        // surtout pas être préfixé par la neutralisation de formule du texte.
        euros(r.amountCents), euros(r.feeCents), euros(r.netCents),
        csvCell(r.status), csvCell(r.stripeRef ?? ""),
      ].join(";"),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Relève chez Stripe les frais des encaissements qui n'en ont pas encore
 *  (Bancontact ne les donne parfois que plus tard). Au plus `limit` lignes par
 *  passage. Rend le nombre de lignes complétées et le nombre restant inconnu. */
export async function backfillFees(
  db: D1Database,
  env: Env,
  propertyId: number,
  limit = 40,
): Promise<{ updated: number; stillUnknown: number }> {
  const cfg = await resolveStripeConfig(db, env, propertyId);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.stripe_payment_intent AS pi
         FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = ?1 AND p.method = 'stripe' AND p.status = 'succeeded'
          AND p.stripe_fee_cents IS NULL AND p.stripe_payment_intent LIKE 'pi_%' AND p.stripe_payment_intent <> 'pi_stub'
        ORDER BY p.id DESC LIMIT ?2`,
    )
    .bind(propertyId, limit)
    .all<{ id: number; pi: string }>();
  let updated = 0;
  for (const row of results) {
    const fees = await fetchPaymentFees(cfg, row.pi);
    if (!fees) continue;
    await setPaymentFees(db, row.id, fees.feeCents, fees.netCents);
    updated += 1;
  }
  const left = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = ?1 AND p.method = 'stripe' AND p.status = 'succeeded' AND p.stripe_fee_cents IS NULL`,
    )
    .bind(propertyId)
    .first<{ n: number }>();
  return { updated, stillUnknown: Number(left?.n ?? 0) };
}

export async function setPaymentFees(db: D1Database, paymentId: number, feeCents: number, netCents: number): Promise<void> {
  await db
    .prepare("UPDATE payments SET stripe_fee_cents = ?2, stripe_net_cents = ?3 WHERE id = ?1")
    .bind(paymentId, feeCents, netCents)
    .run();
}
