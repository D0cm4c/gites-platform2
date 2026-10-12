# Paiements Stripe : un compte par propriété

Décision de Julien du 11/10/2026 : chaque entité qui encaisse a son propre compte
bancaire, donc son propre compte Stripe.

| Propriété | Id | Compte Stripe |
|---|---|---|
| Les Gîtes du Pré Moré (le Scieur, la Scierie, le Domaine) | 1 | à créer |
| Le Moulin de Braives | 2 | à créer |

Les clés se collent dans **Réglages > Comptes Stripe** du back-office. Elles sont
rangées dans la base, par propriété, et ne sont plus jamais réaffichées ensuite.

## 1. Ce que Julien prépare avant de créer un compte Stripe

Pour chaque entité (une par compte) :

- l'identité de l'entité : dénomination, forme juridique, numéro d'entreprise (BCE), adresse du siège ;
- le représentant légal : pièce d'identité (recto verso), date de naissance, adresse ;
- l'IBAN du compte bancaire sur lequel l'entité veut recevoir les paiements, et le nom du titulaire (il doit être celui de l'entité) ;
- l'adresse du site (`https://…`), une description de l'activité (location de gîtes de vacances) et les conditions générales de vente affichées sur le site ;
- une adresse e-mail propre à l'entité, pas la même pour les deux comptes (Stripe refuse deux comptes sur un même e-mail).

Stripe peut demander des justificatifs supplémentaires (statuts, preuve d'adresse). Tant que le compte n'est pas
activé, on travaille en mode **test**.

## 2. Où trouver les clés

Tableau de bord Stripe, de l'entité concernée.

- **Mode test** : interrupteur « Mode test » en haut à droite du tableau de bord activé, puis **Développeurs > Clés API**.
  - Clé publiable : `pk_test_…`
  - Clé secrète : `sk_test_…` (bouton « Révéler la clé de test », à copier tout de suite)
- **Mode réel** : mode test désactivé, même page. `pk_live_…` et `sk_live_…`. La clé secrète réelle n'est montrée qu'une fois à la création : la copier aussitôt, sinon en créer une nouvelle.
- **Secret du webhook** : voir le point 4. `whsec_…`, propre à chaque point de terminaison, test et réel ayant chacun le leur.

Une clé « restreinte » (`rk_…`) fonctionne aussi si elle a les droits d'écriture sur PaymentIntents, Checkout Sessions et la lecture sur Balance.

## 3. Les coller dans Réglages

Réglages, rubrique « Clients et argent », **Comptes Stripe** : une section par propriété.

1. Choisir **Test** ou **Réel** (le mode doit correspondre aux clés : le serveur refuse une clé `sk_live_` sur une propriété réglée « Test », pour qu'aucun vrai paiement ne parte par erreur).
2. Coller la clé secrète, la clé publiable, le secret du webhook. Un champ laissé vide garde la valeur actuelle ; les champs ne sont jamais préremplis.
3. **Enregistrer**, puis **Tester la clé** : le serveur interroge Stripe (`GET /v1/balance`, lecture seule) et dit si la clé est acceptée, avec l'erreur de Stripe en clair sinon.

L'écran dit pour chaque propriété ce que le serveur utilise vraiment :
ses propres clés, le repli d'environnement, ou rien (paiements simulés).

Poser ou changer une clé exige une session humaine : une clé de service (Claude, scripts) est refusée.

## 4. Le webhook de chaque propriété

Stripe prévient la plateforme quand un paiement aboutit : c'est cette notification, jamais le retour du navigateur, qui confirme une réservation.

Chaque propriété a **sa propre adresse** (affichée dans Réglages, avec un bouton Copier) :

- Pré Moré : `https://<domaine>/api/webhooks/stripe/1`
- Moulin de Braives : `https://<domaine>/api/webhooks/stripe/2`

Dans le tableau de bord Stripe de l'entité : **Développeurs > Webhooks > Ajouter un point de terminaison**, coller l'adresse, puis cocher les événements :

- `checkout.session.completed`
- `checkout.session.expired`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`

Ce sont les quatre que le code traite. `charge.refunded` n'est pas traité (un remboursement se saisit à la main dans la plateforme) : inutile de le cocher.

Puis copier le **secret de signature** (`whsec_…`) du point de terminaison dans le champ « Secret du webhook » de la même propriété. À faire une fois en test, une fois en réel (deux points de terminaison, deux secrets : on remplace le secret lors du passage au réel).

Pourquoi une route par propriété plutôt qu'une route unique : la signature est vérifiée avec le secret de la propriété de l'adresse, et seulement celui-là. Une erreur de configuration (deux comptes collés sur la même adresse) se voit tout de suite, et une propriété ne peut jamais valider l'événement d'une autre. Même signé, un événement dont le paiement appartient à une autre propriété est ignoré et noté au journal (`webhook.property_mismatch`).

## 5. Passage du test au réel

1. Le compte Stripe de l'entité est activé (Stripe a validé identité et IBAN).
2. En mode test, une réservation complète de bout en bout : carte `4242 4242 4242 4242`, date future, n'importe quel CVC. Bancontact se teste par le simulateur de Stripe. Vérifier que la réservation passe en « confirmée » et que le paiement apparaît dans **Encaissements Stripe**.
3. Dans Réglages > Comptes Stripe, propriété concernée : coller les clés **réelles** (`sk_live_…`, `pk_live_…`) et le secret du webhook du point de terminaison **réel**, puis passer le mode sur **Réel** dans le même enregistrement.
4. **Tester la clé** : le message doit dire « compte réel ».
5. Un premier vrai paiement de faible montant, puis remboursement depuis le tableau de bord Stripe, avant d'ouvrir au public.

Retour en arrière : effacer les trois clés (champ vidé, Enregistrer) ramène la propriété sur le repli d'environnement, ou sur le simulateur s'il n'y en a pas.

## 6. Encaissements Stripe (rapprochement)

Réglages > **Encaissements Stripe**, par propriété : chaque paiement reçu avec sa réservation, son type, le montant brut, les **frais Stripe réels** et le **net**, le total par mois, et l'export CSV (séparateur `;`, virgule décimale, ouvert directement par Excel).

Les frais sont relevés chez Stripe au moment du webhook. Quand Stripe ne les a pas encore (Bancontact peut tarder), ils s'affichent « inconnus » et le bouton **Relever les frais manquants** les récupère plus tard. Rien n'est estimé.

## 7. Variables d'environnement : désormais un repli

`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` continuent de fonctionner, mais **seulement pour une propriété sans clé secrète propre**. Dès qu'une propriété a la sienne, aucune variable d'environnement ne la concerne (on ne mélange jamais la clé secrète d'un compte et la clé publiable d'un autre). `STRIPE_UI=checkout` reste global.

L'ancienne adresse `/api/webhooks/stripe` (sans identifiant) ne vérifie plus que `STRIPE_WEBHOOK_SECRET` : elle sert au repli.

## 8. Sécurité, honnêtement

- Les trois clés sont stockées **en clair** dans la table `property_stripe` : le projet n'a aucun chiffrement au repos (les clés de service ne gardent qu'une empreinte, ce qui ne convient pas à une clé qu'il faut rejouer chez Stripe). La protection est celle de la base elle-même, comme pour le jeton Beds24.
- Les **sauvegardes ne contiennent pas** la clé secrète ni le secret du webhook (export SQL et export SQLite les omettent, la clé publiable, publique, est gardée). Conséquence : après une restauration, les ressaisir dans Réglages > Comptes Stripe.
- L'API ne les renvoie jamais : seul « posée le … » est affiché (et, pour la clé publiable seulement, ses quatre derniers caractères). Ni le journal d'audit ni les messages d'erreur ne les contiennent.
- Le script du pilote local (`scripts/pilote-donnees.mjs`) vide la table après chargement d'une sauvegarde : rien ne doit sortir du Mac.
- Une clé publiable est faite pour être publique ; la clé secrète ne quitte jamais le serveur.


## Moyens de paiement (à régler dans Stripe)

Depuis la version d'API 2026-09-30, Stripe refuse le paramètre `payment_method_types` : les moyens de paiement proposés au client se choisissent dans le tableau de bord de chaque compte, Réglages › Moyens de paiement. À activer : **Carte** (porte Apple Pay et Google Pay) et **Bancontact**. Le reste désactivé.

## Annulation

Une annulation applique les articles 4 et 5 des CGV v3.1 (décisions de Julien du 12/10/2026, la seconde après lecture de l'art. VI.83, 27° du CDE). Annulée par le **client**, la réservation garde les arrhes (acquises à l'exploitant) ; ce qui a été payé au-delà, le solde, est remboursé par Stripe sur le moyen de paiement utilisé, sous 14 jours, paiement par paiement et jamais au-delà de l'encaissé, le solde le plus récent d'abord pour que les arrhes restent intactes. Annulée par l'**exploitant** (hors force majeure), le client retrouve tout ce qu'il a payé, arrhes comprises, et reçoit en outre une indemnité égale aux arrhes réellement reçues (art. 5.3). Stripe ne rembourse pas plus que l'encaissé : l'indemnité est un virement à faire à la main, consigné au journal (`refund.manual_due`, `indemnityCents`), affiché dans la boîte « Qui annule ? », et le mail d'annulation demande son IBAN au client. Les paiements reçus hors Stripe (virement, espèces) ou sur une propriété sans clé sont aussi à rendre à la main (`manualRefundCents`, même ligne de journal). Une option non payée, une réservation de canal (Airbnb, Booking) ou importée ne déclenche aucun mouvement d'argent de notre part.

La route `POST /api/admin/bookings/:id/cancel` prend `par` (`locataire` par défaut, c'est le client, ou `proprietaire`, c'est l'exploitant ; `client` et `exploitant` sont acceptés comme synonymes), `simuler: true` (rend le plan sans rien annuler) et `confirmer: true`, exigé dès qu'un remboursement Stripe est en jeu. Chaque remboursement est une ligne de `payments` (`kind: refund`, montant négatif, le PaymentIntent d'origine, l'identifiant `re_…` en note) créée avant l'annulation (une panne laisse une ligne reprenable) et dont l'id fait l'`Idempotency-Key` Stripe (`gp-refund-<id>`, jamais d'horloge) : une annulation ne se rejoue pas, et un remboursement ne part jamais deux fois. Argent en jeu : session humaine exigée, pas de clé de service. Deux options de l'API couvrent les exceptions des CGV : `forceMajeure: true` (quelle que soit la partie, tout est rendu, arrhes comprises, sans indemnité, art. 5.4) et `sejourEntame: true` (client, non-présentation ou arrivée écourtée : le prix du séjour n'est pas restitué, un trop-perçu l'est, art. 5.5) ; l'écran ne les propose pas encore. Le plan rend `indemnityCents`, `forceMajeure` et `sejourEntame` tels qu'ils ont été retenus. Le client reçoit un mail `cancellation` (FR ou NL) qui annonce le remboursement « sur le moyen de paiement utilisé, sous 14 jours » et, si l'exploitant annule hors force majeure, l'indemnité avec la demande d'IBAN ; il n'y a pas de PDF.

Un remboursement échoué n'empêche pas l'annulation : la ligne reste `failed`, le journal porte `refund.failed` et la réponse le dit. Il se rejoue (ou se reprend, s'il est resté `pending` après une panne) par `POST /api/admin/bookings/:id/refunds/:refundId/retry`, qui demande d'abord à Stripe s'il a déjà créé le remboursement de cette ligne (métadonnée `refund_row`, une réponse perdue peut cacher un remboursement passé), renvoie l'ordre avec la même clé d'idempotence s'il manque, et ne rejoue pas si Stripe est injoignable. Les remboursements Bancontact peuvent rester `pending` quelques jours chez Stripe : la ligne compte comme remboursée dès que Stripe l'accepte.
