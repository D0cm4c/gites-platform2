// Webhooks Stripe, un par compte (donc un par propriété).
//
// CHOIX DE ROUTAGE : une route PAR PROPRIÉTÉ, `/api/webhooks/stripe/:propertyId`.
// Chaque compte Stripe a son propre « signing secret » (whsec_…) : l'URL dit quel
// secret essayer, la signature est vérifiée avec CE secret-là et aucun autre.
// L'alternative — une route unique qui essaie le secret de chaque propriété —
// obligerait à tenter N HMAC par requête et rendrait une erreur de configuration
// (deux comptes collés sur la même URL) silencieuse. Ici une propriété ne peut
// jamais valider l'événement d'une autre.
//
// Ceinture et bretelles : même signé, un événement n'est appliqué que si le
// paiement visé appartient bien à la propriété de la route (sinon audité
// `webhook.property_mismatch` et ignoré).
//
// L'ancienne route `/api/webhooks/stripe` (sans identifiant) est conservée pour
// le repli sur les variables d'environnement : elle vérifie STRIPE_WEBHOOK_SECRET
// et ne s'applique qu'aux paiements d'une propriété SANS clés propres.

import { audit, EXPIRED_SESSION_NOTE, findPaymentBySession, markPaymentStatus } from "../db/repo";
import { handlePaymentFailure, handlePaymentSuccess } from "./booking-flow";
import { setPaymentFees } from "./encaissements";
import { fetchPaymentFees, type StripeConfig } from "./stripe";
import { propertyIdOfPayment, resolveStripeConfig } from "./stripe-config";

type StripeEvent = { type?: string; data?: { object?: Record<string, unknown> } };

/** Événements que le code traite réellement (à cocher dans le tableau de bord Stripe). */
export const STRIPE_EVENTS_HANDLED = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
] as const;

/** Relève les frais réels d'un paiement qui vient d'aboutir. Best effort : un
 *  échec laisse les frais « inconnus » (rattrapables depuis l'écran Encaissements). */
async function recordFees(db: D1Database, cfg: StripeConfig, sessionRef: string, intentId: string | null): Promise<void> {
  try {
    if (!intentId) return;
    const payment = await findPaymentBySession(db, sessionRef);
    if (!payment || payment.status !== "succeeded") return;
    const fees = await fetchPaymentFees(cfg, intentId);
    if (fees) await setPaymentFees(db, payment.id, fees.feeCents, fees.netCents);
  } catch {
    /* jamais bloquant pour le webhook */
  }
}

/** Applique un événement Stripe DÉJÀ authentifié (signature vérifiée). */
export async function processStripeEvent(
  db: D1Database,
  env: Env,
  cfg: StripeConfig,
  routePropertyId: number | null,
  event: StripeEvent,
): Promise<void> {
  const obj = event.data?.object;
  if (!obj) return;

  // Le paiement visé appartient-il à la propriété de la route ?
  const belongs = async (ref: string): Promise<boolean> => {
    const payment = await findPaymentBySession(db, ref);
    if (!payment) return true; // inconnu : traité plus bas comme « unmatched »
    const owner = await propertyIdOfPayment(db, payment.id);
    if (routePropertyId == null) {
      // Route historique, signée avec le secret d'ENVIRONNEMENT : elle ne vaut que
      // pour une propriété qui encaisse avec le repli. Une propriété qui a ses
      // propres clés a sa propre route ; le secret d'environnement ne la concerne pas.
      if ((await resolveStripeConfig(db, env, owner)).source !== "property") return true;
    } else if (owner === routePropertyId) {
      return true;
    }
    await audit(db, "stripe", "webhook.property_mismatch", `payment:${payment.id}`, {
      route: routePropertyId ?? "env", owner, type: event.type ?? null,
    });
    return false;
  };

  if (event.type === "checkout.session.completed" && obj.payment_status === "paid") {
    const sessionId = String(obj.id);
    if (!(await belongs(sessionId))) return;
    const intent = obj.payment_intent ? String(obj.payment_intent) : null;
    const outcome = await handlePaymentSuccess(db, env, sessionId, intent);
    // handled:false = aucun paiement ne correspond à cette session. On répond
    // 200 (Stripe cesserait de réessayer de toute façon) mais on laisse une
    // trace : sans elle, l'événement disparaissait sans effet.
    if (!outcome.handled) await audit(db, "stripe", "webhook.unmatched", null, { session: sessionId });
    else await recordFees(db, cfg, sessionId, intent);
  } else if (event.type === "payment_intent.succeeded" && obj.id) {
    // Paiement intégré (issue #26). MÊME chemin de crédit que Checkout : la
    // référence Stripe (`pi_…`) est écrite dans la même colonne de
    // réconciliation, donc la même idempotence. C'est cette notification qui
    // fait foi, jamais le retour navigateur (Bancontact ramène le client avec
    // `redirect_status=processing` bien avant que la banque ait tranché).
    const intentId = String(obj.id);
    if (!(await belongs(intentId))) return;
    const outcome = await handlePaymentSuccess(db, env, intentId, intentId);
    if (!outcome.handled) await audit(db, "stripe", "webhook.unmatched", null, { intent: intentId });
    else await recordFees(db, cfg, intentId, intentId);
  } else if (event.type === "payment_intent.payment_failed" && obj.id) {
    // Carte refusée, Bancontact abandonné : la TENTATIVE échoue, la réservation
    // ne bouge pas. Le blocage de 30 min continue de courir et reste récupérable.
    if (!(await belongs(String(obj.id)))) return;
    const err = obj.last_payment_error as { message?: unknown; code?: unknown } | undefined;
    const reason = String(err?.code ?? err?.message ?? "").slice(0, 200) || null;
    await handlePaymentFailure(db, String(obj.id), reason);
  } else if (event.type === "checkout.session.expired" && obj.id) {
    if (!(await belongs(String(obj.id)))) return;
    const payment = await findPaymentBySession(db, String(obj.id));
    if (payment && payment.status === "pending") {
      await markPaymentStatus(db, payment.id, "failed", { note: EXPIRED_SESSION_NOTE });
      await audit(db, "stripe", "payment.expired", `booking:${payment.bookingId}`, { session: String(obj.id) });
    }
  }
}
