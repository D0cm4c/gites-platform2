#!/usr/bin/env bash
# Rôle : mettre le site à jour sur le serveur : code à jour, dépendances, build, redémarrage, sonde.
# Usage (sur le serveur, en tant que « gites ») : /srv/gites/deploy.sh [commit-ou-branche]
#   sans argument : origin/main. Avec un commit : retour arrière (voir docs/hebergement-hetzner.md).
#   Appelé par GitHub Actions (clé liée à ce script) : le commit validé par CI arrive dans
#   SSH_ORIGINAL_COMMAND, doit être un SHA complet, et un SHA plus ancien que le code déjà en
#   place est ignoré (deux merges rapprochés ne se doublent pas).
#   Depuis le Mac : ssh gites@<serveur> /srv/gites/deploy.sh      (ou : make deployer-hetzner)
# Les migrations s'appliquent toutes seules au démarrage du site (node/migrate.mjs).
# Journal : /srv/gites/deploy.log. Verrou : une seule exécution à la fois.
#
# Ce fichier est copié en /srv/gites/deploy.sh par installer.sh (jamais lancé depuis le clone,
# que `git reset --hard` réécrit pendant l'exécution). Tout le corps est dans une fonction
# appelée à la fin : bash lit donc le script entier avant d'agir.
set -euo pipefail

RACINE="/srv/gites"
APP="$RACINE/app"
JOURNAL="$RACINE/deploy.log"
VERROU="$RACINE/.deploy.lock"
SONDE="http://127.0.0.1:8787/api/public/health"
REF="${1:-origin/main}"
DEPUIS_ACTIONS=non
if [ "$#" -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Commande reçue par SSH : « /srv/gites/deploy.sh » ou « /srv/gites/deploy.sh <sha de 40 caractères hexa> ».
  mot="${SSH_ORIGINAL_COMMAND##* }"
  if [[ "$mot" =~ ^[0-9a-f]{40}$ ]]; then REF="$mot"; DEPUIS_ACTIONS=oui; fi
fi

journal() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$JOURNAL"; }

principal() {
  # Verrou : si un déploiement tourne déjà, on s'arrête (pas d'attente : GitHub relancera).
  exec 9>"$VERROU"
  if ! flock -n 9; then
    journal "Un déploiement est déjà en cours : abandon."
    exit 75
  fi

  cd "$APP"
  avant="$(git rev-parse --short HEAD 2>/dev/null || echo aucun)"
  journal "=== Déploiement de $REF (actuellement $avant)"

  git fetch --prune origin 2>&1 | tee -a "$JOURNAL"
  if [ "$DEPUIS_ACTIONS" = oui ] && git merge-base --is-ancestor "$REF" HEAD 2>/dev/null; then
    journal "Le commit $REF est déjà déployé ou plus ancien que $avant : rien à faire."
    exit 0
  fi
  git reset --hard "$REF" 2>&1 | tee -a "$JOURNAL"
  apres="$(git rev-parse --short HEAD)"
  journal "Code à jour : $apres"

  # Les dépendances de développement sont nécessaires : tsc et Vite construisent dist/ et public/admin/.
  npm ci --no-audit --no-fund 2>&1 | tee -a "$JOURNAL"
  npm run build 2>&1 | tee -a "$JOURNAL"
  journal "Build terminé."

  # Seule commande root autorisée à « gites » (sudoers).
  sudo -n /usr/bin/systemctl restart gites
  journal "Service redémarré, attente de la sonde…"

  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$SONDE" 2>/dev/null | grep '"ok":true' >/dev/null; then
      journal "OK : le site répond ($avant -> $apres)."
      exit 0
    fi
    sleep 2
  done

  journal "ÉCHEC : la sonde ne répond pas après 60 s. Journal du service : journalctl -u gites -n 80 --no-pager"
  journal "Retour arrière possible : /srv/gites/deploy.sh $avant"
  exit 1
}

principal
