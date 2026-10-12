-- Migration 0030 — Relève IMAP de la boîte de contact des gîtes (décision de Julien, 11/10/2026).
-- Tous les messages reviennent dans la plateforme, avec leur origine (e-mail, Airbnb, Booking,
-- Vrbo, site). Les mails relevés vont dans `messages` (channel = 'email'), comme ceux de
-- Cloudflare Email Routing : `channel_messages` reste celle de Beds24 (réservation Beds24
-- obligatoire), un mail n'a pas de réservation Beds24.
--
--   in_reply_to  Message-ID auquel le mail répond (fil, et rattachement à une de nos réponses)
--   refs         en-tête References (identifiants <…> séparés par une espace, 20 derniers)
--   imap_uid     UID IMAP du mail dans INBOX (diagnostic ; le curseur vit dans app_settings)
--   attachments  JSON [{ "name": "...", "size": 1234 | null }] — pièces listées, jamais stockées
--   spoofed      1 : le mail prétend venir de l'adresse des gîtes sans que Gmail l'atteste
--
-- Les réponses sortantes par mail gardent le Message-ID SMTP dans message_id : la réponse du
-- client (In-Reply-To) retrouve ainsi sa réservation.

ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN refs TEXT;
ALTER TABLE messages ADD COLUMN imap_uid INTEGER;
ALTER TABLE messages ADD COLUMN attachments TEXT;
ALTER TABLE messages ADD COLUMN spoofed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to) WHERE in_reply_to IS NOT NULL;
