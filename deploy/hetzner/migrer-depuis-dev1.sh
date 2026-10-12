#!/usr/bin/env bash
# Rôle : reprendre sur le serveur Hetzner la base SQLite et les photos de dev1 (Infomaniak).
# Usage (depuis le Mac) : deploy/hetzner/migrer-depuis-dev1.sh <ip> <domaine> [--sauvegarde-fraiche] [--dossier <sauvegardes>] [--cle <clé ssh>] [--force]
#   --sauvegarde-fraiche : tire d'abord une copie neuve de dev1 (scripts/sauvegarde_nuit.py --cible infomaniak),
#                          à faire APRÈS avoir gelé dev1 (plus rien d'écrit dessus) ;
#   sans l'option : prend la dernière sauvegarde du dossier et refuse si elle a plus de 30 min (sauf --force).
# Où sont les sauvegardes : « sauvegardes/ » du clone principal (AAAA-MM-JJ-HHMMSS-gites-infomaniak.sqlite
#   et …-gites-infomaniak-photos.tar), produites par `make sauvegarde` ou le LaunchAgent de nuit.
# Coupure : le site Hetzner est arrêté le temps de la copie (une minute ou deux).
# Ordre complet : docs/hebergement-hetzner.md § « Le jour de la bascule ».
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
RACINE_DEPOT="$(cd "$ICI/../.." && pwd)"
CLE="$HOME/.ssh/gites_hetzner_ed25519"
FRAICHE=non
FORCE=non
DOSSIER=""
PYTHON="${PYTHON:-/opt/homebrew/bin/python3}"

if [ "$#" -lt 2 ]; then sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; fi
IP="$1"; DOMAINE="$2"; shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sauvegarde-fraiche) FRAICHE=oui; shift ;;
    --force) FORCE=oui; shift ;;
    --dossier) DOSSIER="$2"; shift 2 ;;
    --cle) CLE="$2"; shift 2 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

# Dossier des sauvegardes : celui du clone principal, même lancé depuis un worktree (.worktrees/…).
if [ -z "$DOSSIER" ]; then
  commun="$(git -C "$RACINE_DEPOT" rev-parse --git-common-dir)"
  principal="$(cd "$RACINE_DEPOT" && cd "$commun/.." && pwd)"
  DOSSIER="$principal/sauvegardes"
fi
[ -d "$DOSSIER" ] || { echo "Dossier de sauvegardes introuvable : $DOSSIER" >&2; exit 1; }
[ -f "$CLE" ] || { echo "Clé SSH introuvable : $CLE" >&2; exit 1; }

SSH_OPTS=(-i "$CLE" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
adm() { ssh "${SSH_OPTS[@]}" "claude@$IP" "$@"; }

if [ "$FRAICHE" = oui ]; then
  echo "0/7 Sauvegarde fraîche de dev1 (lecture seule côté dev1)…"
  (cd "$RACINE_DEPOT" && "$PYTHON" scripts/sauvegarde_nuit.py --cible infomaniak --origine manuel)
fi

echo "1/7 Choix de la sauvegarde…"
# Les noms commencent par l'horodatage : l'ordre alphabétique est l'ordre du temps.
BASE_LOCALE="$(ls -1 "$DOSSIER"/*-gites-infomaniak.sqlite 2>/dev/null | sort | tail -n1 || true)"
[ -n "$BASE_LOCALE" ] || { echo "Aucune sauvegarde *-gites-infomaniak.sqlite dans $DOSSIER" >&2; exit 1; }
PHOTOS_LOCALES="${BASE_LOCALE%.sqlite}-photos.tar"
[ -f "$PHOTOS_LOCALES" ] || { echo "Archive des photos absente : $PHOTOS_LOCALES (lancer avec --sauvegarde-fraiche)" >&2; exit 1; }
age_s=$(( $(date +%s) - $(stat -f %m "$BASE_LOCALE") ))
echo "  $BASE_LOCALE (il y a $((age_s / 60)) min)"
if [ "$age_s" -gt 1800 ] && [ "$FORCE" != oui ]; then
  echo "Sauvegarde trop ancienne (> 30 min) : dev1 a pu changer depuis. Relancer avec --sauvegarde-fraiche (dev1 gelé), ou --force." >&2
  exit 1
fi
[ "$(sqlite3 "$BASE_LOCALE" 'PRAGMA integrity_check;')" = ok ] || { echo "Sauvegarde locale corrompue." >&2; exit 1; }
RESAS_LOCALES="$(sqlite3 "$BASE_LOCALE" 'SELECT COUNT(*) FROM bookings')"
echo "  $RESAS_LOCALES réservation(s) dans la sauvegarde."

echo "2/7 Envoi sur le serveur…"
TMP="/tmp/migration-$$"
adm "mkdir -p $TMP && chmod 700 $TMP"
scp "${SSH_OPTS[@]}" -q "$BASE_LOCALE" "claude@$IP:$TMP/gites.sqlite"
scp "${SSH_OPTS[@]}" -q "$PHOTOS_LOCALES" "claude@$IP:$TMP/photos.tar"

echo "3/7 Arrêt du site Hetzner et mise en place (coupure)…"
adm "bash -s -- $TMP" <<'REMOTE'
set -euo pipefail
TMP="$1"
# Chemins lus dans le .env (variables non secrètes seulement).
# /srv/gites est 750 gites:gites : l'administrateur lit le .env par sudo (variables non secrètes seulement).
SQLITE_PATH="$(sudo grep -E '^SQLITE_PATH=' /srv/gites/.env | cut -d= -f2-)"
UPLOADS_DIR="$(sudo grep -E '^UPLOADS_DIR=' /srv/gites/.env | cut -d= -f2-)"
[ -n "$SQLITE_PATH" ] && [ -n "$UPLOADS_DIR" ] || { echo "SQLITE_PATH ou UPLOADS_DIR absent du .env" >&2; exit 1; }
# Les noms de l'archive doivent être des fichiers plats de photo (même règle que la sauvegarde).
mauvais="$(tar -tf "$TMP/photos.tar" | grep -vcE '^(\./)?([0-9a-f]{32}\.(jpg|png|webp))?$' || true)"
if [ "$mauvais" != 0 ]; then
  echo "Archive des photos refusée : $mauvais membre(s) inattendu(s)" >&2; exit 1
fi
sudo systemctl stop gites-cron.timer gites
horo="$(date +%Y-%m-%d-%H%M%S)"
# L'ancienne base du serveur (vide ou d'essai) est gardée de côté.
if [ -f "$SQLITE_PATH" ]; then sudo -u gites cp -p "$SQLITE_PATH" "/srv/gites/backups/avant-migration-$horo.sqlite"; fi
sudo -u gites rm -f "$SQLITE_PATH" "$SQLITE_PATH-wal" "$SQLITE_PATH-shm"
sudo install -o gites -g gites -m 0600 "$TMP/gites.sqlite" "$SQLITE_PATH"
if [ -d "$UPLOADS_DIR" ]; then sudo -u gites mv "$UPLOADS_DIR" "$UPLOADS_DIR.avant-migration-$horo"; fi
sudo -u gites mkdir -p "$UPLOADS_DIR"
sudo tar -xf "$TMP/photos.tar" -C "$UPLOADS_DIR" --no-same-owner --no-same-permissions
sudo chown -R gites:gites "$UPLOADS_DIR"
rm -rf "$TMP"
REMOTE

echo "4/7 Redémarrage (les migrations en attente s'appliquent au démarrage)…"
adm 'sudo systemctl start gites'
ok=non
for _ in $(seq 1 30); do
  if adm 'curl -fsS --max-time 3 http://127.0.0.1:8787/api/public/health' 2>/dev/null | grep '"ok":true' >/dev/null; then ok=oui; break; fi
  sleep 2
done
[ "$ok" = oui ] || { echo "Le site ne répond pas : ssh claude@$IP 'journalctl -u gites -n 80 --no-pager'" >&2; exit 1; }
adm 'sudo systemctl start gites-cron.timer'

echo "5/7 Contrôle des données…"
SQLITE_DISTANT="$(adm "sudo grep -E '^SQLITE_PATH=' /srv/gites/.env | cut -d= -f2-")"
RESAS_DISTANTES="$(adm "sudo -u gites sqlite3 '$SQLITE_DISTANT' 'SELECT COUNT(*) FROM bookings'")"
INTEGRITE="$(adm "sudo -u gites sqlite3 '$SQLITE_DISTANT' 'PRAGMA integrity_check;'")"
NB_PHOTOS="$(adm "sudo ls -1 \"\$(sudo grep -E '^UPLOADS_DIR=' /srv/gites/.env | cut -d= -f2-)\" | wc -l" | tr -d ' ')"
NB_PHOTOS_LOCALES="$(tar -tf "$PHOTOS_LOCALES" | grep -cE '[0-9a-f]{32}\.(jpg|png|webp)$' || true)"
echo "  réservations : $RESAS_DISTANTES (sauvegarde : $RESAS_LOCALES) ; integrity_check : $INTEGRITE ; photos : $NB_PHOTOS (archive : $NB_PHOTOS_LOCALES)"
[ "$RESAS_DISTANTES" = "$RESAS_LOCALES" ] || { echo "ÉCART de réservations : ne pas basculer le DNS." >&2; exit 1; }
[ "$INTEGRITE" = ok ] || { echo "Base incohérente : ne pas basculer le DNS." >&2; exit 1; }
[ "$NB_PHOTOS" = "$NB_PHOTOS_LOCALES" ] || { echo "ÉCART de photos : ne pas basculer le DNS." >&2; exit 1; }

echo "6/7 Site public…"
curl -fsS --max-time 15 "https://$DOMAINE/api/public/health" && echo " <- https://$DOMAINE répond" \
  || echo "  https://$DOMAINE ne répond pas encore : normal tant que le DNS pointe sur dev1."

cat <<FIN

7/7 Données reprises. Suite de la bascule (docs/hebergement-hetzner.md) :
  1. DNS (Cloudflare) : enregistrement A de $DOMAINE -> $IP, puis attendre le certificat ;
  2. PUBLIC_BASE_URL=https://$DOMAINE dans /srv/gites/.env (déjà posée par installer.sh si c'était le premier domaine), puis restart ;
  3. Beds24 : nouveau code d'invitation collé dans Plateformes > Beds24, URL du webhook = https://$DOMAINE/api/webhooks/beds24?key=<BEDS24_WEBHOOK_KEY>, puis BEDS24_WRITE_ENABLED=true ;
  4. Stripe : endpoint du webhook = https://$DOMAINE/api/webhooks/stripe ;
  5. iCal : regénérer les adresses iCal dans le back-office et les rebrancher sur Airbnb/Booking ;
  6. ne rien écrire sur dev1 : il reste en lecture, c'est le retour arrière (DNS vers dev1).
FIN
