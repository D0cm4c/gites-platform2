// Flux de réservation partagé entre l'API publique, l'admin (vente manuelle,
// lien de paiement) et les callbacks de paiement (webhook Stripe / stub).

import { sqlNow, type IsoDate } from "../core/dates";
import { computeQuote, type Quote } from "../core/pricing";
import {
  addPayment,
  audit,
  confirmBookingAtomic,
  findPaymentBySession,
  getBooking,
  getProperty,
  hasEmailOfKinds,
  getSettings,
  incrementPromoUse,
  listPayments,
  markPaymentStatus,
  SUPERSEDED_SESSION_NOTE,
  setPaymentSession,
  type BookingRow,
  type QuoteContext,
} from "../db/repo";
import { buildPaymentReceiptEmail, queueEmail } from "./email";
import { buildConfirmationEmail } from "./confirmation";
import { buildConfirmationPdf, confirmationFileName, loadConfirmationPdfContext } from "./confirmation-pdf";
import {
  createCheckoutSession,
  createPaymentIntent,
  paymentElementEnabled,
  remotePaymentInFlight,
  stripeEnabled,
  stripePublishableKey,
  voidRemotePayment,
} from "./stripe";
import { propertyIdOfBooking, resolveStripeConfig } from "./stripe-config";

export interface QuoteBody {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  options?: { id: number; qty: number }[];
  promoCode?: string | null;
}

/** Construit le devis à partir du contexte D1 (sélection d'options validée
 *  contre le référentiel — un id inconnu ou inactif est ignoré). */
export function quoteFromContext(ctx: QuoteContext, body: QuoteBody, today: IsoDate): Quote {
  const selected = (body.options ?? [])
    .map((sel) => {
      const opt = ctx.options.find((o) => o.id === Number(sel.id));
      return opt ? { option: opt, qty: Number(sel.qty) || 0 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return computeQuote({
    unit: ctx.pricingUnit,
    checkin: body.checkin,
    checkout: body.checkout,
    adults: body.adults,
    children: body.children,
    today,
    seasons: ctx.seasons,
    rateRules: ctx.rateRules,
    rateOverrides: ctx.rateOverrides,
    promotions: ctx.promotions,
    promoCode: body.promoCode ?? null,
    optionsSelected: selected,
    settings: {
      depositPct: ctx.settings.depositPct,
      balanceDueDays: ctx.settings.balanceDueDays,
      touristTaxCentsPerPersonNight: ctx.settings.touristTaxCentsPerPersonNight,
      touristTaxIncludeChildren: ctx.settings.touristTaxIncludeChildren,
      cautionCents: ctx.settings.cautionCents,
    },
  });
}

/** Plancher d'une session de paiement Stripe (0,50 €) : en dessous, la création
 *  de session est refusée par l'API. */
export const MIN_CHECKOUT_CENTS = 50;

/** Espace client d'une réservation : référence + email, les deux exigés côté
 *  serveur. C'est le point d'entrée stable du solde en libre-service (#67) —
 *  contrairement à une URL de session Stripe, il ne périme jamais. */
export function voucherUrl(env: Env, booking: { reference: string; guestEmail?: string | null; guestLang?: string | null }): string {
  const email = booking.guestEmail ? `&email=${encodeURIComponent(booking.guestEmail)}` : "";
  // Client néerlandophone (lot 3) : le voucher s'ouvre dans sa langue.
  const lang = booking.guestLang === "nl" ? "&lang=nl" : "";
  return `${env.PUBLIC_BASE_URL}/book/voucher.html?ref=${encodeURIComponent(booking.reference)}${email}${lang}`;
}

/** Ferme les sessions de paiement encore ouvertes sur une réservation, CHEZ
 *  STRIPE d'abord, en base ensuite.
 *
 *  Marquer `failed` en base ne fermait rien : la page Stripe restait payable.
 *  Un client qui empile les onglets, ou qui reclique « Payer le solde », se
 *  retrouvait avec deux sessions vivantes pour le même montant — et le webhook
 *  honorait les deux (contre-review 2026-08-28). L'appel à
 *  `checkout/sessions/{id}/expire` est donc la vraie protection ; le statut en
 *  base n'en est que le reflet.
 *
 *  Un échec d'expiration (session déjà payée, réseau) ne bloque rien : on
 *  journalise et on continue. Le filet de dernier recours reste le contrôle de
 *  trop-perçu de `handlePaymentSuccess`. */
/** Refus d'ouvrir une nouvelle tentative alors qu'une précédente est déjà
 *  partie chez la banque du client. Mappée en 409 par `src/index.ts` — c'est
 *  une situation normale et temporaire, pas une panne. */
export class PaymentInFlightError extends Error {
  constructor() {
    super(
      "Un paiement est déjà en cours de traitement pour cette réservation (Bancontact met parfois quelques minutes). " +
        "Attendez sa confirmation avant d'en lancer un autre — vous recevrez un email dès qu'il aboutit.",
    );
    this.name = "PaymentInFlightError";
  }
}

/** Configuration Stripe de la propriété d'une réservation (clés propres, sinon repli env). */
export async function stripeConfigForBooking(db: D1Database, env: Env, booking: { id: number; propertyId?: number | null }) {
  const propertyId = booking.propertyId ?? (await propertyIdOfBooking(db, booking.id));
  return resolveStripeConfig(db, env, propertyId);
}

export async function voidPendingSessions(
  db: D1Database,
  env: Env,
  bookingId: number,
  actor: "public" | "admin",
): Promise<void> {
  const pendings = (await listPayments(db, { bookingId })).filter((x) => x.status === "pending");
  const cfg = await stripeConfigForBooking(db, env, { id: bookingId });
  for (const pay of pendings) {
    if (pay.stripeSessionId) {
      // Garde-fou AVANT toute écriture : une intention déjà en route chez la
      // banque du client ne s'annule pas. Marquer la ligne `failed` et en
      // ouvrir une seconde produirait deux débits (contre-review 2026-08-30).
      if (await remotePaymentInFlight(cfg, pay.stripeSessionId)) throw new PaymentInFlightError();
      // `voidRemotePayment` reconnaît la forme de la référence : session
      // Checkout (`cs_…`), PaymentIntent (`pi_…`) ou simulateur (`stub_…`).
      // Une même réservation peut porter les deux si le mode a changé entre
      // deux tentatives — d'où l'aiguillage plutôt qu'un appel en dur.
      const closed = await voidRemotePayment(cfg, pay.stripeSessionId);
      if (!closed && stripeEnabled(cfg)) {
        await audit(db, actor, "payment.expire_failed", `booking:${bookingId}`, {
          payment: pay.id,
          session: pay.stripeSessionId,
        });
      }
    }
    await markPaymentStatus(db, pay.id, "failed", { note: SUPERSEDED_SESSION_NOTE });
  }
}

/** Crée un paiement en attente + une session Stripe Checkout (ou stub) et
 *  mémorise l'id de session pour la réconciliation webhook.
 *
 *  Toute session encore ouverte sur la réservation est fermée d'abord : deux
 *  sessions vivantes pour le même montant, ce sont deux encaissements. */
export type PaymentKind = "deposit" | "full" | "balance";

/** Libellé lisible d'une étape de paiement — repris tel quel dans le descriptif
 *  Stripe et sur le relevé bancaire du client. */
export function paymentLabel(booking: BookingRow, kind: PaymentKind): string {
  const labelKind = kind === "deposit" ? "Arrhes" : kind === "balance" ? "Solde" : "Paiement";
  return `${labelKind} réservation ${booking.reference}${booking.unitName ? ` — ${booking.unitName}` : ""}`;
}

/** URLs de retour après paiement.
 *
 *  Le solde se paie sur une réservation DÉJÀ confirmée : le renvoyer vers
 *  merci.html (« Confirmation en cours… », qui attend un passage en
 *  `confirmed`) annoncerait une confirmation qui a eu lieu il y a des semaines.
 *  Retour sur le voucher, qui affiche le nouveau solde.
 *
 *  Ces mêmes URLs servent de `return_url` au Payment Element : Bancontact part
 *  chez la banque du client et le ramène ici. */
export function paymentReturnUrls(env: Env, booking: BookingRow, kind: PaymentKind): { successUrl: string; cancelUrl: string } {
  const base = env.PUBLIC_BASE_URL;
  const emailParam = booking.guestEmail ? `&email=${encodeURIComponent(booking.guestEmail)}` : "";
  if (kind === "balance") return { successUrl: voucherUrl(env, booking), cancelUrl: voucherUrl(env, booking) };
  return {
    successUrl: `${base}/book/merci.html?ref=${encodeURIComponent(booking.reference)}${emailParam}`,
    cancelUrl: `${base}/book/annule.html?ref=${encodeURIComponent(booking.reference)}${emailParam}`,
  };
}

export async function startCheckout(
  db: D1Database,
  env: Env,
  booking: BookingRow,
  kind: PaymentKind,
  amountCents: number,
  actor: "public" | "admin",
): Promise<{ url: string; paymentId: number }> {
  await voidPendingSessions(db, env, booking.id, actor);
  const cfg = await stripeConfigForBooking(db, env, booking);
  const paymentId = await addPayment(db, {
    bookingId: booking.id,
    kind,
    method: "stripe",
    amountCents,
    status: "pending",
  });
  const label = paymentLabel(booking, kind);
  const returnUrls = paymentReturnUrls(env, booking, kind);
  const session = await createCheckoutSession(cfg, {
    baseUrl: env.PUBLIC_BASE_URL,
    paymentId,
    reference: booking.reference,
    label,
    amountCents,
    customerEmail: booking.guestEmail ?? null,
    ...returnUrls,
  });
  await setPaymentSession(db, paymentId, session.id);
  await audit(db, actor, "payment.link_created", `booking:${booking.id}`, { kind, amountCents, session: session.id });
  return { url: session.url, paymentId };
}

/** Résultat d'un démarrage de paiement, quel que soit le mode.
 *
 *  `redirect` : le client quitte la page (Checkout hébergé, ou simulateur en
 *  local). `element` : le formulaire se monte dans la page avec le
 *  `clientSecret`, et `returnUrl` sert de point de retour aux moyens de
 *  paiement à redirection (Bancontact). */
export interface PaymentStart {
  paymentId: number;
  mode: "redirect" | "element";
  /** Renseigné en mode `redirect` uniquement. */
  url: string | null;
  /** Renseigné en mode `element` uniquement. Conçu pour vivre côté navigateur :
   *  il ne confirme que CE paiement, pour le montant fixé ici. */
  clientSecret: string | null;
  returnUrl: string;
  amountCents: number;
  kind: PaymentKind;
  /** Clé PUBLIABLE du compte Stripe de la propriété (mode `element` seulement) :
   *  le navigateur doit monter le formulaire avec la clé du compte qui a créé le
   *  PaymentIntent. Faite pour être publique, contrairement à la clé secrète. */
  publishableKey: string | null;
}

/** Point d'entrée unique du paiement côté client (issue #26).
 *
 *  Avec les deux clés Stripe et le mode `element` (le défaut) : un
 *  PaymentIntent, monté dans la page — carte, Bancontact, Apple/Google Pay.
 *  Sinon : le flux Checkout / simulateur historique, inchangé.
 *
 *  Dans les deux cas le montant vient du devis serveur, jamais du navigateur,
 *  et l'identifiant Stripe (`pi_…` ou `cs_…`) est écrit dans la MÊME colonne de
 *  réconciliation `payments.stripe_session_id` : le webhook, l'idempotence de
 *  `handlePaymentSuccess` et l'index UNIQUE partiel qui la garantit restent
 *  exactement ceux du flux Checkout — aucune migration, aucun second chemin de
 *  crédit à maintenir. */
export async function startPayment(
  db: D1Database,
  env: Env,
  booking: BookingRow,
  kind: PaymentKind,
  amountCents: number,
  actor: "public" | "admin",
): Promise<PaymentStart> {
  const returnUrl = paymentReturnUrls(env, booking, kind).successUrl;
  const cfg = await stripeConfigForBooking(db, env, booking);
  if (!paymentElementEnabled(cfg)) {
    const legacy = await startCheckout(db, env, booking, kind, amountCents, actor);
    return {
      paymentId: legacy.paymentId,
      mode: "redirect",
      url: legacy.url,
      clientSecret: null,
      returnUrl,
      amountCents,
      kind,
      publishableKey: null,
    };
  }

  // Même précaution que pour Checkout : deux intentions vivantes pour le même
  // montant, ce sont deux encaissements possibles.
  await voidPendingSessions(db, env, booking.id, actor);
  const paymentId = await addPayment(db, {
    bookingId: booking.id,
    kind,
    method: "stripe",
    amountCents,
    status: "pending",
  });
  const intent = await createPaymentIntent(cfg, {
    paymentId,
    reference: booking.reference,
    kind,
    label: paymentLabel(booking, kind),
    amountCents,
    customerEmail: booking.guestEmail ?? null,
  });
  await setPaymentSession(db, paymentId, intent.id);
  await audit(db, actor, "payment.intent_created", `booking:${booking.id}`, {
    kind,
    amountCents,
    intent: intent.id,
  });
  return {
    paymentId,
    mode: "element",
    url: null,
    clientSecret: intent.clientSecret,
    returnUrl,
    amountCents,
    kind,
    publishableKey: stripePublishableKey(cfg),
  };
}

/** Chemin commun webhook Stripe / simulateur stub. Idempotent : un même
 *  session_id traité deux fois ne confirme et n'envoie le voucher qu'une fois. */
export async function handlePaymentSuccess(
  db: D1Database,
  env: Env,
  sessionId: string,
  paymentIntent?: string | null,
): Promise<{ handled: boolean; bookingId?: number; reference?: string }> {
  const payment = await findPaymentBySession(db, sessionId);
  if (!payment) return { handled: false };
  const bookingBefore = await getBooking(db, payment.bookingId);
  if (payment.status === "succeeded") {
    return { handled: true, bookingId: payment.bookingId, reference: bookingBefore?.reference };
  }
  await markPaymentStatus(db, payment.id, "succeeded", {
    receivedAt: sqlNow(),
    stripePaymentIntent: paymentIntent ?? null,
  });
  const booking = await getBooking(db, payment.bookingId);
  if (!booking) return { handled: true, bookingId: payment.bookingId };

  // Reçu de paiement (issue #37) — à CHAQUE encaissement, arrhes comme solde.
  // Posé ici, avant l'aiguillage sur le statut, pour qu'il parte aussi quand la
  // confirmation échoue (créneau repris pendant le paiement) : l'argent a bien
  // été encaissé, le client a droit à son justificatif même quand la suite
  // tourne mal. Aucun dédoublonnage par `kind` : une réservation reçoit
  // légitimement plusieurs reçus. C'est la sortie anticipée sur
  // `payment.status === 'succeeded'`, en tête de cette fonction, qui garantit
  // qu'un même paiement n'en produit jamais deux.
  await sendPaymentReceipt(db, env, booking, payment.kind, payment.amountCents);

  if (booking.status === "pending") {
    const outcome = await confirmBookingAtomic(db, booking.id);
    if (outcome === "confirmed") {
      if (booking.promoCode && booking.propertyId != null) {
        await incrementPromoUse(db, booking.propertyId, booking.promoCode);
      }
      await audit(db, "stripe", "booking.confirmed", `booking:${booking.id}`, { sessionId, kind: payment.kind });
      // Une confirmation qui casse ne doit jamais faire échouer le webhook : au retry,
      // Stripe retomberait sur un paiement déjà 'succeeded' et sortirait sans
      // jamais réessayer l'envoi. On journalise et on laisse la résa confirmée
      // (bouton « Renvoyer la confirmation » disponible au back-office).
      try {
        await sendConfirmation(db, env, booking.id);
      } catch (e) {
        await audit(db, "stripe", "confirmation.error", `booking:${booking.id}`, {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      // Le créneau a été repris pendant que le client payait (hold expiré +
      // webhook Stripe tardif — Stripe retente jusqu'à 3 jours). Argent
      // encaissé, séjour impossible : alerte, pas une ligne de journal noyée.
      await audit(db, "stripe", "payment.orphaned", `booking:${booking.id}`, {
        sessionId,
        kind: payment.kind,
        outcome,
        reason: outcome === "conflict" ? "créneau repris pendant le paiement" : "réservation plus en attente",
      });
    }
  } else if (booking.status === "confirmed") {
    await audit(db, "stripe", "payment.received", `booking:${booking.id}`, { sessionId, kind: payment.kind });
    const after = await getBooking(db, booking.id);
    if (after && after.paidCents > after.totalCents) {
      await audit(db, "stripe", "payment.overpaid", `booking:${booking.id}`, {
        sessionId,
        paidCents: after.paidCents,
        totalCents: after.totalCents,
      });
    }
  } else {
    // Résa annulée (hold expiré par le cron, annulation manuelle) et pourtant
    // payée : même gravité que ci-dessus.
    await audit(db, "stripe", "payment.orphaned", `booking:${booking.id}`, {
      sessionId,
      kind: payment.kind,
      outcome: booking.status,
      reason: "paiement reçu sur une réservation annulée",
    });
  }
  return { handled: true, bookingId: booking.id, reference: booking.reference };
}

/** Échec de paiement signalé par Stripe (`payment_intent.payment_failed`).
 *
 *  Ce qu'on fait : marquer CETTE tentative `failed`, pour qu'elle cesse
 *  d'apparaître « en attente » dans la vue Paiements, et laisser une ligne
 *  d'audit avec le motif rendu par Stripe.
 *
 *  Ce qu'on ne fait SURTOUT pas : toucher à la réservation. Une carte refusée
 *  n'annule rien — le blocage de 30 minutes continue de courir, le client
 *  réessaie dans le formulaire (le même PaymentIntent accepte une nouvelle
 *  tentative) ou reprend depuis son voucher. Annuler ici, ce serait détruire un
 *  hold que le client est en train d'utiliser.
 *
 *  Idempotent par construction : une tentative déjà `succeeded` ou déjà
 *  `failed` n'est pas retouchée — un `payment_failed` arrivé APRÈS un
 *  `succeeded` (retry Stripe désordonné) ne peut donc pas décrémenter un
 *  encaissement acquis. */
export async function handlePaymentFailure(
  db: D1Database,
  intentId: string,
  reason?: string | null,
): Promise<{ handled: boolean; bookingId?: number }> {
  const payment = await findPaymentBySession(db, intentId);
  if (!payment) return { handled: false };
  if (payment.status !== "pending") return { handled: true, bookingId: payment.bookingId };
  await markPaymentStatus(db, payment.id, "failed");
  await audit(db, "stripe", "payment.failed", `booking:${payment.bookingId}`, {
    intent: intentId,
    kind: payment.kind,
    reason: reason ?? null,
  });
  return { handled: true, bookingId: payment.bookingId };
}

/** Journalise (ou envoie, si activé) le reçu d'un encaissement.
 *
 *  Comme le voucher, il ne doit JAMAIS faire échouer le webhook : au retry,
 *  Stripe retomberait sur un paiement déjà 'succeeded' et sortirait sans rien
 *  refaire — on perdrait la confirmation pour un simple justificatif. */
async function sendPaymentReceipt(
  db: D1Database,
  env: Env,
  booking: BookingRow,
  kind: string,
  amountCents: number,
): Promise<void> {
  try {
    if (!booking.guestEmail || booking.propertyId == null) return;
    const property = await getProperty(db, booking.propertyId);
    if (!property) return;
    // Relecture : `paid_cents` vient d'être recalculé par l'enregistrement du
    // paiement. Sans elle, le reçu annoncerait un solde d'avant l'encaissement.
    const fresh = (await getBooking(db, booking.id)) ?? booking;
    const email = buildPaymentReceiptEmail(fresh, property, { kind, amountCents, receivedAt: sqlNow() });
    await queueEmail(db, env, {
      bookingId: booking.id,
      to: booking.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      kind: "payment_receipt",
    });
  } catch (e) {
    await audit(db, "stripe", "receipt.error", `booking:${booking.id}`, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Mail de confirmation de réservation, avec le PDF « Confirmation de
 *  réservation et conditions générales » en pièce jointe.
 *
 *  C'est LE mail de confirmation : il remplace l'ancien voucher par mail
 *  (décision du 11/10/2026), qui ne part donc plus en plus de lui. Il part
 *  - à la confirmation par paiement (webhook Stripe, simulateur dev),
 *  - à la vente confirmée du back-office et à la confirmation manuelle,
 *  - sur demande, via « Renvoyer la confirmation » (`force`).
 *  Sans `force`, il ne part qu'UNE fois par réservation : si un envoi non
 *  échoué existe déjà au journal (kind 'confirmation', ou 'voucher' pour les
 *  réservations d'avant), on ne renvoie rien. Rend true si un mail a été
 *  journalisé (envoyé, ou stub), false sinon. */
export async function sendConfirmation(
  db: D1Database,
  env: Env,
  bookingId: number,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const ctx = await loadConfirmationPdfContext(db, bookingId);
  if (!ctx || !ctx.booking.guestEmail) return false;
  let claimed = false;
  if (!opts.force) {
    if (await hasEmailOfKinds(db, bookingId, ["confirmation", "voucher"])) return false;
    // Verrou posé AVANT l'envoi : le SELECT ci-dessus ne protège pas de deux
    // appels simultanés, l'INSERT OR IGNORE si (clé primaire).
    const claim = await db.prepare("INSERT OR IGNORE INTO confirmation_claims (booking_id) VALUES (?1)").bind(bookingId).run();
    if ((claim.meta?.changes ?? 0) === 0) return false;
    claimed = true;
  }
  const filename = confirmationFileName(ctx.booking.reference);
  let message: Parameters<typeof queueEmail>[2];
  try {
    const email = buildConfirmationEmail({
      booking: ctx.booking,
      property: ctx.property,
      settings: ctx.settings,
      voucherUrl: voucherUrl(env, ctx.booking),
      attachmentName: filename,
    });
    message = {
      bookingId,
      to: ctx.booking.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      attachments: [{ filename, contentType: "application/pdf", content: buildConfirmationPdf(ctx) }],
      kind: "confirmation",
    };
  } catch (e) {
    // Rien n'est parti : le verrou est rendu.
    if (claimed) await db.prepare("DELETE FROM confirmation_claims WHERE booking_id = ?1").bind(bookingId).run();
    throw e;
  }
  // Une exception de queueEmail laisse le verrou en place : le transport a pu
  // accepter le mail avant que le journal échoue, et un doublon chez le client
  // est pire qu'une confirmation à renvoyer à la main (bouton « Renvoyer »).
  // Seul un échec CONSTATÉ (statut `failed`) rend le verrou.
  const status = await queueEmail(db, env, message);
  if (status === "failed" && claimed) await db.prepare("DELETE FROM confirmation_claims WHERE booking_id = ?1").bind(bookingId).run();
  return true;
}
