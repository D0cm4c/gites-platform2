# Confirmation de réservation et conditions générales (PDF)

Décision de Julien du 11/10/2026 : un client qui réserve en direct reçoit **un beau
mail de confirmation** avec, **en pièce jointe, un PDF**. Airbnb et Booking envoient
le leur ; ceci vaut pour les réservations directes. Il n'y a pas de vente
« confirmée » au back-office (décision du 11/10/2026) : la réservation est conclue
par l'acceptation en ligne des CGV et le paiement des arrhes, rien ne se signe.

Décision de Julien du 12/10/2026 : ce PDF **n'est plus un « contrat »**. Des CGV
bien écrites et la trace de leur acceptation (version, date, heure, IP) suffisent.
Le document s'appelle « Confirmation de réservation et conditions générales »
(`Confirmation-<référence>.pdf`) ; les mots « contrat », « bail », « locataire »,
« propriétaire » cèdent la place à « confirmation », « client », « exploitant »
dans le PDF, les mails et les écrans.

## Vente du back-office : une option, puis le client confirme

`POST /api/admin/bookings` crée toujours une **option** (`pending`, 72 h par défaut) ;
`confirmNow` est ignoré. Si le client a un e-mail, le mail `payment_link`
(`buildPaymentLinkEmail`) lui envoie le lien vers la page de SA réservation
(`voucherUrl`), avec la date jusqu'à laquelle ses dates sont gardées ; sans e-mail,
le lien est dans la réponse (`optionUrl`). Sur cette page le client coche
l'acceptation des CGV (`POST /api/public/bookings/:ref/pay` avec `cgvAccepted: true`,
exigée tant qu'aucune acceptation n'est enregistrée ; version, heure et IP sont
alors posées comme dans le tunnel), paie les arrhes, et reçoit la confirmation avec
son PDF. `guest.lang: "nl"` envoie le lien en néerlandais.

## Ce qui part, et quand

Un seul mail, de type `confirmation` dans `email_log`. Il **remplace** l'ancien mail
« voucher » : le voucher n'est plus envoyé en plus (la page `voucher.html`, elle,
reste la consultation en ligne de la réservation). Les anciennes lignes
`kind = 'voucher'` du journal sont conservées telles quelles.

| Déclencheur | Où dans le code |
|---|---|
| Paiement des arrhes (ou du total) : webhook Stripe, simulateur de dev | `handlePaymentSuccess` (`src/services/booking-flow.ts`), au passage `pending` → `confirmed` |
| Confirmation manuelle d'une option | `POST /api/admin/bookings/:id/confirm` avec `{"sendConfirmation": true}` (ancien nom `sendVoucher` accepté) |
| « Renvoyer la confirmation » (fiche réservation, écran `app/`) | `POST /api/admin/bookings/:id/resend-confirmation` (ancien nom `resend-voucher` accepté) |

Tout passe par `sendConfirmation()` (`booking-flow.ts`). **Sans doublon** : sauf
`force` (le bouton « Renvoyer »), il ne part qu'une fois par réservation. Un envoi
déjà journalisé, de type `confirmation` ou `voucher`, hors statut `failed`, bloque
l'envoi automatique ; un envoi `failed` peut être retenté. Deux déclenchements
simultanés (webhook rejoué, double clic) ne passent pas tous les deux : un verrou
(`confirmation_claims`, migration 0030, une ligne par réservation) est posé AVANT
l'envoi et rendu seulement si l'échec est constaté (statut `failed`, ou mail impossible
à construire). Si le Worker s'interrompt entre le verrou et le journal, ou si le
journal échoue après l'acceptation du mail par le transport, le verrou reste : on
préfère une confirmation à renvoyer à la main (« Renvoyer la confirmation ») à un
doublon chez le client. Le reçu de paiement
(`payment_receipt`) reste un mail à part, émis à chaque encaissement.

Le mail est en français ou en néerlandais selon `bookings.lang` (puis la langue du
client). Les conditions générales n'existent qu'en français : en néerlandais, le
mail et le PDF le disent (« De Franse versie is rechtsgeldend »).

## Le mail

`src/services/confirmation.ts`, `buildConfirmationEmail()` : objet
« Confirmation de réservation <réf> — <domaine> », version HTML (tableaux en
styles en ligne, 600 px, bouton « Voir ma réservation » vers la page de la
réservation) et version texte (c'est elle que garde le journal). Rubrique « Ce que
vous devez savoir » : horaires, adresse, contact, solde et échéance, caution si
demandée, conclusion de la réservation (acceptation des CGV + arrhes, rien à
signer), renvoi vers l'article 5 (annulation) et contact par e-mail avec la référence.

Les données du client passent par `esc()` dans le HTML ; objet et texte reçoivent
des valeurs ramenées à une ligne. Les coordonnées `TODO_…` du domaine ne sortent
jamais. Le texte du mail se change dans les deux dictionnaires `FR` et `NL` en tête
du fichier.

## Le PDF « Confirmation de réservation et conditions générales »

`src/services/confirmation-pdf.ts`, `buildConfirmationPdf()`, fichier
`Confirmation-<référence>.pdf`. Générateur PDF maison, sans dépendance :
`src/core/pdf.ts` (A4, Helvetica, WinAnsi, tableaux, pagination, pied de page
« Page n / N »). Contenu :

1. **page 1, le récapitulatif** : exploitant (domaine, adresse, contact, et la
   phrase « L'exploitant est … » de l'article 1 des CGV) et client ; hébergement ;
   séjour (dates en toutes lettres, heures d'arrivée et de départ, nuits,
   occupants) ; prix ligne par ligne d'après le devis figé, et total ; paiement
   (arrhes avec leur pourcentage, solde et échéance, montant réglé à la date
   d'émission, caution seulement si elle est > 0, renvoi à l'article 5 pour
   l'annulation) ; puis le rappel de la conclusion : « Réservation conclue par
   l'acceptation des conditions générales v3.1 le JJ/MM/AAAA à HH:MM depuis
   l'adresse IP … et le paiement des arrhes » (heure de Bruxelles) ;
2. **en annexe**, le texte complet des CGV en base (`settings.cgv_text`).

La version citée est celle **enregistrée à l'acceptation** (`bookings.cgv_version`,
de la forme `v3.1+sha256:<16 hex>-len<n>` depuis la 3.1) ; pour une acceptation
plus ancienne (hash seul), c'est celle du texte en base.

**Le document ne crée aucune règle.** Les chiffres viennent de la réservation ; les
règles (arrhes, solde à 30 jours, annulation) sont celles des CGV en base. Changer
une règle = changer `cgv_text` (nouvelle version, nouvelle migration sur le modèle de
la 0036) : le document suit sans toucher au code.

### Où modifier le texte

- **Libellés du document** (titres, rappel de conclusion, confidentialité) : les
  deux dictionnaires `FR` et `NL` de `src/services/confirmation-pdf.ts`.
- **Mise en page** (marges, polices, tableaux) : `src/core/pdf.ts`.
- **Règles de paiement et d'annulation, identité de l'exploitant** : les CGV en base.
- Après modification : `npx vitest run test/confirmation-pdf.test.ts`. Pour voir
  le rendu : `SAMPLE_PDF_DIR=/chemin npx vitest run test/confirmation-pdf.test.ts -t "exemple"`
  écrit un PDF et un mail FR et NL d'exemple dans ce dossier.

## Accès au PDF

- Back-office : `GET /api/admin/bookings/:id/confirmation.pdf` (même garde que tout
  `/api/admin/*`, toute réservation) ; bouton « Confirmation PDF » dans la fiche
  réservation de l'écran `app/`, avec « Renvoyer la confirmation ».
- Client : `GET /api/public/bookings/:référence/confirmation.pdf?email=…` (même
  contrôle que sa page de réservation : référence + e-mail), **réservation
  confirmée seulement**.
- `contrat.pdf` reste un **alias** des deux routes (liens déjà envoyés, scripts) :
  même réponse, même fichier `Confirmation-<référence>.pdf`.

## Transports

`queueEmail` accepte `bodyHtml` et `attachments` ; le journal (`email_log.attachments`,
migration 0030) garde nom et taille de chaque pièce jointe, jamais le contenu.
- SMTP (`node/smtp.mjs`) : `multipart/alternative` (texte + HTML) dans un
  `multipart/mixed` quand il y a des pièces jointes, base64 en lignes de 76 ; nom de
  fichier assaini (ASCII, sans guillemet ni saut de ligne). Sans HTML ni pièce
  jointe, le message reste un simple `text/plain`.
- Resend : `html` et `attachments` (contenu en base64).
- Mode stub (`EMAILS_ENABLED` ≠ `true`) : le mail est journalisé (`status = stub`),
  rien ne part.
