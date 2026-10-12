-- Mot de passe PROVISOIRE du compte « julien » (demande de Julien, 11/10/2026, bascule
-- sur Hetzner) : « premore-2026 », à changer dès la première connexion (Réglages › Comptes).
-- Les sessions ouvertes tombent avec l'ancien mot de passe. Ne crée rien : ne touche
-- qu'un compte « julien » existant.
UPDATE admin_users SET password_hash = 'pbkdf2$30000$EgjEIXxrAkCjr5HiM5FAGA==$FIBV2Mv4VuzYgMdjNbWnGAYZNknvruycr9Hl8axwpfk=', active = 1 WHERE username = 'julien';
DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM admin_users WHERE username = 'julien');
