-- Migration 0035 : remarques d'amélioration des testeurs (demande de Julien, 11/10/2026).
--
-- Le bouton « Amélioration ? » de l'écran d'administration envoie ici la
-- remarque d'une personne connectée, avec la page où elle se trouvait. L'écran
-- Réglages › Améliorations en fait le suivi. Aucune suppression : une remarque
-- écartée reste, avec son statut.
--
-- author : compte admin connecté (ou « svc:<nom> » pour une clé de service).
-- page_path : adresse dans l'écran (ex. /reglages/tarifs), page_title : son titre.
-- user_agent : coupé à 160 caractères ; viewport_width : largeur de la fenêtre en pixels.
-- Pas de capture d'écran en v1.

CREATE TABLE IF NOT EXISTS improvement_requests (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  author TEXT NOT NULL,
  page_path TEXT NOT NULL CHECK (length(page_path) BETWEEN 1 AND 300),
  page_title TEXT CHECK (page_title IS NULL OR length(page_title) <= 200),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 3 AND 2000),
  status TEXT NOT NULL DEFAULT 'nouveau' CHECK (status IN ('nouveau', 'en_cours', 'fait', 'ecarte')),
  admin_note TEXT CHECK (admin_note IS NULL OR length(admin_note) <= 2000),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 160),
  viewport_width INTEGER
);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_status ON improvement_requests (status, created_at);
