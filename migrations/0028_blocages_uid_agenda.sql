-- 0028 — Blocage manuel rattaché à un événement d'agenda externe
--
-- Pourquoi : l'import des agendas Google de papa (POST /api/admin/import/agenda-google)
-- transforme les événements « famille » et « usage de papa » (TLF, marche Lesse
-- et Lomme…) en blocages manuels, pas en ventes. Le flux iCal public du même
-- agenda continue pourtant de publier ces événements (« Busy ») : sans lien,
-- la synchronisation recréait une réservation sur un créneau bloqué, ou notait
-- un conflit à chaque passage.
--
-- external_uid porte la même clé que bookings.external_uid (« feed<id>:<UID iCal> ») :
-- syncFeed saute un événement dont l'UID est déjà tenu par un blocage.
-- Colonne nullable, aucune donnée existante touchée. Unicité partielle comme
-- pour les réservations.

ALTER TABLE manual_blocks ADD COLUMN external_uid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_blocks_external_uid ON manual_blocks(external_uid) WHERE external_uid IS NOT NULL;
