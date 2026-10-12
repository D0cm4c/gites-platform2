-- 0029 — Convention de lecture d'un calendrier relié : jour de départ inclus
--
-- Pourquoi : la norme (Airbnb, Booking, Beds24, RFC 5545) va du jour d'arrivée
-- au jour de départ EXCLU : le jour du départ reste libre pour l'arrivée
-- suivante. Papa, lui, bloque aussi le jour du départ dans ses agendas Google
-- (« du 22 à 16 h au 26 à 10 h » = événement affiché du 22 au 26, soit un DTEND
-- exclusif au 27). Lu à la norme, chaque séjour compte une nuit de trop et le
-- jour de départ passe pour occupé (mesuré le 11/10/2026 : 8 événements sur 8
-- qui donnent l'heure de départ). Décision Julien 11/10/2026 : la plateforme
-- travaille à la norme partout ; les agendas de papa gardent leur convention
-- et sont lus (et plus tard écrits) avec ce réglage.
--
-- Vaut pour les événements « journée entière » seulement : un événement à
-- l'heure donne déjà la bonne date de départ.

ALTER TABLE ical_feeds ADD COLUMN departure_day_included INTEGER NOT NULL DEFAULT 0;

-- Les agendas Google déjà reliés (ceux de papa) suivent sa convention.
UPDATE ical_feeds SET departure_day_included = 1 WHERE url LIKE '%calendar.google.com%';
