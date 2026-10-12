-- Quatre comptes testeurs (demande de Julien, 11/10/2026) : Arnold, Le Padre (papa), Gene, Matth.
-- Mots de passe PROVISOIRES transmis à Julien par Telegram, à changer à la première connexion.
-- Idempotent : ne touche pas à un compte déjà présent.
INSERT OR IGNORE INTO admin_users (username, password_hash, active) VALUES ('arnold', 'pbkdf2$30000$7iM27bm+BmRNhAzuKFedpA==$ilt5Z86SySQDNrgrSfOxMabkkgJL2SP8OXoAIlHHits=', 1);
INSERT OR IGNORE INTO admin_users (username, password_hash, active) VALUES ('lepadre', 'pbkdf2$30000$lOY4K/Z2LC4T7pHC3Cvp9A==$y890oLshafNyLktxBVm/08/g3lE0zzT2RRYBr0YeYnU=', 1);
INSERT OR IGNORE INTO admin_users (username, password_hash, active) VALUES ('gene', 'pbkdf2$30000$srorKizVbOkNYfFqz5aU8A==$MfR9mCrIK1AOIYr/cG6QTeT4c1OqcG4fxIrvA7SyJfU=', 1);
INSERT OR IGNORE INTO admin_users (username, password_hash, active) VALUES ('matth', 'pbkdf2$30000$fsjvMyRPapPa00TR3t/NeQ==$+iJzSFje2ueNmCJgUesO7waLI3lliMxCgTcGBhiome8=', 1);
