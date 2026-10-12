#!/usr/bin/env bash
# Rôle : copie cohérente de la base SQLite + archive des photos, rotation à 14 jours.
# Usage : lancé par gites-backup.service (SQLITE_PATH et UPLOADS_DIR viennent de /srv/gites/.env) ;
#         à la main : /srv/gites/sauvegarde.sh
# Sortie : /srv/gites/backups/AAAA-MM-JJ-HHMMSS-gites.sqlite.gz et …-gites-photos.tar
set -euo pipefail

SQLITE_PATH="${SQLITE_PATH:-/srv/gites/data/gites.db}"
UPLOADS_DIR="${UPLOADS_DIR:-/srv/gites/data/uploads}"
DEST="/srv/gites/backups"
GARDER_JOURS=14
HORODATAGE="$(date +%Y-%m-%d-%H%M%S)"

mkdir -p "$DEST"
umask 077

[ -f "$SQLITE_PATH" ] || { echo "Base introuvable : $SQLITE_PATH" >&2; exit 1; }

# 1. Base : VACUUM INTO donne un fichier cohérent même pendant que le site écrit.
tmp="$(mktemp "$DEST/.base-XXXXXX.sqlite")"
trap 'rm -f "$tmp"' EXIT
rm -f "$tmp"   # VACUUM INTO exige un fichier qui n'existe pas encore
sqlite3 "$SQLITE_PATH" "VACUUM INTO '$tmp'"
[ "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" = "ok" ] || { echo "Copie de la base incohérente" >&2; exit 1; }
gzip -c "$tmp" > "$DEST/$HORODATAGE-gites.sqlite.gz"
rm -f "$tmp"

# 2. Photos : fichiers plats, une archive tar.
if [ -d "$UPLOADS_DIR" ]; then
  tar -cf "$DEST/$HORODATAGE-gites-photos.tar" -C "$UPLOADS_DIR" .
fi

# 3. Rotation : on retire ce qui a plus de GARDER_JOURS jours, mais jamais les 3 plus récents de chaque sorte.
for motif in '*-gites.sqlite.gz' '*-gites-photos.tar'; do
  find "$DEST" -maxdepth 1 -type f -name "$motif" -printf '%T@ %p\n' | sort -rn | tail -n +4 \
    | while read -r _ f; do
        if [ -n "$(find "$f" -mtime +"$GARDER_JOURS" -print)" ]; then rm -f -- "$f"; fi
      done
done

echo "Sauvegarde $HORODATAGE faite : $(ls "$DEST" | wc -l) fichier(s) dans $DEST"
