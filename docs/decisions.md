# Registre des décisions de Julien

Les arbitrages du propriétaire du projet, datés, du plus récent au plus ancien.
Une décision s'ajoute ici le jour où elle est prise ; elle ne se réécrit pas :
si elle change, une nouvelle ligne datée la remplace et le dit.

Ce registre ne contient ni donnée de voyageur, ni montant réel, ni identifiant de
compte. Les questions juridiques (obligations légales, CGV) se traitent hors de
ce dépôt : il n'en garde que la conséquence pour le code.

## 2026-10-11 — Tous les messages reviennent dans la plateforme

La boîte Gmail dédiée est l'adresse de contact des gîtes. La plateforme la relève (IMAP) et
chaque message porte son origine : e-mail, Airbnb, Booking, Vrbo ou site. On répond depuis
Messages, jamais à la main dans Gmail : le but est de réduire les mails au minimum, tout
passe par l'outil. Détail et limites : `docs/messagerie.md`.

## 2026-10-10 — Une seule version : Infomaniak

- **La production est le site Node.js chez Infomaniak** (`https://dev1.mdcdy.be`,
  hébergement de Matthieu, clone de `main`) ; redéployer = merger dans `main` puis
  redémarrer le site dans le Manager ; le Planificateur Infomaniak tient lieu de
  cron. **Cloudflare s'éteint** (liste des étapes : `docs/mise-en-ligne.md`).
- Pas d'accès SSH : sauvegarde de nuit tirée depuis le Mac par HTTPS (compte
  réservé `sauvegarde`), sonde depuis le Mac avec alerte Telegram, mails par la
  boîte SMTP Infomaniak (`reservations@` sur le domaine définitif).
- Les messages Airbnb / Booking (par Beds24) arrivent dans la boîte Messages de
  la plateforme et se répondent depuis elle.

## 2026-10-09 — Méthode de travail

- **« Go » pour reprendre la méthode de l'application Greffe** : un `Makefile` aux
  verbes français (`make check`, `make livrer`…), un environnement d'essai séparé
  de la production, une sauvegarde de nuit de la base, ce registre et un journal
  des séances (`docs/journal-des-seances.md`).
- **Transfert du dépôt vers le compte GitHub `Almarcegui`** prévu
  (`Almarcegui/gites-platform`) ; il attend un geste de Julien (le transfert se
  fait depuis le compte propriétaire actuel).
- Essai de **Graphify** (graphe du code, local, sans modèle) sur les trois
  applications ; jamais son hook d'installation automatique.

## 2026-09-03 — Beds24

- Fin de l'essai gratuit Beds24 : **pas d'abonnement pour l'instant**. Il faudra le
  prendre quand on voudra pousser le site sur les plateformes (lot distribution),
  pas avant.

## 2026-08-30 — Vague 4

- Paiement intégré à la page (Payment Element), recettes rapatriées, anti-robot
  Turnstile (inactif sans clés), prix conseillé appliqué au canal : **mergé et
  déployé** sur « tu peux continuer », avec accord explicite sur la migration 0021.

## 2026-08-28 — Décisions en lot

- **Déploiement en production autorisé après validation** (« dès que c'est validé
  tu peux déployer ») pour la vague 3 ; chaque migration distante reste soumise à
  son accord explicite, précédée d'une sauvegarde de la base.
- Réponses aux issues `decision-julien` : grille tarifaire (#2) plus tard ; adresse
  de contact (#4) : un alias `info@…`, domaine à définir ; plateformes (#8) : via
  Beds24, dans un second temps ; pages légales (#9) : à rédiger, sans mention de
  TVA, numéro d'enregistrement laissé vide ; enregistrement (#10) plus tard ;
  Stripe (#11) : créer le compte, étudier coûts et marges d'abord ; domaine et
  courriels (#12), import elloha (#28), résiliation elloha (#39) : plus tard.
- Paquets 2 et 3 de l'audit d'utilisation : suivre les recommandations
  (issues #66-#74) ; R23 et R27 écartées.
- Conditions de vente : arrhes symétriques assumées, animaux sur demande, **arrhes
  à 50 %, paramétrables par hébergement** (issue #75).
- **Le juridique ne va pas sur GitHub** : le dépôt sert au développement ; le texte
  des conditions et pages légales est fourni au code, pas débattu dans les issues.

## 2026-08-10 — Beds24 et feuille de route

- Essai Beds24 laissé expirer, sans abonnement : aucune annonce n'y est reliée.
  La liaison se rétablit depuis le back-office (Canaux OTA) le jour venu.
- Les 40 issues de la feuille de route sont traitées avant le paquet 2 de l'audit ;
  les PR peuvent être mergées une fois la CI verte, **sauf les migrations, relues
  par Julien**.

## 2026-08-05 — GitHub

- Le code passe dans un **dépôt GitHub autonome et privé**, pour travailler à deux
  avec son frère (organisation : `COLLABORATION.md`). Rien n'y entre de l'historique
  antérieur.

## 2026-08-03 — Mise en ligne de test

- **Test public sur Cloudflare** : Worker `gites-platform` et base D1 dédiés,
  courriels coupés, paiement simulé. La cible Infomaniak reste ouverte (la couche
  Node + SQLite est entretenue).

## 2026-07-31 — Lot A0 et Infomaniak

- **« Vas-y » sur le lot A0** : les dix correctifs bloquants de l'audit technique
  (garde admin fermée par défaut, confirmation atomique, etc.).
- Portage Node + SQLite pour Infomaniak : **on garde SQLite**, la garantie
  anti-surréservation repose sur la sérialisation de ses écritures.

## 2026-07-28 — Beds24

- Créer la propriété et les hébergements chez Beds24 depuis la plateforme, et lier
  le programme (synchronisation sortante, puis entrante).

## 2026-07-27 — Canaux

- Pas d'API Airbnb directe (fermée) : chaque annonce est créée une fois à la main,
  puis pilotée par un intermédiaire certifié (Beds24 recommandé).

## 2026-07-18 — Lot 0 (en partie)

- **Garantie = arrhes, pas de caution.**
- L'exploitant est une personne physique, sans TVA ; il crée lui-même son compte
  Stripe, la plateforme se branche sur les clés reçues.
- **Un seul site**, piloté par la plateforme ; le domaine est indifférent.
- Le site ne devient jamais « consumériste » : seulement de l'information
  factuelle calculée (fenêtres libres, délais de réservation).
- Portabilité : données SQLite exportables, site statique, couche Worker
  adaptable en quelques jours si l'on change d'hébergeur.

## 2026-07-12 — Cadrage

- Le cœur du besoin est le **système de gestion** (réservation directe, paiement en
  ligne, tarification fine, statistiques), pas le site vitrine.
- La liaison « maison A / maison B / domaine entier » doit être **instantanée et
  native** dans le moteur (le contournement par confirmation différée est refusé).
- Reprendre les meilleures fonctions d'elloha, Beds24, Smoobu, Lodgify, Chanlify.
- Style sobre, efficace, utilitaire, avec des pages de statistiques.
- **Les échanges avec les clients passent par la plateforme**, sans dépendre du
  courriel.
- **Toute publication est une décision explicite de Julien.**
