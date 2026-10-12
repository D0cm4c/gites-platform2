// Clés Stripe par propriété (migration 0030, table `property_stripe`).
//
// Un compte Stripe par entité qui encaisse : chaque propriété a ses clés, saisies
// dans Réglages > Paiements. Résolution :
//   1. la propriété a une clé secrète en base  → ses trois clés, et AUCUNE de
//      l'environnement (mélanger la clé secrète d'un compte et la clé publique
//      d'un autre ferait échouer chaque paiement à l'écran) ;
//   2. sinon                                    → variables d'environnement (repli) ;
//   3. sinon                                    → mode simulateur.
//
// Stockage : EN CLAIR (aucun mécanisme de chiffrement au repos dans le projet,
// cf. migration 0030). Les clés ne sortent jamais par l'API : `propertyStripeView`
// ne rend que des indicateurs (posée ou non, date) ; seule la clé publiable, publique
// par nature, montre ses quatre derniers caractères. Les sauvegardes (export SQL et
// SQLite) en omettent les secrets.

import { modeOfSecretKey, stripeConfigFromEnv, type StripeConfig } from "./stripe";

export interface PropertyStripeRow {
  propertyId: number;
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  mode: "test" | "live";
  accountLabel: string | null;
  secretSetAt: string | null;
  publishableSetAt: string | null;
  webhookSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

type Raw = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function mapRow(r: Raw): PropertyStripeRow {
  return {
    propertyId: Number(r.property_id),
    secretKey: s(r.secret_key),
    publishableKey: s(r.publishable_key),
    webhookSecret: s(r.webhook_secret),
    mode: r.mode === "live" ? "live" : "test",
    accountLabel: s(r.account_label),
    secretSetAt: s(r.secret_set_at),
    publishableSetAt: s(r.publishable_set_at),
    webhookSetAt: s(r.webhook_set_at),
    updatedBy: s(r.updated_by),
    updatedAt: s(r.updated_at),
  };
}

export async function getPropertyStripe(db: D1Database, propertyId: number): Promise<PropertyStripeRow | null> {
  const row = await db.prepare("SELECT * FROM property_stripe WHERE property_id = ?1").bind(propertyId).first<Raw>();
  return row ? mapRow(row) : null;
}

/** Configuration effective d'une propriété (cf. l'en-tête). `propertyId` inconnu
 *  ou absent → repli sur l'environnement. */
export async function resolveStripeConfig(
  db: D1Database,
  env: Env,
  propertyId: number | null | undefined,
): Promise<StripeConfig> {
  if (propertyId != null) {
    const row = await getPropertyStripe(db, propertyId);
    if (row?.secretKey) {
      return {
        secretKey: row.secretKey,
        publishableKey: row.publishableKey,
        webhookSecret: row.webhookSecret,
        mode: row.mode,
        ui: stripeConfigFromEnv(env).ui,
        source: "property",
        propertyId,
      };
    }
  }
  return stripeConfigFromEnv(env, propertyId ?? null);
}

/** Propriété d'une réservation (via son logement). */
export async function propertyIdOfBooking(db: D1Database, bookingId: number): Promise<number | null> {
  const r = await db
    .prepare("SELECT u.property_id AS pid FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = ?1")
    .bind(bookingId)
    .first<{ pid: number }>();
  return r ? Number(r.pid) : null;
}

/** Propriété d'un paiement (via sa réservation). */
export async function propertyIdOfPayment(db: D1Database, paymentId: number): Promise<number | null> {
  const r = await db
    .prepare(
      "SELECT u.property_id AS pid FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id WHERE p.id = ?1",
    )
    .bind(paymentId)
    .first<{ pid: number }>();
  return r ? Number(r.pid) : null;
}

// --- saisie -----------------------------------------------------------------

export interface PropertyStripePatch {
  /** undefined = inchangée ; chaîne vide = effacée ; sinon = nouvelle valeur. */
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
  mode?: string;
  accountLabel?: string;
}

export class StripeKeyError extends Error {}

const SECRET_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,200}$/;
const PUBLISHABLE_RE = /^pk_(test|live)_[A-Za-z0-9]{8,200}$/;
const WEBHOOK_RE = /^whsec_[A-Za-z0-9]{8,200}$/;

/** Valide un lot de modifications et rend la ligne résultante (pas encore écrite).
 *  Chaque clé doit avoir la bonne forme ET le mode demandé (test ou réel) : une
 *  clé `sk_live_` posée sur une propriété « test » est refusée, pour qu'un
 *  encaissement réel ne parte pas par inadvertance. Les messages n'incluent
 *  jamais la valeur saisie. */
export function applyStripePatch(current: PropertyStripeRow | null, patch: PropertyStripePatch, now: string, by: string): PropertyStripeRow {
  const next: PropertyStripeRow = current
    ? { ...current }
    : {
        propertyId: 0, secretKey: null, publishableKey: null, webhookSecret: null, mode: "test", accountLabel: null,
        secretSetAt: null, publishableSetAt: null, webhookSetAt: null, updatedBy: null, updatedAt: null,
      };
  if (patch.mode !== undefined) {
    if (patch.mode !== "test" && patch.mode !== "live") throw new StripeKeyError("mode : « test » ou « live »");
    next.mode = patch.mode;
  }
  if (patch.accountLabel !== undefined) next.accountLabel = patch.accountLabel.trim().slice(0, 120) || null;

  const setKey = (
    field: "secretKey" | "publishableKey" | "webhookSecret",
    stamp: "secretSetAt" | "publishableSetAt" | "webhookSetAt",
    value: string | undefined,
    re: RegExp,
    label: string,
    form: string,
  ) => {
    if (value === undefined) return;
    const v = value.trim();
    if (v === "") {
      next[field] = null;
      next[stamp] = null;
      return;
    }
    if (!re.test(v)) throw new StripeKeyError(`${label} : forme inattendue (attendu ${form})`);
    next[field] = v;
    next[stamp] = now;
  };
  setKey("secretKey", "secretSetAt", patch.secretKey, SECRET_RE, "clé secrète", "sk_test_… ou sk_live_… (ou rk_…)");
  setKey("publishableKey", "publishableSetAt", patch.publishableKey, PUBLISHABLE_RE, "clé publiable", "pk_test_… ou pk_live_…");
  setKey("webhookSecret", "webhookSetAt", patch.webhookSecret, WEBHOOK_RE, "secret du webhook", "whsec_…");

  const secretMode = modeOfSecretKey(next.secretKey);
  if (secretMode && secretMode !== next.mode) {
    throw new StripeKeyError(`la clé secrète est une clé « ${secretMode === "live" ? "réel" : "test"} » mais le mode choisi est « ${next.mode === "live" ? "réel" : "test"} »`);
  }
  if (next.publishableKey) {
    const pkMode = next.publishableKey.startsWith("pk_live_") ? "live" : "test";
    if (pkMode !== next.mode) {
      throw new StripeKeyError(`la clé publiable est une clé « ${pkMode === "live" ? "réel" : "test"} » mais le mode choisi est « ${next.mode === "live" ? "réel" : "test"} »`);
    }
  }
  next.updatedBy = by;
  next.updatedAt = now;
  return next;
}

export async function savePropertyStripe(db: D1Database, propertyId: number, row: PropertyStripeRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO property_stripe (property_id, secret_key, publishable_key, webhook_secret, mode, account_label,
                                    secret_set_at, publishable_set_at, webhook_set_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(property_id) DO UPDATE SET
         secret_key = excluded.secret_key, publishable_key = excluded.publishable_key,
         webhook_secret = excluded.webhook_secret, mode = excluded.mode, account_label = excluded.account_label,
         secret_set_at = excluded.secret_set_at, publishable_set_at = excluded.publishable_set_at,
         webhook_set_at = excluded.webhook_set_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(
      propertyId, row.secretKey, row.publishableKey, row.webhookSecret, row.mode, row.accountLabel,
      row.secretSetAt, row.publishableSetAt, row.webhookSetAt, row.updatedBy, row.updatedAt,
    )
    .run();
}

// --- vue pour l'API (jamais de clé en clair) -----------------------------------

function hint(v: string | null): string | null {
  return v ? `…${v.slice(-4)}` : null;
}

export interface PropertyStripeView {
  propertyId: number;
  mode: "test" | "live";
  accountLabel: string | null;
  secret: { set: boolean; setAt: string | null; hint: string | null };
  publishable: { set: boolean; setAt: string | null; hint: string | null };
  webhook: { set: boolean; setAt: string | null; hint: string | null };
  /** Ce que le serveur utilisera réellement pour cette propriété. */
  effective: "property" | "env" | "none";
  /** Chemin (sans origine) à coller dans le tableau de bord Stripe. */
  webhookPath: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export function propertyStripeView(propertyId: number, row: PropertyStripeRow | null, effective: StripeConfig["source"]): PropertyStripeView {
  return {
    propertyId,
    mode: row?.mode ?? "test",
    accountLabel: row?.accountLabel ?? null,
    // Clé secrète et secret de webhook : présence et date seulement, aucun caractère.
    secret: { set: !!row?.secretKey, setAt: row?.secretSetAt ?? null, hint: null },
    publishable: { set: !!row?.publishableKey, setAt: row?.publishableSetAt ?? null, hint: hint(row?.publishableKey ?? null) },
    webhook: { set: !!row?.webhookSecret, setAt: row?.webhookSetAt ?? null, hint: null },
    effective,
    webhookPath: `/api/webhooks/stripe/${propertyId}`,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Vrai si au moins une propriété (ou l'environnement) peut encaisser par Stripe.
 *  Sert au drapeau « démo » du tunnel public : le simulateur n'est proposé que
 *  quand AUCUN compte Stripe n'est configuré. */
export async function anyStripeConfigured(db: D1Database, env: Env): Promise<boolean> {
  if (stripeConfigFromEnv(env).secretKey) return true;
  const r = await db.prepare("SELECT 1 AS x FROM property_stripe WHERE secret_key IS NOT NULL AND secret_key <> '' LIMIT 1").first();
  return !!r;
}
