-- Migration 0030 — un compte Stripe par propriété (décision de Julien du 11/10/2026).
-- Les Gîtes du Pré Moré (propriété 1) et Le Moulin de Braives (propriété 2) encaissent
-- chacun sur leur compte bancaire, donc chacun sur leur compte Stripe.
--
-- property_stripe : les clés de chaque propriété, saisies dans Réglages > Paiements.
--   Une propriété SANS ligne (ou sans clé secrète) retombe sur les variables
--   d'environnement STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET.
--   Les clés ne sont JAMAIS renvoyées par l'API : seuls leur présence et la date de pose le sont.
--   ATTENTION, stockage en clair : le projet n'a aucun mécanisme de chiffrement au repos
--   (service_keys ne garde qu'un SHA-256, ce qui ne convient pas à une clé qu'il faut
--   rejouer chez Stripe). La protection est donc celle de la base elle-même et de ses
--   sauvegardes, comme pour le refresh token Beds24 déjà en app_settings.
--
-- payments.stripe_fee_cents / stripe_net_cents : frais Stripe et net réellement perçu,
--   relevés chez Stripe après l'encaissement (NULL tant qu'inconnus).

CREATE TABLE property_stripe (
  property_id INTEGER PRIMARY KEY REFERENCES properties(id),
  secret_key TEXT,
  publishable_key TEXT,
  webhook_secret TEXT,
  mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  account_label TEXT,
  secret_set_at TEXT,
  publishable_set_at TEXT,
  webhook_set_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE payments ADD COLUMN stripe_fee_cents INTEGER;
ALTER TABLE payments ADD COLUMN stripe_net_cents INTEGER;
