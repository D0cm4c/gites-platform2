// Intégration Stripe — par API REST directe (fetch), sans SDK.
//
// UN COMPTE STRIPE PAR ENTITÉ QUI ENCAISSE (décision de Julien, 11/10/2026) :
// chaque propriété a ses clés (table `property_stripe`, services/stripe-config.ts)
// et ses encaissements arrivent sur son propre compte bancaire. Les fonctions de
// ce fichier ne lisent donc plus l'environnement : elles reçoivent une
// `StripeConfig` déjà résolue pour la propriété concernée. Les variables
// d'environnement STRIPE_* ne servent plus que de REPLI, pour une propriété qui
// n'a pas encore ses propres clés.
//
// Trois modes, décidés par la seule configuration — le code du tunnel est le
// même dans les trois cas :
//
//  1. AUCUNE clé            → MODE STUB : `createCheckoutSession` renvoie une
//     URL locale /book/dev-pay.html qui simule le paiement (la page appelle
//     /api/public/dev-pay/confirm, qui rejoue le chemin du webhook).
//  2. sk_ + pk_             → PAYMENT ELEMENT (défaut, issue #26) : formulaire
//     intégré dans la page, carte + Bancontact + Apple/Google Pay. Le client ne
//     quitte jamais le site (sauf redirection bancaire de Bancontact).
//  3. sk_ seule, ou STRIPE_UI=checkout → CHECKOUT hébergé : le flux historique,
//     conservé comme repli et comme support des liens de paiement envoyés par
//     email depuis le back-office (un email a besoin d'une URL, pas d'un
//     `client_secret`).

/** Configuration Stripe EFFECTIVE d'une propriété (clés déjà résolues).
 *  Ne sort jamais du serveur : seule `publishableKey` est faite pour le
 *  navigateur. */
export interface StripeConfig {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  mode: "test" | "live" | null;
  /** `checkout` force le repli sur la page hébergée (variable STRIPE_UI, globale). */
  ui: "element" | "checkout";
  /** D'où viennent les clés : la propriété elle-même, l'environnement (repli), ou nulle part. */
  source: "property" | "env" | "none";
  propertyId: number | null;
}

/** Mode déduit du préfixe d'une clé secrète (sk_test_ / rk_test_ / sk_live_ …). */
export function modeOfSecretKey(key: string | null | undefined): "test" | "live" | null {
  const k = (key ?? "").trim();
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return null;
}

/** Configuration de REPLI : les variables d'environnement historiques. */
export function stripeConfigFromEnv(env: Env, propertyId: number | null = null): StripeConfig {
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim() || null;
  return {
    secretKey,
    publishableKey: (env.STRIPE_PUBLISHABLE_KEY ?? "").trim() || null,
    webhookSecret: (env.STRIPE_WEBHOOK_SECRET ?? "").trim() || null,
    mode: modeOfSecretKey(secretKey),
    ui: (env.STRIPE_UI ?? "").trim().toLowerCase() === "checkout" ? "checkout" : "element",
    source: secretKey ? "env" : "none",
    propertyId,
  };
}

const STRIPE_API = "https://api.stripe.com/v1";

/** Corps d'erreur Stripe borné et débarrassé de la clé : ces messages finissent dans
 *  les journaux et l'audit (src/index.ts), la clé secrète n'a rien à y faire. */
function stripeErrorText(text: string, cfg: StripeConfig): string {
  let out = text;
  for (const secret of [cfg.secretKey, cfg.webhookSecret]) if (secret) out = out.split(secret).join("[clé]");
  return out.slice(0, 300);
}

export function stripeEnabled(cfg: StripeConfig): boolean {
  return !!cfg.secretKey && cfg.secretKey.trim() !== "";
}

/** Clé publique à confier au navigateur, ou `null` si le paiement intégré ne
 *  peut pas fonctionner. Les deux clés vont ensemble : une clé publique sans
 *  clé secrète monterait un formulaire qu'aucun PaymentIntent n'alimente. */
export function stripePublishableKey(cfg: StripeConfig): string | null {
  const key = (cfg.publishableKey ?? "").trim();
  return stripeEnabled(cfg) && key !== "" ? key : null;
}

/** Interface de paiement retenue. `element` par défaut ; `STRIPE_UI=checkout`
 *  force le repli sur la page hébergée, sans redéploiement de code. */
export function stripeUiMode(cfg: StripeConfig): "element" | "checkout" {
  return cfg.ui;
}

/** Vrai quand le Payment Element est réellement montable : clé secrète (pour
 *  créer le PaymentIntent), clé publique (pour le monter), et mode `element`.
 *  Toute réponse négative renvoie au flux Checkout / stub — jamais à une page
 *  de paiement vide. */
export function paymentElementEnabled(cfg: StripeConfig): boolean {
  return stripePublishableKey(cfg) !== null && stripeUiMode(cfg) === "element";
}

/** Moyens de paiement déclarés explicitement (décision propriétaire
 *  2026-08-30) : la carte — qui porte aussi Apple Pay et Google Pay dans le
 *  Payment Element — et **Bancontact**, ~60 % du commerce en ligne belge.
 *
 *  Pourquoi une liste explicite plutôt qu'`automatic_payment_methods` : ce
 *  dernier délègue la liste au tableau de bord Stripe, donc à un réglage
 *  invisible depuis le dépôt. Ici, ce qui est proposé au client est lisible
 *  dans le code et couvert par un test. */
export const PAYMENT_METHOD_TYPES = ["card", "bancontact"] as const;
/** Depuis la version d'API Stripe 2026-09-30 (constaté le 11/10/2026 sur le compte réel :
 *  « The `payment_method_types` parameter is no longer supported »), la liste des moyens
 *  de paiement se règle UNIQUEMENT dans le tableau de bord Stripe (Réglages › Moyens de
 *  paiement : carte et Bancontact activés). Le PaymentIntent part donc sans ce paramètre ;
 *  la constante ci-dessus reste la liste attendue, documentée et vérifiée dans docs/paiements-stripe.md. */

export interface CheckoutParams {
  /** Origine publique du site, pour l'URL du simulateur (mode stub). */
  baseUrl: string;
  paymentId: number;      // notre payments.id — la clé de réconciliation du webhook
  reference: string;      // PM-2026-001
  label: string;          // « Acompte réservation PM-2026-001 — La Scierie »
  amountCents: number;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(cfg: StripeConfig, p: CheckoutParams): Promise<{ id: string; url: string }> {
  if (!stripeEnabled(cfg)) {
    const id = `stub_${p.paymentId}`;
    const url = `${p.baseUrl}/book/dev-pay.html?session=${encodeURIComponent(id)}&ref=${encodeURIComponent(p.reference)}&amount=${p.amountCents}&label=${encodeURIComponent(p.label)}`;
    return { id, url };
  }
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": p.label,
    "line_items[0][price_data][unit_amount]": String(p.amountCents),
    "line_items[0][quantity]": "1",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    // Session éphémère : alignée sur le hold de 30 min (minimum Stripe).
    expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60),
    "metadata[payment_id]": String(p.paymentId),
    "metadata[reference]": p.reference,
    "payment_intent_data[description]": `${p.reference} — ${p.label}`,
  });
  if (p.customerEmail) body.set("customer_email", p.customerEmail);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Stripe checkout ${res.status}: ${stripeErrorText(await res.text(), cfg)}`);
  }
  const session = (await res.json()) as { id: string; url: string };
  return { id: session.id, url: session.url };
}

/** Vérification de la signature du webhook (Stripe-Signature: t=…,v1=…).
 *  HMAC-SHA256 de `${t}.${payload}` avec le signing secret, comparaison en
 *  temps constant, tolérance d'horloge 5 min. */
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSec = 300,
): Promise<boolean> {
  if (!sigHeader) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of sigHeader.split(",")) {
    const [k = "", v = ""] = part.split("=", 2).map((x) => x.trim());
    if (k === "t") timestamp = v;
    if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  const expected = toHex(new Uint8Array(mac));
  return signatures.some((sig) => timingSafeEqualHex(sig.toLowerCase(), expected));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Expire une session de checkout CÔTÉ STRIPE.
 *
 *  Sans ça, marquer un paiement `failed` en base ne ferme rien du tout : la
 *  page Stripe reste payable. Un client qui empile les onglets ou reclique
 *  peut donc payer deux sessions du même solde, et le webhook honore les deux
 *  — l'argent est encaissé deux fois (contre-review 2026-08-28).
 *
 *  Ne lève jamais : une session déjà expirée, déjà payée ou injoignable rend
 *  `false`. Le nettoyage local, lui, a toujours lieu — c'est l'appelant qui
 *  décide quoi faire de l'échec (ici : une ligne d'audit).
 *
 *  No-op en mode stub : il n'existe aucune session distante à fermer. */
export async function expireCheckoutSession(cfg: StripeConfig, sessionId: string): Promise<boolean> {
  if (!stripeEnabled(cfg) || !sessionId || sessionId.startsWith("stub_")) return false;
  try {
    const res = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.secretKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Payment Element — PaymentIntent (issue #26)
// ---------------------------------------------------------------------------

export interface PaymentIntentParams {
  paymentId: number;      // notre payments.id
  reference: string;      // PM-2026-001
  kind: string;           // deposit | balance | full — l'étape payée
  label: string;          // « Arrhes réservation PM-2026-001 — La Scierie »
  amountCents: number;    // figé depuis le devis serveur, jamais reçu du client
  customerEmail?: string | null;
}

/** Clé d'idempotence Stripe : réservation + étape + montant + tentative.
 *
 *  Les trois premiers composants sont ceux demandés (« idempotence par
 *  réservation+étape ») ; la tentative (`payments.id`) est indispensable et
 *  n'affaiblit rien. Sans elle, une seconde tentative après un refus de carte
 *  se verrait rendre le MÊME PaymentIntent, dont l'identifiant devrait alors
 *  être écrit sur deux lignes de `payments` — ce qu'interdit l'index UNIQUE
 *  partiel `idx_payments_session`, la clé de réconciliation du webhook. La
 *  protection contre le double encaissement ne vient donc pas d'ici : elle
 *  vient de l'annulation des intentions précédentes (`voidRemotePayment`) et
 *  de l'idempotence de `handlePaymentSuccess`. */
export function paymentIntentIdempotencyKey(p: PaymentIntentParams): string {
  return `gp-pi-${p.reference}-${p.kind}-${p.amountCents}-${p.paymentId}`;
}

/** Crée un PaymentIntent et rend de quoi monter le Payment Element.
 *
 *  Le `client_secret` est fait pour vivre dans le navigateur : il ne permet que
 *  de confirmer CE paiement, pour CE montant, qui est fixé ici, côté serveur. */
export async function createPaymentIntent(
  cfg: StripeConfig,
  p: PaymentIntentParams,
): Promise<{ id: string; clientSecret: string }> {
  if (!stripeEnabled(cfg)) throw new Error("Stripe non configuré");
  const body = new URLSearchParams({
    amount: String(p.amountCents),
    currency: "eur",
    description: `${p.reference} — ${p.label}`,
    "metadata[payment_id]": String(p.paymentId),
    "metadata[reference]": p.reference,
    "metadata[kind]": p.kind,
  });
  // PAS de `receipt_email` (contre-review Gemini 2026-08-30) : ce champ fait
  // envoyer un reçu par Stripe lui-même, hors de tout contrôle de la
  // plateforme — donc en doublon de notre `payment_receipt`, et en contournant
  // la discipline `EMAILS_ENABLED`. L'email du client part en métadonnée, pour
  // la réconciliation dans le tableau de bord Stripe, sans déclencher d'envoi.
  if (p.customerEmail) body.set("metadata[guest_email]", p.customerEmail);

  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": paymentIntentIdempotencyKey(p),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Stripe payment_intent ${res.status}: ${stripeErrorText(await res.text(), cfg)}`);
  }
  const intent = (await res.json()) as { id?: string; client_secret?: string };
  if (!intent.id || !intent.client_secret) throw new Error("Stripe payment_intent : réponse inexploitable");
  return { id: intent.id, clientSecret: intent.client_secret };
}

/** Annule un PaymentIntent CÔTÉ STRIPE — le pendant exact de
 *  `expireCheckoutSession` pour le paiement intégré.
 *
 *  Ne lève jamais : une intention déjà payée, déjà annulée ou en cours de
 *  traitement (Bancontact parti chez la banque) rend `false`. Le filet de
 *  dernier recours reste le contrôle de trop-perçu de `handlePaymentSuccess`. */
export async function cancelPaymentIntent(cfg: StripeConfig, intentId: string): Promise<boolean> {
  if (!stripeEnabled(cfg) || !intentId.startsWith("pi_")) return false;
  try {
    const res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(intentId)}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "cancellation_reason=abandoned",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Statuts dans lesquels un PaymentIntent NE PEUT PAS être annulé : l'argent
 *  est parti, ou il est en route. `processing` est le cas Bancontact — le
 *  client a validé chez sa banque, Stripe attend la confirmation. */
const UNCANCELLABLE_INTENT_STATUSES = new Set(["processing", "succeeded", "requires_capture"]);

/** Statut courant d'un PaymentIntent, ou `null` si Stripe est injoignable ou
 *  ne connaît pas cette intention. */
export async function paymentIntentStatus(cfg: StripeConfig, intentId: string): Promise<string | null> {
  if (!stripeEnabled(cfg) || !intentId.startsWith("pi_")) return null;
  try {
    const res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(intentId)}`, {
      headers: { authorization: `Bearer ${cfg.secretKey}` },
    });
    if (!res.ok) return null;
    const intent = (await res.json()) as { status?: string };
    return intent.status ?? null;
  } catch {
    return null;
  }
}

/** Une tentative de paiement est-elle DÉJÀ partie chez la banque du client ?
 *
 *  Le cas qui coûte de l'argent (contre-review Gemini 2026-08-30) : un client
 *  paie le solde par Bancontact, revient sur son voucher pendant que sa banque
 *  traite l'ordre, et reclique « Payer ». `payment_intents/{id}/cancel` refuse
 *  d'annuler une intention `processing` — on marquait pourtant la ligne locale
 *  `failed` et on en ouvrait une seconde. Les deux aboutissaient : double
 *  débit, rattrapé seulement a posteriori par l'alerte de trop-perçu.
 *
 *  Stripe injoignable rend `null` → `false` : on ne bloque pas un client sur un
 *  incident réseau, on retombe sur le comportement d'avant (annulation tentée,
 *  échec journalisé, alerte de trop-perçu en dernier recours). */
export async function remotePaymentInFlight(cfg: StripeConfig, ref: string): Promise<boolean> {
  if (!stripeEnabled(cfg) || !ref.startsWith("pi_")) return false;
  const status = await paymentIntentStatus(cfg, ref);
  return status !== null && UNCANCELLABLE_INTENT_STATUSES.has(status);
}

/** Ferme chez Stripe la tentative de paiement `ref`, quelle qu'en soit la
 *  forme : PaymentIntent (`pi_…`), session Checkout (`cs_…`) ou simulateur
 *  (`stub_…`, sans contrepartie distante). Un seul point d'appel pour
 *  `voidPendingSessions`, qui n'a pas à connaître le mode en cours — une
 *  réservation peut très bien porter les deux, si le mode a changé entre deux
 *  tentatives. */
export async function voidRemotePayment(cfg: StripeConfig, ref: string): Promise<boolean> {
  if (!stripeEnabled(cfg) || !ref || ref.startsWith("stub_")) return false;
  return ref.startsWith("pi_") ? cancelPaymentIntent(cfg, ref) : expireCheckoutSession(cfg, ref);
}

// ---------------------------------------------------------------------------
// Contrôle d'une clé et frais réels (compte Stripe par propriété)
// ---------------------------------------------------------------------------

export interface KeyTestResult {
  ok: boolean;
  /** Mode annoncé par Stripe (`livemode` de la réponse), pas celui du préfixe. */
  livemode?: boolean;
  /** Message lisible, jamais la clé. */
  error?: string;
}

/** Teste une clé secrète avec l'appel le plus léger de l'API : `GET /v1/balance`
 *  (lecture seule, aucun effet). Ne lève jamais ; l'erreur Stripe est rendue en
 *  clair (« Invalid API Key provided … »), sans jamais répéter la clé. */
export async function testStripeSecretKey(secretKey: string): Promise<KeyTestResult> {
  try {
    const res = await fetch(`${STRIPE_API}/balance`, { headers: { authorization: `Bearer ${secretKey}` } });
    const text = await res.text();
    let data: { livemode?: boolean; error?: { message?: string } } = {};
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      /* corps non JSON */
    }
    if (!res.ok) {
      const msg = (data.error?.message ?? `Stripe a répondu ${res.status}`).split(secretKey).join("[clé]");
      return { ok: false, error: msg.slice(0, 300) };
    }
    return { ok: true, livemode: data.livemode === true };
  } catch (e) {
    return { ok: false, error: `Stripe injoignable : ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
}

/** Frais Stripe et net d'un PaymentIntent payé, lus sur la transaction de solde
 *  de sa charge. `null` si Stripe ne les donne pas (encore) : ils sont alors
 *  affichés « inconnus » plutôt qu'inventés. Ne lève jamais. */
export async function fetchPaymentFees(
  cfg: StripeConfig,
  intentId: string,
): Promise<{ feeCents: number; netCents: number } | null> {
  if (!stripeEnabled(cfg) || !intentId.startsWith("pi_")) return null;
  try {
    const url = `${STRIPE_API}/payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge.balance_transaction`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.secretKey}` } });
    if (!res.ok) return null;
    const intent = (await res.json()) as {
      latest_charge?: { balance_transaction?: { fee?: unknown; net?: unknown } | string | null } | string | null;
    };
    const charge = intent.latest_charge;
    const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
    if (!bt || typeof bt !== "object") return null;
    if (typeof bt.fee !== "number" || typeof bt.net !== "number") return null;
    return { feeCents: bt.fee, netCents: bt.net };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Remboursements (annulation, CGV art. 5)
// ---------------------------------------------------------------------------

/** Rembourse `amountCents` d'un PaymentIntent (`POST /v1/refunds`). Lève en cas
 *  d'échec : l'appelant garde la ligne `payments` en `failed` et la rejoue.
 *
 *  L'`Idempotency-Key` est celle de la LIGNE de remboursement (`gp-refund-<id>`) :
 *  rejouer la même ligne après un délai de réseau ne rembourse jamais deux fois.
 *  Stripe refuse de toute façon de rembourser plus que l'encaissé. */
export async function createRefund(
  cfg: StripeConfig,
  p: { paymentIntent: string; amountCents: number; idempotencyKey: string; reference: string; refundRowId: number },
): Promise<{ id: string; status: string }> {
  if (!stripeEnabled(cfg)) throw new Error("Stripe non configuré");
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new Error("montant de remboursement invalide");
  const body = new URLSearchParams({
    payment_intent: p.paymentIntent,
    amount: String(p.amountCents),
    "metadata[reference]": p.reference,
    "metadata[origine]": "annulation",
    "metadata[refund_row]": String(p.refundRowId),
  });
  const res = await fetch(`${STRIPE_API}/refunds`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": p.idempotencyKey,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Stripe refund ${res.status}: ${stripeErrorText(await res.text(), cfg)}`);
  const refund = (await res.json()) as { id?: string; status?: string };
  if (!refund.id) throw new Error("Stripe refund : réponse inexploitable");
  return { id: refund.id, status: refund.status ?? "unknown" };
}

/** Retrouve chez Stripe le remboursement créé pour NOTRE ligne `refundRowId`
 *  (métadonnée `refund_row`), et non un montant agrégé : un remboursement fait à
 *  la main dans le tableau de bord ne doit pas passer pour le nôtre. `null` =
 *  Stripe ne l'a pas ; `"inconnu"` = Stripe injoignable ou réponse illisible. */
export async function findRefundForRow(
  cfg: StripeConfig,
  intentId: string,
  refundRowId: number,
): Promise<{ id: string; status: string } | null | "inconnu"> {
  if (!stripeEnabled(cfg) || !intentId.startsWith("pi_")) return "inconnu";
  try {
    const res = await fetch(`${STRIPE_API}/refunds?payment_intent=${encodeURIComponent(intentId)}&limit=100`, {
      headers: { authorization: `Bearer ${cfg.secretKey}` },
    });
    if (!res.ok) return "inconnu";
    const list = (await res.json()) as { data?: { id?: string; status?: string; metadata?: Record<string, string> }[]; has_more?: boolean };
    if (!Array.isArray(list.data)) return "inconnu";
    const hit = list.data.find((r) => r.metadata?.refund_row === String(refundRowId) && r.id);
    if (hit) return { id: String(hit.id), status: hit.status ?? "unknown" };
    return list.has_more ? "inconnu" : null;
  } catch {
    return "inconnu";
  }
}
