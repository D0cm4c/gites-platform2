# Hébergement Hetzner : le serveur que Claude administre

Décision de Julien du 11/10/2026 : quitter l'hébergement mutualisé Infomaniak (dev1.mdcdy.be)
pour un petit serveur Hetzner Cloud. Cette fiche est écrite pour Julien et Matthieu.

## Pourquoi

Sur dev1, rien ne se fait sans un geste humain : pas de clé SSH, le redémarrage passe par un
Manager, le build est bridé à une heure, le traitement planifié n'a jamais tourné. Sur un
petit serveur à nous, Claude se connecte par clé SSH et tient l'ensemble seul. Le but :

> **Un merge sur `main` = le site est à jour, redémarré, migrations appliquées, sans aucun geste humain.**

## Ce que ça coûte

Un petit serveur Hetzner Cloud (CX22 : 2 processeurs, 4 Go de mémoire, 40 Go de disque, ou
l'équivalent ARM CAX11) coûte de l'ordre de **4 à 6 € par mois**, adresse IPv4 comprise,
payée par carte à la fin du mois. Le tarif exact du jour est à lire sur la page de prix de
Hetzner au moment de la commande. Le nom de domaine `.be` ajoute environ 10 à 15 € par an.
Les sauvegardes Hetzner automatiques (option à environ 20 % du prix du serveur) sont
facultatives : le serveur fait ses propres sauvegardes, et le Mac en tire une copie la nuit.

Choix retenus (hypothèses, modifiables) : **CX22, Falkenstein (ou Nuremberg), Debian 12**
(Ubuntu 24.04 fonctionne pareil), site sur le port **8787** derrière Caddy.

## Ce qui se trouve sur le serveur

| Quoi | Où |
|---|---|
| Code (clone de `main`) | `/srv/gites/app` |
| Base SQLite et photos | `/srv/gites/data` (jamais dans le dossier du code) |
| Sauvegardes locales (14 jours) | `/srv/gites/backups` |
| Variables et secrets | `/srv/gites/.env` (lisible par `gites` seul) |
| Journal des déploiements | `/srv/gites/deploy.log` |

Services : `gites` (le site, redémarré tout seul s'il tombe), `caddy` (HTTPS automatique),
`gites-cron.timer` (le traitement planifié toutes les 15 minutes), `gites-backup.timer`
(sauvegarde à 3 h 30). Pare-feu : 22, 80, 443 seulement. Par l'adresse IP, en HTTP, seule la sonde répond (le
back-office ne passe jamais en clair). Le processus web ne peut écrire que dans `/srv/gites/data`. SSH par clé seulement, `root`
interdit, `fail2ban`, mises à jour de sécurité automatiques.

Deux utilisateurs : `claude` (administrateur, clé de Claude) et `gites` (fait tourner le site ;
droit de root limité à `systemctl restart gites`). La clé de GitHub Actions n'ouvre que
`/srv/gites/deploy.sh`.

## Ce que fait Julien (une fois, une dizaine de minutes)

1. **Créer le compte Hetzner Cloud** (console.hetzner.cloud), vérification d'identité demandée
   par Hetzner, puis **ajouter la carte bancaire**.
2. **Créer un projet** (ex. « gites »).
3. **Coller la clé publique SSH de Claude.** Claude la génère sur le Mac avec cette commande
   (à lancer par Claude, pas par ce document) :

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/gites_hetzner_ed25519 -C claude-gites
   ```

   et une seconde, pour GitHub Actions :

   ```bash
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/gites_deploy_actions_ed25519 -C github-actions-gites
   ```

   Claude fabrique alors le fichier à coller (`deploy/hetzner/preparer-cloud-init.sh
   ~/.ssh/gites_hetzner_ed25519.pub ~/.ssh/gites_deploy_actions_ed25519.pub`). Il ne contient
   que des clés publiques.
4. **Créer le serveur** : projet « gites », CX22, Falkenstein ou Nuremberg, Debian 12, IPv4
   activée ; dans « Cloud config », coller le fichier fabriqué par Claude. Noter l'adresse IP
   et la donner à Claude. C'est tout : à partir de là, Claude fait le reste.

## Ce que fait Claude

- **Installation** : `deploy/hetzner/installer.sh <ip> <domaine>` (attend le serveur, pose
  Caddy, les services, `.env` avec des jetons tirés au hasard sur le serveur, clone, premier
  déploiement, vérification). Relançable sans casse.
- **Clé de lecture du dépôt** : le serveur crée sa propre clé, dont la partie privée ne le
  quitte jamais (`/home/gites/.ssh/deploy_github`). Claude enregistre la partie publique
  comme *deploy key* GitHub **en lecture seule** (`gh repo deploy-key add … --repo
  Almarcegui/gites-platform`, sans `--allow-write`).
- **Secrets GitHub Actions** : `DEPLOY_HOST` (adresse du serveur), `DEPLOY_USER` (`gites`),
  `DEPLOY_SSH_KEY` (clé privée `gites_deploy_actions_ed25519`), `DEPLOY_KNOWN_HOSTS`
  (clé d'hôte du serveur, obligatoire). `installer.sh` les pose lui-même par `gh secret set`
  quand `gh` est connecté au compte Almarcegui.
- **Déploiement automatique** : `.github/workflows/deploy.yml` se lance quand le workflow CI
  est vert sur un push dans `main` (c'est-à-dire à chaque merge), se connecte au serveur et
  lance `deploy.sh`. Lancement manuel possible : onglet Actions > Deploy > Run workflow.
- **Déploiement depuis le Mac, sans GitHub** :

  ```bash
  ssh -i ~/.ssh/gites_hetzner_ed25519 gites@<serveur> /srv/gites/deploy.sh   # ou : make deployer-hetzner HETZNER_HOST=<serveur>
  ```

- **Ce que fait `deploy.sh`** : verrou (un seul déploiement à la fois), `git fetch` et `git
  reset --hard origin/main`, `npm ci`, `npm run build`, redémarrage du service (les
  migrations s'appliquent au démarrage), puis attend que `/api/public/health` réponde. Tout est
  écrit dans `/srv/gites/deploy.log`. Si le build échoue, le site en cours n'est pas
  redémarré (le processus déjà lancé continue avec ce qu'il a en mémoire ; les fichiers du
  dossier peuvent toutefois être à moitié remplacés : une version avec dossiers de livraison
  et bascule atomique est une amélioration possible, pas nécessaire à cette échelle).
  GitHub Actions transmet le commit exact validé par CI ; un commit plus ancien que celui
  déjà en place est ignoré.
- **Sonde** : `make sonde-hetzner HETZNER_URL=https://<domaine>`.
- **Changer Caddy ou les unités systemd** : seul `claude` peut le faire (`installer.sh` se
  relance et réinstalle les fichiers). Un merge ne les modifie pas.

## L'ordre de bascule

Avant, tout se prépare sans toucher à dev1 :

1. Serveur créé, `installer.sh` passé, site joignable sur `http://<ip>` et sur un
   sous-domaine provisoire (enregistrement DNS A chez Cloudflare, en « DNS seulement », nuage
   gris, le temps que Caddy obtienne son certificat).
2. Julien colle ses clés dans `/srv/gites/.env` (Stripe, Beds24, SMTP : Claude le guide, rien
   ne passe par le chat), `EMAILS_ENABLED` et `BEDS24_WRITE_ENABLED` restent à `false`.
3. Un déploiement par merge a réussi une fois (le test de bout en bout).

Le jour de la bascule (coupure de quelques minutes) :

1. **Ne plus rien écrire sur dev1** (pas de réservation à la main, pas de réglage dans le
   back-office). On ne peut pas le geler techniquement sans Manager : c'est une consigne.
2. `deploy/hetzner/migrer-depuis-dev1.sh <ip> <domaine> --sauvegarde-fraiche` : copie neuve
   de dev1 (`export.sqlite` + photos), pose dans `/srv/gites/data`, redémarre, compare le
   nombre de réservations, de photos et l'`integrity_check`. Il refuse de continuer s'il y a
   un écart.
3. **DNS** : l'enregistrement du domaine pointe sur le serveur Hetzner. Attendre le
   certificat (`make sonde-hetzner HETZNER_URL=https://<domaine>`).
4. **Beds24** : nouveau code d'invitation collé dans Plateformes > Beds24 ; webhook sur
   `https://<domaine>/api/webhooks/beds24?key=<BEDS24_WEBHOOK_KEY>` ; `PUBLIC_BASE_URL` à jour ;
   puis `BEDS24_WRITE_ENABLED=true` (sur la décision de Julien).
5. **Stripe** : endpoint du webhook sur `https://<domaine>/api/webhooks/stripe`.
6. **iCal** : regénérer les adresses iCal du back-office et les rebrancher chez Airbnb et
   Booking (elles contiennent l'ancien domaine).
7. **Sauvegarde du Mac** : repointer `scripts/sauvegarde_nuit.py`, la sonde du Mac
   (`gites_sonde.py`), `livrer.py` et `sauvegarde.env` sur le nouveau domaine. Le compte
   `sauvegarde` est repris avec la base.

## Retour arrière

- **Avant la bascule** : rien à faire, dev1 n'a pas été touché.
- **Après la bascule, si ça ne va pas** : remettre le DNS sur dev1 (il est resté en
  l'état, base d'avant la bascule). Les réservations prises entre-temps sur Hetzner sont dans
  `/srv/gites/data/gites.db` : à reporter à la main, d'où l'intérêt de décider vite.
- **Un déploiement qui casse le site** : `ssh gites@<serveur> /srv/gites/deploy.sh <commit-précédent>`
  (le commit précédent est dans `/srv/gites/deploy.log`). Attention : une migration déjà
  appliquée ne se défait pas ; en cas de doute, restaurer la sauvegarde de nuit
  (`/srv/gites/backups/*-gites.sqlite.gz`).

## Sauvegardes

Sur le serveur : chaque nuit à 3 h 30, `VACUUM INTO` (copie cohérente) compressée, plus une
archive des photos, 14 jours gardés (les trois plus récentes ne sont jamais effacées). Sur le
Mac : la sauvegarde de nuit continue de tirer `export.sqlite` et `export-uploads.tar` par
HTTPS (compte `sauvegarde`) : c'est la copie hors du serveur, indispensable.

## Ce que devient Infomaniak

Il reste intact (lecture seule, c'est le retour arrière) **une semaine** après la bascule.
Si la semaine se passe bien : dernière sauvegarde, puis Matthieu éteint le site Node dev1 et
le Planificateur. L'hébergement lui-même et le Service Mail (`reservations@`) sont à
conserver tant que la boîte mail y est.

## Ce qui n'est pas couvert

- Le site et les déploiements partagent l'utilisateur `gites` ; l'isolement du processus web
  repose sur systemd (système de fichiers en lecture seule hors `data`), pas sur deux comptes.
- Pas de CSP stricte dans Caddy (risque de casser Stripe/Turnstile) : à étudier ensuite.
- Le serveur n'est pas redondant : une panne de Hetzner = coupure jusqu'à restauration
  depuis les sauvegardes (une demi-heure avec ce dépôt).
- Courrier entrant (`reservations@`) : voir `docs/mise-en-ligne.md` § 4.
