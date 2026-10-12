// Annulation d'une réservation et sort de l'argent (CGV v3.1, articles 4 et 5).
//
// Règle (décisions de Julien, 12/10/2026, la seconde après lecture de l'art.
// VI.83, 27° du CDE) : seule indemnité, celle de l'exploitant qui annule.
//  - le CLIENT annule (`par: "locataire"`, nom d'API inchangé) : les arrhes
//    restent acquises à l'exploitant (5.2) ; ce qui a été payé au-delà des
//    arrhes (le solde) est remboursé sous 14 jours, sur le moyen de paiement
//    utilisé (Stripe quand il a été payé par Stripe) ;
//  - l'EXPLOITANT annule (`par: "proprietaire"`) : tout ce qui a été payé,
//    arrhes comprises, est remboursé sous 14 jours (5.3), et il verse en outre
//    une indemnité égale aux arrhes réellement reçues. L'indemnité ne passe PAS
//    par Stripe (un remboursement ne dépasse jamais l'encaissé) : c'est un
//    virement à faire à la main, consigné au journal (`refund.manual_due`) ;
//  - force majeure (5.4), quelle que soit la partie : tout est remboursé,
//    sans indemnité ;
//  - non-présentation ou séjour entamé (5.5, client) : le prix du séjour
//    n'est pas remboursé, un trop-perçu l'est ;
//  - option non payée : rien à rembourser ;
//  - réservation d'un canal (Airbnb, Booking) ou importée : aucun mouvement
//    d'argent par nous.
//
// Ce fichier calcule le plan (pur : lit la base, n'écrit rien) puis exécute les
// remboursements Stripe. Les montants sont des cents entiers, jamais d'arrondi.

import { sqlNow } from "../core/dates";
import { addPayment, audit, listPayments, markPaymentStatus, recomputePaid, type BookingRow, type PaymentRow } from "../db/repo";
import { createRefund, findRefundForRow, stripeEnabled, type StripeConfig } from "./stripe";

export type AnnulationPar = "locataire" | "proprietaire";

export interface StripeRefundLine {
  /** Paiement d'origine (payments.id) et son PaymentIntent. */
  paymentId: number;
  paymentIntent: string;
  amountCents: number;
}

export interface CancellationPlan {
  par: AnnulationPar;
  mode: "canal" | "sans_paiement" | "arrhes";
  /** Net déjà payé (paiements réussis moins remboursements déjà faits). */
  paidCents: number;
  /** Arrhes de la réservation, au pourcentage figé dans le devis (voir contractualArrhes). */
  arrhesCents: number;
  /** Somme conservée par l'exploitant (arrhes, ou prix du séjour entamé). */
  keptCents: number;
  /** Total à rendre sur ce qui a été payé = Stripe + à la main. */
  refundCents: number;
  /** Part rendue par Stripe, ligne par paiement d'origine. */
  stripeRefunds: StripeRefundLine[];
  stripeRefundCents: number;
  /** Part à rendre à la main (virement/espèces payés, ou Stripe sans clé). */
  manualRefundCents: number;
  /** Indemnité de l'exploitant qui annule (5.3) = arrhes reçues : virement à faire à la main. */
  indemnityCents: number;
  /** Force majeure retenue (5.4) : tout est remboursé, sans indemnité. */
  forceMajeure: boolean;
  /** Non-présentation ou séjour entamé retenu (5.5). */
  sejourEntame: boolean;
  note: string;
}

const isStripeChannel = (b: BookingRow) => b.source === "ical" || b.source === "import";

/** Calcule le plan d'annulation. N'écrit rien. */
export interface PlanOptions {
  /** Force majeure (CGV 5.4), quelle que soit la partie : tout ce qui a été payé est rendu. */
  forceMajeure?: boolean;
  /** Client : non-présentation ou séjour écourté, le prix du séjour n'est pas rendu (CGV 5.5). */
  sejourEntame?: boolean;
}

export async function planCancellation(
  db: D1Database,
  cfg: StripeConfig,
  booking: BookingRow,
  par: AnnulationPar,
  opts: PlanOptions = {},
): Promise<CancellationPlan> {
  const forceMajeure = opts.forceMajeure === true;
  // Le séjour entamé ne concerne que le client, et cède devant la force majeure.
  const sejourEntame = par === "locataire" && !forceMajeure && opts.sejourEntame === true;
  const base = {
    par, paidCents: 0, arrhesCents: contractualArrhes(booking), keptCents: 0, refundCents: 0,
    stripeRefunds: [] as StripeRefundLine[], stripeRefundCents: 0, manualRefundCents: 0, indemnityCents: 0, forceMajeure, sejourEntame,
  };
  if (isStripeChannel(booking)) {
    const canal = booking.channelLabel ?? (booking.source === "import" ? "l'ancien système" : "le canal");
    return {
      ...base, mode: "canal",
      note: `Réservation venue de ${canal} : aucun mouvement d'argent de notre part. Un remboursement éventuel se règle sur ${canal}.`,
    };
  }

  const payments = await listPayments(db, { bookingId: booking.id });
  const paid = payments.filter((p) => p.status === "succeeded" && p.kind !== "refund" && p.amountCents > 0);
  const paidNet = Math.max(0, booking.paidCents);
  if (paidNet <= 0 || paid.length === 0) {
    return { ...base, mode: "sans_paiement", note: "Rien n'a été payé : rien à rembourser." };
  }

  // Les arrhes que l'exploitant a réellement reçues (jamais plus que le payé).
  const arrhesRecues = Math.min(paidNet, base.arrhesCents);
  // 5.2 : le client annule, les arrhes restent acquises. 5.5 : séjour entamé
  // (non-présentation, arrivée écourtée), le prix du séjour n'est pas rendu
  // (jamais plus que ce prix : un trop-perçu est rendu). 5.3 et 5.4 : rien n'est gardé.
  const kept = par === "locataire" && !forceMajeure
    ? (sejourEntame ? Math.min(paidNet, Math.max(booking.totalCents, arrhesRecues)) : arrhesRecues)
    : 0;
  const refund = paidNet - kept;
  // 5.3 : l'exploitant qui annule verse une indemnité égale aux arrhes reçues, sauf force majeure.
  const indemnity = par === "proprietaire" && !forceMajeure ? arrhesRecues : 0;

  // Déjà rendu par Stripe par PaymentIntent (lignes réussies ET en cours : la
  // ligne en cours réserve sa part, une ligne échouée ne compte pas).
  const refundedByIntent = new Map<string, number>();
  for (const r of payments) {
    if (r.kind === "refund" && (r.status === "succeeded" || r.status === "pending") && r.stripePaymentIntent) {
      refundedByIntent.set(r.stripePaymentIntent, (refundedByIntent.get(r.stripePaymentIntent) ?? 0) + Math.abs(r.amountCents));
    }
  }

  // On rend d'abord les derniers paiements, hors arrhes : les arrhes restent
  // en dernier dans la file, donc intactes pour le locataire.
  const order = [...paid].sort((a, b) => Number(a.kind === "deposit") - Number(b.kind === "deposit") || b.id - a.id);
  let need = refund;
  const stripeLines: StripeRefundLine[] = [];
  let manual = 0;
  for (const p of order) {
    if (need <= 0) break;
    const intent = intentOf(p);
    const already = intent ? (refundedByIntent.get(intent) ?? 0) : 0;
    const room = Math.max(0, p.amountCents - already);
    const take = Math.min(room, need);
    if (take <= 0) continue;
    if (p.method === "stripe" && intent && stripeEnabled(cfg)) {
      stripeLines.push({ paymentId: p.id, paymentIntent: intent, amountCents: take });
      refundedByIntent.set(intent, already + take);
    } else {
      manual += take;
    }
    need -= take;
  }
  manual += need; // reliquat que les plafonds n'ont pas pu placer : à la main, jamais perdu

  const stripeSum = stripeLines.reduce((s, l) => s + l.amountCents, 0);
  return {
    ...base, mode: "arrhes", paidCents: paidNet, keptCents: kept, refundCents: refund,
    stripeRefunds: stripeLines, stripeRefundCents: stripeSum, manualRefundCents: manual, indemnityCents: indemnity,
    note: planNote(par, kept, refund, manual, indemnity, forceMajeure, sejourEntame),
  };
}

/** Arrhes au sens des CGV (4.1, 4.3) : le pourcentage figé dans le devis de la
 *  réservation, appliqué à son prix total. `bookings.deposit_cents` est le
 *  montant DEMANDÉ à la réservation : il vaut le prix total quand l'arrivée est
 *  à moins de 30 jours ou que le client a choisi de tout payer, et ne peut donc
 *  pas servir seul (sinon une annulation garderait tout au lieu des arrhes).
 *  Jamais plus que ce montant demandé ; sans devis lisible, repli sur lui. */
export function contractualArrhes(booking: BookingRow): number {
  const demanded = Math.max(0, booking.depositCents);
  let pct: number | null = null;
  try {
    const q = booking.quoteJson ? (JSON.parse(booking.quoteJson) as { depositPct?: unknown }) : null;
    pct = typeof q?.depositPct === "number" && Number.isFinite(q.depositPct) ? q.depositPct : null;
  } catch {
    pct = null;
  }
  if (pct == null) return demanded;
  if (pct >= 100) return Math.min(demanded, Math.max(0, booking.totalCents));
  return Math.min(demanded, Math.max(0, Math.round((booking.totalCents * Math.max(0, pct)) / 100)));
}

/** PaymentIntent d'un paiement : la colonne dédiée, sinon la référence `pi_…` de session. */
function intentOf(p: PaymentRow): string | null {
  if (p.stripePaymentIntent?.startsWith("pi_")) return p.stripePaymentIntent;
  if (p.stripeSessionId?.startsWith("pi_")) return p.stripeSessionId;
  return null;
}

function planNote(par: AnnulationPar, kept: number, refund: number, manual: number, indemnity: number, forceMajeure: boolean, sejourEntame: boolean): string {
  const parts: string[] = [];
  if (forceMajeure) parts.push("Force majeure : tout ce qui a été payé est rendu, arrhes comprises, sans indemnité (art. 5.4 des CGV).");
  else if (par === "locataire" && sejourEntame) parts.push(`Séjour entamé ou non-présentation : ${eurTxt(kept)} restent acquis à l'exploitant (prix du séjour, art. 5.5 des CGV).`);
  else if (par === "locataire") parts.push(`Annulation par le client : ${eurTxt(kept)} restent acquis à l'exploitant (arrhes, art. 5.2 des CGV).`);
  else parts.push("Annulation par l'exploitant : tout ce qui a été payé est rendu, arrhes comprises, plus une indemnité égale aux arrhes (art. 5.3 des CGV).");
  if (refund > 0) parts.push(`Remboursement de ${eurTxt(refund)} sous 14 jours, sur le moyen de paiement utilisé.`);
  if (manual > 0) parts.push(`Dont ${eurTxt(manual)} à rendre à la main (paiement hors Stripe ou Stripe non disponible).`);
  if (indemnity > 0) parts.push(`Indemnité de ${eurTxt(indemnity)} à virer à la main : Stripe ne rembourse pas plus que l'encaissé.`);
  else parts.push("Aucune indemnité (art. 5.6 des CGV).");
  return parts.join(" ");
}

function eurTxt(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

export interface RefundOutcome {
  refundPaymentId: number;
  paymentId: number;
  amountCents: number;
  status: "succeeded" | "failed" | "pending";
  stripeRefundId?: string;
  error?: string;
}

/** Les lignes de remboursement sont créées `pending` AVANT l'annulation (une
 *  panne entre les deux laisse des lignes reprenables, jamais une annulation
 *  sans trace). Montant NÉGATIF : `paid_cents` baisse à la réussite. */
export async function prepareRefunds(db: D1Database, booking: BookingRow, lines: StripeRefundLine[]): Promise<{ rowId: number; line: StripeRefundLine }[]> {
  const out: { rowId: number; line: StripeRefundLine }[] = [];
  for (const l of lines) {
    const rowId = await addPayment(db, {
      bookingId: booking.id, kind: "refund", method: "stripe", amountCents: -l.amountCents, status: "pending",
      stripePaymentIntent: l.paymentIntent, note: `remboursement du paiement #${l.paymentId}`,
    });
    out.push({ rowId, line: l });
  }
  return out;
}

/** L'annulation n'a pas eu lieu (perdue contre une autre) : les lignes jamais
 *  envoyées à Stripe disparaissent. */
export async function dropPreparedRefunds(db: D1Database, booking: BookingRow, rowIds: number[]): Promise<void> {
  for (const id of rowIds) await db.prepare("DELETE FROM payments WHERE id = ?1 AND kind = 'refund' AND status = 'pending'").bind(id).run();
  await recomputePaid(db, booking.id);
}

/** Envoie à Stripe les remboursements préparés. Un échec ne bloque rien : la
 *  ligne passe `failed` et se rejoue (`replayRefund`). */
export async function executeRefunds(
  db: D1Database,
  cfg: StripeConfig,
  booking: BookingRow,
  prepared: { rowId: number; line: StripeRefundLine }[],
): Promise<RefundOutcome[]> {
  const out: RefundOutcome[] = [];
  for (const { rowId, line } of prepared) {
    out.push(await runRefund(db, cfg, booking.reference, rowId, line.paymentId, line.paymentIntent, line.amountCents));
  }
  return out;
}

/** Idempotency-Key de la ligne : stable et UNIQUE par ligne (jamais d'horloge,
 *  jamais de numéro de tentative). Après une réponse ambiguë (délai d'attente,
 *  500), le rejeu réutilise la même clé : Stripe rend le remboursement déjà
 *  créé au lieu d'en ouvrir un second. */
const keyOf = (rowId: number) => `gp-refund-${rowId}`;

async function runRefund(
  db: D1Database, cfg: StripeConfig, reference: string, rowId: number, paymentId: number,
  intent: string, amountCents: number,
): Promise<RefundOutcome> {
  try {
    const r = await createRefund(cfg, { paymentIntent: intent, amountCents, idempotencyKey: keyOf(rowId), reference, refundRowId: rowId });
    // Seuls `succeeded` et `pending` (Bancontact : l'argent est en route) comptent.
    const ok = r.status === "succeeded" || r.status === "pending";
    await markPaymentStatus(db, rowId, ok ? "succeeded" : "failed", {
      receivedAt: sqlNow(), note: `remboursement du paiement #${paymentId} — Stripe ${r.id} (${r.status})`,
    });
    return { refundPaymentId: rowId, paymentId, amountCents, status: ok ? "succeeded" : "failed", stripeRefundId: r.id, ...(ok ? {} : { error: `Stripe : statut ${r.status}` }) };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    await markPaymentStatus(db, rowId, "failed", { note: `remboursement du paiement #${paymentId} — échec : ${error}` });
    return { refundPaymentId: rowId, paymentId, amountCents, status: "failed", error };
  }
}

/** Rejoue un remboursement `failed` (ou resté `pending` après une panne).
 *  Avant de renvoyer l'ordre, on demande à Stripe s'il a DÉJÀ créé le
 *  remboursement de cette ligne (métadonnée `refund_row`) : une réponse perdue
 *  peut cacher un remboursement passé. En cas de doute (Stripe injoignable), on
 *  ne rejoue pas. L'ordre repart avec la MÊME Idempotency-Key, et la ligne est
 *  « réservée » par un UPDATE conditionnel : deux rejeux simultanés ne partent
 *  jamais ensemble. */
export async function replayRefund(
  db: D1Database, cfg: StripeConfig, booking: BookingRow, refundPaymentId: number,
): Promise<RefundOutcome> {
  const rows = await listPayments(db, { bookingId: booking.id });
  const row = rows.find((r) => r.id === refundPaymentId && r.kind === "refund");
  if (!row || (row.status !== "failed" && row.status !== "pending") || !row.stripePaymentIntent) {
    throw new Error("remboursement introuvable ou déjà réglé");
  }
  const amount = Math.abs(row.amountCents);
  const intent = row.stripePaymentIntent;
  const paymentId = Number(/#(\d+)/.exec(row.note ?? "")?.[1] ?? 0);
  const found = await findRefundForRow(cfg, intent, row.id);
  if (found === "inconnu") throw new Error("Stripe injoignable : impossible de vérifier si ce remboursement existe déjà, on ne rejoue pas");
  if (found && (found.status === "succeeded" || found.status === "pending")) {
    // Stripe l'a bien créé malgré l'échec constaté ici : on aligne la ligne.
    await markPaymentStatus(db, row.id, "succeeded", { receivedAt: sqlNow(), note: `remboursement du paiement #${paymentId} — Stripe ${found.id} (${found.status}), retrouvé au rejeu` });
    await audit(db, "admin", "refund.replay_already_done", `booking:${booking.id}`, { refundPayment: row.id, stripeRefund: found.id });
    return { refundPaymentId: row.id, paymentId, amountCents: amount, status: "succeeded", stripeRefundId: found.id };
  }
  const claim = await db
    .prepare("UPDATE payments SET status = 'pending', note = ?3 WHERE id = ?1 AND status = ?2 AND kind = 'refund'")
    .bind(row.id, row.status, `remboursement du paiement #${paymentId} — rejeu`)
    .run();
  if (claim.meta.changes !== 1) throw new Error("un rejeu de ce remboursement est déjà en cours");
  const outcome = await runRefund(db, cfg, booking.reference, row.id, paymentId, intent, amount);
  await audit(db, "admin", "refund.replay", `booking:${booking.id}`, outcome);
  return outcome;
}
