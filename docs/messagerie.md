# Messagerie : tous les messages dans la plateforme

Décision de Julien du 11/10/2026 : la boîte Gmail dédiée `lesgitesdupremore@gmail.com` est
l'adresse de contact des gîtes. La plateforme la relève, rattache chaque mail à sa réservation,
et on répond **depuis Messages**. On n'écrit jamais à la main dans Gmail : l'objectif est de
réduire les mails au minimum, tout passe par l'outil.

## Les origines

Chaque message porte son origine, avec le même mot partout (liste, fil, carte « Aujourd'hui »,
filtre) :

| Origine | D'où vient le message | Colonne `messages.channel` | Comment on répond |
|---|---|---|---|
| **E-mail** | la boîte Gmail des gîtes (relève IMAP) | `email` | par SMTP, dans le même fil |
| **Airbnb**, **Booking**, **Vrbo** | les canaux, relevés par Beds24 | `beds24` (+ `channel_messages`) | sur le canal, par Beds24 |
| **Site** | formulaire de contact du site et voucher du client | `form` | par mail au client (si l'envoi est actif) |

Un canal qui n'est aucun de ces trois (Expedia…) garde son nom. Le vocabulaire vient d'un seul
endroit : `app/src/canaux/canal.ts` (`originOf`, `sourceLabel`).

Les mails relevés vont dans `messages`, **pas** dans `channel_messages` : cette table est celle de
Beds24 (identifiant de réservation Beds24 obligatoire), un mail n'en a pas. `messages` est déjà la
boîte unique (liste « À répondre », fil, réponse), et reçoit déjà les mails de Cloudflare Email
Routing.

## La relève

- **Où** : `node/imap.mjs` (client IMAP maison, `node:tls`, zéro dépendance), injecté en
  `env.IMAP_FETCH` par `node/server.mjs`. Logique : `src/services/mailbox.ts`.
- **Quand** : au cron (toutes les 15 min, `/internal/cron`), et, en filet, toutes les
  `MAILBOX_POLL_MINUTES` (10 par défaut) tant que le processus Node vit. Un **bail en base** (5 minutes,
  expire seul après un plantage) interdit deux relèves à la fois, même entre deux instances du
  site, et le curseur ne recule jamais à `UIDVALIDITY` égale.
- **Lecture seule** : la boîte est ouverte en `EXAMINE` ; rien n'y est marqué lu, déplacé ni
  supprimé. Le client n'envoie que `CAPABILITY`, `LOGIN`, `EXAMINE`, `UID SEARCH`, `UID FETCH …
  BODY.PEEK` et `LOGOUT`.
- **Curseur** : un UID et l'`UIDVALIDITY`, gardés dans `app_settings` (`mailbox_imap_state`).
  Un passage ne demande que les UID au-delà du curseur ; il avance mail par mail, donc une panne
  au milieu ne perd rien et ne relit pas ce qui est passé. Premier passage : les 14 derniers jours.
  `UIDVALIDITY` changée (boîte reconstruite) : retour à la fenêtre de 14 jours, et le
  Message-ID évite tout doublon.
- **Lots** : 40 mails au plus par appel, 3 appels au plus par relève ; le reste au passage suivant.
- **Aucun mail perdu** : si le serveur ne rend pas tous les messages d'un lot, ceux qui manquent
  sont redemandés ; ceux qui existent encore sans être rendus font échouer le passage **sans
  avancer le curseur** (reprise au passage suivant) ; un message vraiment expulsé entre-temps est
  confirmé par un contrôle (`UID SEARCH UID …`) avant d'être sauté.
- **Idempotence** : un mail déjà connu (même Message-ID) est ignoré. Sans Message-ID, un
  identifiant stable est fabriqué à partir de l'UID.
- **Taille** : 512 Ko au plus par mail descendent (`BODY.PEEK[]<0.N>`). Au-delà, le début est
  gardé avec une mention « message volumineux ». Le texte stocké est plafonné à 20 000 caractères.

### Rattachement

Dans l'ordre : une **référence** de réservation dans le sujet ou le corps (`PM-2026-001`) ; sinon
le mail **répond à l'un de nos messages** (`In-Reply-To` / `References` retrouvent le `Message-ID`
de notre réponse, donc sa réservation, même si le client écrit d'une autre adresse) ; sinon
l'**adresse de l'expéditeur** est celle d'un client : sa réservation non annulée la plus proche
dans le temps (séjour en cours d'abord). Rien ne correspond : fil « sans réservation » (le fil se
regroupe alors par adresse). Le domaine (Pré Moré / Moulin de Braives) est celui de la
réservation, sinon celui dont l'adresse de contact est destinataire du mail.

### Pièces jointes

Listées (nom, taille) sous le message, **jamais stockées** en v1. Un fichier `.txt` en pièce
jointe n'est jamais pris pour le corps du mail.

## Répondre

Dans Messages, « Envoyer » sur un mail : envoi **SMTP** (`node/smtp.mjs`) depuis `MAIL_FROM`, avec
`In-Reply-To` (le Message-ID du client) et `References` (la chaîne, 20 identifiants au plus), sujet
`Re: …`. Le mail est journalisé dans `email_log` (genre `reply`, statut, identifiant SMTP), le
message sortant apparaît dans le fil (origine e-mail) et garde le Message-ID SMTP : la réponse du
client y retombe. Le message d'origine passe en « traité ».

Pour que la réponse parte de la même adresse que celle qui reçoit, régler SMTP sur Gmail
(`smtp.gmail.com`, 465, même adresse, même mot de passe d'application). Si SMTP reste sur
Infomaniak (`reservations@`), tout fonctionne, la réponse vient simplement de cette adresse.

Pas d'accusé de réception automatique sur ce chemin : seule une personne répond.

## Écran

- **Filtre par origine** dans Messages (puces « E-mail (2) », « Airbnb (1) »… avec le nombre de
  messages à répondre), visible dès qu'il y a plus d'une origine.
- **Badge d'origine** sur chaque ligne, dans l'en-tête du fil et sur chaque bulle ; carte
  « Messages » et phrase du jour de la page Aujourd'hui : « 3 messages à lire (E-mail 2, Airbnb 1) ».
- **Marquer comme traité** / « Remettre à répondre » : le bouton sous le champ de réponse.
- État de la relève : `GET /api/admin/mailbox` ; relève immédiate : `POST /api/admin/mailbox/poll`.

## Sécurité

- Le contenu d'un mail n'est **jamais interprété** : le HTML est converti en texte (scripts,
  styles, commentaires retirés, entités décodées une seule fois), l'écran l'affiche comme du
  texte échappé par React.
- **Liens non cliquables** : un lien HTML est écrit `texte (adresse complète)` pour que la vraie
  destination se lise ; l'écran le dit et ne les rend pas cliquables.
- **Caractères de contrôle** retirés de l'objet, du nom et des adresses ; `In-Reply-To` et
  `References` ne gardent que des `<identifiants>` ; le client SMTP refuse tout identifiant de fil
  qui n'en serait pas un (pas d'injection d'en-tête, ex. un `Bcc:` caché dans un sujet).
- **Usurpation de l'adresse des gîtes** : un mail dont l'expéditeur est l'adresse de la boîte, de
  `MAIL_FROM` ou de l'adresse de contact d'un domaine sans que Gmail atteste l'expéditeur (premier en-tête
  `Authentication-Results` posé par Google : `dmarc=pass`, ou `dkim=pass` signé par le domaine de
  l'adresse annoncée, jamais par un autre domaine) est marqué, une alerte
  s'affiche et la réponse est bloquée (elle écrirait à l'adresse des gîtes). Même refus pour tout
  mail dont l'expéditeur est l'une des adresses des gîtes.
- Le mot de passe ne figure dans aucun message d'erreur ni journal ; la connexion refuse le clair
  (TLS dès la connexion) et `LOGINDISABLED`.
- Plafonds : ligne de réponse 1 Mo, littéral IMAP 1 Mo au plus (ou la taille demandée), 2 000
  réponses non étiquetées et un volume cumulé borné par commande, profondeur MIME 6, 50 pièces
  listées, délai global de 60 s.

## Variables

| Variable | Rôle |
|---|---|
| `IMAP_USER` | adresse de la boîte (`lesgitesdupremore@gmail.com`). **Sans elle, la relève est inactive.** |
| `IMAP_PASSWORD` | mot de passe d'application Google ; **retombe sur `SMTP_PASSWORD`** s'il est vide |
| `IMAP_HOST` | `imap.gmail.com` par défaut |
| `IMAP_PORT` | `993` par défaut (TLS direct, le seul mode accepté) |
| `MAILBOX_POLL_MINUTES` | filet entre deux passages du cron, 10 par défaut, 0 = au cron seulement |

Envoi des réponses : `EMAILS_ENABLED=true` et les variables SMTP habituelles (voir `.env.example`).

## Limites de la v1

- **Mot de passe d'application Google obligatoire** : validation en deux étapes sur le compte,
  puis un mot de passe d'application. Le mot de passe du compte ne fonctionne pas, et il n'y a pas
  d'OAuth.
- **Pas de pièces jointes stockées** : seulement leurs noms et tailles. Pour un fichier, il faut
  encore ouvrir Gmail (ou demander au client de l'envoyer autrement).
- **Pas de réponse avec pièce jointe**, pas de texte enrichi : texte brut.
- **Cloudflare Workers** n'ouvre pas de socket sortante : la relève y est désactivée, avec un
  message clair (`GET /api/admin/mailbox`, ligne de journal `mailbox.imap.disabled`). Elle tourne
  sur le site Node (Infomaniak).
- Seule **INBOX** est lue (ni spam, ni libellés). Un mail archivé dans Gmail avant la relève, et
  plus ancien que 14 jours au premier passage, n'est pas repris.
- Les **notifications des canaux** (mails « Airbnb vous a envoyé un message ») qui arriveraient
  dans la boîte apparaissent comme des mails ordinaires : elles doublonnent le message que Beds24
  apporte déjà. À filtrer côté Gmail (ne pas les envoyer vers cette boîte) plutôt qu'ici.
- L'authentification de l'expéditeur ne se lit que pour Gmail (`google.com`) ; avec un autre
  fournisseur IMAP, tout mail portant l'adresse des gîtes est signalé.
- Un mail illisible reste visible sous « (message illisible) » plutôt que de disparaître.
