#!/usr/bin/env bash
# Rôle : produit un cloud-init prêt à coller chez Hetzner, avec les deux clés PUBLIQUES posées.
# Usage : deploy/hetzner/preparer-cloud-init.sh <clé publique de Claude.pub> <clé publique de GitHub Actions.pub> > cloud-init-pret.yaml
#         (aucun secret n'est lu : seules les clés .pub le sont)
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage : $0 <claude.pub> <deploy.pub>" >&2
  exit 2
fi
ICI="$(cd "$(dirname "$0")" && pwd)"
for f in "$1" "$2"; do
  [ -f "$f" ] || { echo "Introuvable : $f" >&2; exit 1; }
  case "$f" in *.pub) ;; *) echo "Refusé : $f n'est pas un fichier .pub (jamais une clé privée)" >&2; exit 1 ;; esac
done
# Une clé publique tient sur une ligne « ssh-ed25519 AAAA… commentaire ».
claude="$(head -n1 "$1")"
deploy="$(head -n1 "$2")"
case "$claude" in ssh-ed25519\ *) ;; *) echo "Clé de Claude illisible" >&2; exit 1 ;; esac
case "$deploy" in ssh-ed25519\ *) ;; *) echo "Clé de déploiement illisible" >&2; exit 1 ;; esac
# '|' comme séparateur : les clés ne contiennent ni '|' ni '&'.
sed -e "s|__SSH_PUBLIC_KEY__|${claude}|g" -e "s|__DEPLOY_PUBLIC_KEY__|${deploy}|g" "$ICI/cloud-init.yaml"
