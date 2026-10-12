# Migrations — à lire avant d'ouvrir un `.sql` de ce dossier

Le schéma de la base est la **source de vérité** du projet : le code applicatif
s'y conforme, jamais l'inverse. Ce dossier est donc l'endroit le plus sensible
du dépôt, et il a une règle contre-intuitive qu'on ne devine pas.

---

## ⚠️ Jamais de `;` ni de `--` à l'intérieur d'un littéral SQL

**C'est le piège numéro un du projet. Il est déjà tombé deux fois.**

Le découpage des fichiers de migration est volontairement naïf : on retire les
`--` de fin de ligne, puis on fait un `split(";")`. Il est implémenté **deux
fois**, une par cible d'hébergement :

| Fichier | Utilisé par |
|---|---|
| `test/helpers/d1.ts` | la suite de tests (Miniflare) |
| `node/migrate.mjs` | le déploiement Node/SQLite (Infomaniak) |

Conséquence : un point-virgule à l'intérieur d'une chaîne de caractères coupe
l'instruction en deux au milieu du texte. La migration casse **silencieusement**,
et c'est toute la suite de tests qui tombe — avec un message qui ne pointe pas
du tout vers la vraie cause.

Le jour où quelqu'un colle un texte de conditions générales contenant un
point-virgule, ou un commentaire descriptif avec un double tiret, il perd une
demi-journée.

```sql
-- ✗ CASSE TOUT
UPDATE settings SET cgv_text = 'Arrhes de 30 % ; solde à J-30.' WHERE id = 1;

-- ✓ CORRECT — virgule, tiret cadratin, ou reformulation
UPDATE settings SET cgv_text = 'Arrhes de 30 %, solde à J-30.' WHERE id = 1;
```

Corollaires :

- **les apostrophes s'échappent en `''`**, comme partout en SQL ;
- si un commentaire doit décrire ce piège, **il s'écrit sans double tiret** —
  c'est exactement ce que fait la migration `0011`.

---

## Ordre d'application

L'ordre est **l'ordre alphabétique du nom de fichier**, d'où la numérotation sur
quatre chiffres. Une nouvelle migration continue la série : `0013_…`, `0014_…`.

Nommage : `00NN_nom_en_snake_case.sql`.

> **Une migration ne se modifie jamais après avoir été appliquée quelque part.**
> Même pour corriger une faute de frappe : les bases qui l'ont déjà jouée ne la
> rejoueront pas, et le schéma diverge silencieusement d'une machine à l'autre.
> On en ajoute une nouvelle, toujours.

Il n'y a **aucun script de rollback** dans ce projet : une migration est à sens
unique.

---

## Appliquer en local

```bash
npm run db:migrate:local     # applique les migrations en attente
npm run db:reset:local       # DÉTRUIT .wrangler/state et repart d'une base neuve
```

- `npm run db:migrate:local` est à **refaire après chaque `git pull`**. Le
  symptôme classique d'un oubli : des routes qui marchaient répondent 500.
- La base locale est jetable — le seed la reconstruit complètement.
- `npm test` **rejoue toutes les migrations** sur une base neuve à chaque
  exécution : une migration cassée fait tomber la suite immédiatement. C'est le
  filet de sécurité, utilisez-le avant de pousser.

La migration **distante** (`npm run db:migrate:remote`) fait partie des
commandes interdites sans accord explicite du propriétaire — voir
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) § 0.

---

## Conventions du schéma

- **Montants en centimes entiers**, jamais de flottant.
- **Dates en TEXT `'YYYY-MM-DD'`** ; `checkout` est **exclusif**.
- **Horodatages** via le défaut `(datetime('now'))`.
- **Booléens en INTEGER 0/1**, avec `NOT NULL DEFAULT`.
- **Ids explicites dans les seeds**, pour que les migrations suivantes puissent
  faire un `UPDATE … WHERE id = N` fiable.
- **Jamais de `DELETE`** sur une donnée métier : `active = 0` ou changement de
  statut.
- L'en-tête de chaque migration porte **la décision et la date** qui la motivent.

---

## Ce qu'il y a dans ce dossier

| Migration | Contenu |
|---|---|
| `0001` | schéma initial |
| `0002` | seed Pré Moré |
| `0003` | ménage, photos, données réelles |
| `0004` | Le Moulin de Braives |
| `0008` | preuves légales au checkout (CGV hashées, horodatage, IP) |
| `0009` | régime « pas de services » : draps inclus, options désactivées |
| `0010` | correspondance Beds24 (`beds24_property_id`, `beds24_room_id`) |
| `0011` | (porte le commentaire sans double tiret, cf. règle ci-dessus) |
| `0012` | comptes du back-office (`admin_users`) |
| `0013` | journal des recherches (`search_log`) |
| `0014` | surcharges tarifaires par jour, garde-fous de prix par hébergement |
| `0015` | pourcentage d'arrhes par hébergement (`units.deposit_pct`, seed à 50) |
| `0016` | conditions générales de location v2 pour les deux domaines |
| `0017` | conflits de synchronisation persistés (`sync_conflicts`, issue #72) |
| `0018` | blocages manuels (`manual_blocks`) — travaux, usage personnel |
| `0019` | conditions générales de location v3, taxe de séjour à 0 sur les deux domaines |
| `0020` | registre des personnes hébergées |
| `0021` | galerie de photos par hébergement (`unit_photos`, seed depuis `scripts/photos-sources.json`, issue #32) |
| `0024` | messagerie des canaux par Beds24 (`channel_messages`, relevée au cron, recopiée dans `messages` avec `channel = 'beds24'`) ; clés d'accès de service (`service_keys`, `Bearer svc:<clé>`, SHA-256 seulement) |
| `0036` | conditions générales de location v3.1 pour les deux domaines : arrhes acquises quand le client annule, indemnité égale aux arrhes quand l'exploitant annule, résumé « Comment ça se passe », v3 archivée sous `cgv_text_avant_3_1` |

Le détail des règles métier qu'elles encodent est dans le
[`README.md`](../README.md) racine.
