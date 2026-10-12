-- 0030 — Journal des mails : pièces jointes, et verrou de la confirmation automatique
--
-- Le mail de confirmation part avec le contrat de location en PDF. Le journal
-- (email_log) garde le texte du message ; cette colonne dit en plus quelles
-- pièces jointes sont parties, par leur nom et leur taille en octets, jamais
-- leur contenu. Vide ou NULL : aucune pièce jointe.

ALTER TABLE email_log ADD COLUMN attachments TEXT;

-- Verrou d'envoi unique de la confirmation automatique : une ligne par
-- réservation, posée AVANT l'envoi (INSERT OR IGNORE). Deux déclenchements
-- simultanés (webhook rejoué, double clic) ne passent donc jamais tous les
-- deux. La ligne est retirée si l'envoi échoue, pour qu'il puisse être retenté.
-- Le renvoi manuel ne s'en occupe pas.
CREATE TABLE confirmation_claims (
  booking_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
