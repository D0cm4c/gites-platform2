# Mise en ligne : ce qui reste avant la bascule complète

> Depuis le 11/10/2026 la production est sur Hetzner (voir docs/hebergement-hetzner.md) ;
> dev1.mdcdy.be reste en lecture comme retour arrière une semaine, puis s'éteint.


Décision de Julien du 10/10/2026 : **une seule version**. La production est le
site Node.js chez Infomaniak, `https://dev1.mdcdy.be` (hébergement web de
Matthieu, clone de `main` de `Almarcegui/gites-platform`). Cloudflare s'éteint.
Nous n'avons pas d'accès SSH : tout passe par HTTPS, GitHub et le Manager.

État au 10/10/2026 (lu par la sonde, sans rien écrire) : le site répond
(`/api/public/health` → `ok: true`), mais **le traitement planifié n'a jamais
tourné** (`lastCronAt: null`) — le Planificateur n'est pas posé.

> **Décision du 11/10/2026 : la production quitte Infomaniak pour un serveur Hetzner**
> administré par Claude, avec déploiement automatique au merge. La marche à suivre vit dans
> [`hebergement-hetzner.md`](hebergement-hetzner.md) ; les sections 1 (Manager Infomaniak) et
> 3 (domaine) ci-dessous ne valent que tant que dev1 reste la production.

Chaque case se coche à la main ; les gestes marqués **Julien** ou **Matthieu**
ne peuvent pas être faits depuis le dépôt.

## 0. Une seule adresse pour l'écran d'administration (10/10/2026)

`/admin/` sert le nouvel écran (`app/`, React). L'ancien back-office
(`public/admin/*.js`, `login.html`) est **supprimé** du dépôt. `/admin2/…`
redirige (301) vers `/admin/`, `/admin/login.html` vers `/admin/#/connexion`,
et les anciennes adresses d'écran (`#/dash`, `#/cal`, `#/resa`, `#/canaux`,
`#/ical`, `#/users`, `#/params`…) mènent au bon écran.

## 1. Le site lui-même (Manager Infomaniak)

- [ ] **Matthieu** — vérifier la **commande de build** du site Node : `dist/` et
      `public/admin/` (l'écran d'administration, construit depuis `app/`) ne sont
      pas versionnés : **sans build, `/admin/` répond 404**. Le serveur doit les construire
      au redémarrage (`npm ci && npm run build`, qui demande les dépendances de
      développement : TypeScript, et `app/` pour le back-office). Commande de
      démarrage : `node node/server.mjs`, Node 22 ou plus, **un seul processus**.
- [ ] **Matthieu** — `SQLITE_PATH` **hors du dossier cloné** (un redéploiement ne
      doit jamais toucher la base).
- [ ] **Matthieu** — variables obligatoires dans le Manager : `PUBLIC_BASE_URL`,
      `SQLITE_PATH`, `ADMIN_TOKEN`, `CRON_KEY` (cf. `.env.example`).
- [ ] **Matthieu** — **Planificateur de tâches** : `https://dev1.mdcdy.be/internal/cron?key=<CRON_KEY>`
      toutes les 15 minutes. Tant qu'il manque, la sonde du Mac reste rouge
      (et le dit sur Telegram toutes les 12 h) : ni rappels de solde, ni
      synchro Beds24, ni relève des messages des canaux.
- [ ] **Julien** (go) — `ADMIN_TOKEN=… CRON_KEY=… node node/verify-deploy.mjs https://dev1.mdcdy.be` :
      le test décisif (18 réservations simultanées, une seule passe) valide le
      verrouillage du disque de l'hébergeur. Il **écrit** sur le serveur (et
      annule ses réservations de test) : à lancer sur le go de Julien seulement.
      S'il échoue, ne pas ouvrir au public.

## 2. Les comptes

- [ ] **Julien** — comptes nominatifs du back-office (**Réglages › Comptes**) :
      julien, matthieu, papa ; `ADMIN_TOKEN` ne reste qu'en accès de secours.
- [ ] **Julien** — compte **`sauvegarde`** (Réglages › Comptes, identifiant exact
      `sauvegarde`) : il n'ouvre que l'export de la base. Puis, sur le Mac :

      ```bash
      mkdir -p ~/.config/gites
      cp "scripts/sauvegarde.env.example" ~/.config/gites/sauvegarde.env
      chmod 600 ~/.config/gites/sauvegarde.env
      # y coller le mot de passe affiché une seule fois, puis vérifier :
      /opt/homebrew/bin/python3 scripts/sauvegarde_nuit.py --cible infomaniak --origine manuel
      ```

      Quand cette commande écrit « OK infomaniak … », repointer la sauvegarde de
      nuit (plist canonique dans `🔧 Dev/LaunchAgents Tâches planifiées/plists/`,
      déjà à jour ; la PR doit être mergée et le clone principal à jour) :

      ```bash
      launchctl bootout gui/501/com.julien.gites-sauvegarde
      cp "$HOME/Documents/ClaudeVault/🔧 Dev/LaunchAgents Tâches planifiées/plists/com.julien.gites-sauvegarde.plist" ~/Library/LaunchAgents/
      launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.julien.gites-sauvegarde.plist
      ```

      La même commande rapatrie aussi les **photos** (`UPLOADS_DIR`) en
      archive `AAAA-MM-JJ-HHMMSS-gites-infomaniak-photos.tar`, même rotation
      que la base (lot 3). Tant que le serveur n'a pas reçu le lot 3, l'archive
      manque et la sauvegarde de nuit finit en ÉCHEC (la base, elle, est
      sauvegardée) : c'est voulu ; `--photos-facultatives` le tolère à la main.
      `make livrer` passe ce drapeau. Si `ADMIN_ALLOWED_IPS` est posé, rien à ajouter
      pour le Mac : la garde IP ne vise que les humains, le compte
      `sauvegarde` et les clés `svc:` passent depuis toute adresse.

      Jusque-là, le LaunchAgent chargé continue d'exporter l'ancienne base D1
      (`--cible prod`, ancien nom de `cloudflare`) et `make livrer` demande
      `SANS_SAUVEGARDE=oui`.

- [ ] **Julien** — première **clé d'accès de service** (pour Claude et
      `scripts/gites_admin.py`) : Réglages › Comptes › Accès de service ›
      « Créer une clé » (`claude-mac`), puis `~/.config/gites/service.env`
      (modèle `scripts/service.env.example`, chmod 600) ; vérifier par
      `/opt/homebrew/bin/python3 scripts/gites_admin.py sante`.

## 3. Le domaine

- [ ] **Julien** — choisir le domaine définitif (décision #12 « plus tard »),
      le faire pointer sur le site Infomaniak, certificat Let's Encrypt.
- [ ] Changer `PUBLIC_BASE_URL` : liens des vouchers et des mails, retours
      Stripe. Les écritures Beds24 ne dépendent plus du `https://` : poser
      `BEDS24_WRITE_ENABLED=true` (seule valeur qui les ouvre).
- [ ] Les anciennes adresses WordPress (`src/services/redirects.ts`) ne
      redirigent que sur le domaine définitif : vérifier après la bascule.
- [ ] Mettre à jour l'URL de la sonde (`scripts/gites_sonde.py`, plist
      `com.julien.gites-sonde`, `.github/workflows/sonde-sante.yml`,
      `scripts/livrer.py`, `sauvegarde.env`).

## 4. L'adresse mail `reservations@`

- [ ] **Julien** — créer la boîte `reservations@<domaine>` (Service Mail
      Infomaniak), SPF, DKIM et DMARC du domaine.
- [ ] Poser `SMTP_HOST=mail.infomaniak.com`, `SMTP_PORT=465`, `SMTP_USER`,
      `SMTP_PASSWORD`, `MAIL_FROM` dans le Manager (cf. `.env.example`).
- [ ] **À vérifier** : l'hébergement web laisse-t-il le site Node ouvrir une
      connexion sortante vers `mail.infomaniak.com:465` (ou 587) ? Un premier
      envoi en échec se lit dans `email_log.error_detail` (« SMTP : connexion
      à … impossible »).
- [ ] **Julien** (décision) — `EMAILS_ENABLED=true` : à partir de là, vouchers,
      reçus, rappels et réponses partent réellement.
- [ ] Mails entrants : pas d'équivalent à Cloudflare Email Routing chez
      Infomaniak ; à remplacer par une relève IMAP de la boîte, ou à laisser
      de côté (les échanges passent par la plateforme).

## 5. Beds24

- [ ] **Julien** (décision du 03/09 : pas d'abonnement pour l'instant) —
      l'abonnement, le jour où l'on pousse le site sur les plateformes.
- [ ] Nouveau code d'invitation avec les scopes `bookings`, `bookings-personal`,
      `inventory`, `properties` (la messagerie lit et écrit `/bookings/messages`),
      collé dans le back-office (Plateformes › Beds24 et canaux).
- [ ] Compte Beds24 vide ou identifiant périmé : **Créer la propriété sur
      Beds24** (même écran, carte « Compte Beds24 relié ») ; relire l'aperçu,
      confirmer, compléter dans Beds24 ce que la liste « à compléter » indique,
      puis **Pousser les calendriers**.
- [ ] Webhook réservation Beds24 vers `https://<domaine>/api/webhooks/beds24?key=<BEDS24_WEBHOOK_KEY>`.
- [ ] Première relève des messages : 30 jours en arrière, puis une par passage
      du cron ; quota lisible dans `app_settings.beds24_messages_last`.

## 6. Stripe

- [ ] **Julien** — un compte Stripe par entité qui encaisse (décision du 11/10), clés
      collées dans Réglages > Comptes Stripe (`docs/paiements-stripe.md`) ;
      `STRIPE_SECRET_KEY` et `STRIPE_PUBLISHABLE_KEY` d'environnement ne sont qu'un repli.
- [ ] Un endpoint de webhook Stripe PAR PROPRIÉTÉ, `https://<domaine>/api/webhooks/stripe/<id de la propriété>` (adresse affichée dans Réglages > Comptes Stripe ; voir `docs/paiements-stripe.md`),
      son secret `whsec_…` se colle dans le même écran.
- [ ] Turnstile (anti-robot) : `TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY`
      pour le domaine définitif (le serveur Node les transmet depuis le 10/10).

## 7. Les données

- [ ] **Julien** (décision) — reprendre ou non les données de la base D1
      (essai public du 03/08 : paiements simulés, courriels coupés) : si oui,
      `GET /api/admin/export.sql` sur le Worker, rejoué dans la base SQLite
      **avant** l'ouverture, site arrêté.

## 8. Arrêt du Worker Cloudflare

Dans cet ordre, sur le go de Julien :

- [ ] dernière sauvegarde D1 : `make sauvegarde-cloudflare` ;
- [ ] couper le déclencheur cron du Worker, puis le Worker lui-même
      (`gites-platform`), et le Worker d'essai si l'essai se fait désormais
      ailleurs ;
- [ ] retirer du dépôt `make livrer-cloudflare`, `make sauvegarde-cloudflare`,
      l'alias `--cible prod` de `scripts/sauvegarde_nuit.py`, et ce qui reste
      de `wrangler` pour la production ;
- [ ] archiver (pas supprimer) les sauvegardes `*-gites-platform.sql`.

## Déployer dev1 en une commande (procédure vérifiée le 11/10/2026)

Infomaniak refuse encore les clés SSH (« Private key authentication is
currently unavailable ») : une seule saisie de mot de passe par Julien, puis
tout s'enchaîne. La connexion est partagée (`ControlMaster`) et reste ouverte
une heure : Claude peut ensuite relancer des commandes sur le serveur sans
nouveau mot de passe.

```bash
ssh -t -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o ControlMaster=auto -o ControlPath=~/.ssh/cm-gites -o ControlPersist=3600 \
  Mb73XkJ5j1i_claudejuju@57-114997.ssh.hosting-ik.com \
  'cd /srv/customer/sites/dev1.mdcdy.be && git pull --ff-only && npm ci && npm run build && git log --oneline -1'
```

- Durée constatée : 5 min pour le serveur, **jusqu'à 1 h pour l'écran**
  (`vite build` bridé par Infomaniak en SSH). Le site reste servi pendant ce temps ;
  `/admin/` bascule sur le nouveau build dès que `public/admin/` est réécrit.
- Si la commande se termine sur `(END)`, c'est le pager de `git log` : touche `q`.
- Ensuite, commandes à la demande sans mot de passe tant que la connexion vit :
  `ssh -o ControlPath=~/.ssh/cm-gites Mb73XkJ5j1i_claudejuju@57-114997.ssh.hosting-ik.com '<commande>' < /dev/null`
  (une session sur deux rend parfois une sortie vide : réessayer).
- **Le processus Node ne tourne pas dans le conteneur SSH** (`ps` ne le voit pas) :
  le redémarrage, qui applique les migrations et recharge `.env`, passe
  obligatoirement par le Manager → Hébergement web → site Node.js
  `dev1.mdcdy.be` → Redémarrer. Session Manager = Matthieu ou Julien ; Claude peut
  cliquer le bouton depuis une session déjà ouverte dans le Chrome de Julien.
- Contrôle après redémarrage : `GET /api/admin/ical` doit renvoyer le champ
  `departureDayIncluded` (migration 0029 appliquée) ; `node/verify-deploy.mjs https://dev1.mdcdy.be`.
