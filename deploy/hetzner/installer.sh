#!/usr/bin/env bash
# Rôle : poser le site des gîtes sur un serveur Hetzner neuf (une fois ; relançable sans casse).
# Usage (depuis le Mac, à la racine du dépôt) :
#   deploy/hetzner/installer.sh <ip> <domaine>[,<autre-domaine>] [--cle ~/.ssh/gites_hetzner_ed25519] [--sans-verification]
#   ex. : deploy/hetzner/installer.sh 203.0.113.10 gites-test.exemple.be
# Prérequis : serveur créé avec le cloud-init (preparer-cloud-init.sh) ; clé SSH de Claude.
# Ce que ça fait : attend cloud-init, installe Caddyfile + unités systemd + scripts, crée
#   /srv/gites/.env (jetons ADMIN_TOKEN et CRON_KEY tirés AU HASARD SUR LE SERVEUR, rien d'autre
#   de secret), clone le dépôt avec une clé de déploiement en lecture seule, premier deploy.sh,
#   puis verify-deploy.mjs (seulement sur une base vide : il écrit des réservations de test).
# Ne touche jamais à un .env existant.
set -euo pipefail

DEPOT_SSH="git@github.com:Almarcegui/gites-platform.git"
DEPOT_GH="Almarcegui/gites-platform"
ICI="$(cd "$(dirname "$0")" && pwd)"
CLE="$HOME/.ssh/gites_hetzner_ed25519"
VERIFIER=oui

if [ "$#" -lt 2 ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
IP="$1"; DOMAINES_BRUT="$2"; shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cle) CLE="$2"; shift 2 ;;
    --sans-verification) VERIFIER=non; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done
[ -f "$CLE" ] || { echo "Clé SSH introuvable : $CLE" >&2; exit 1; }
# Domaines séparés par des virgules -> « a, b » pour le Caddyfile ; le premier sert d'adresse publique.
DOMAINES="${DOMAINES_BRUT//,/, }"
PREMIER="${DOMAINES_BRUT%%,*}"

SSH_OPTS=(-i "$CLE" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15)
adm() { ssh "${SSH_OPTS[@]}" "claude@$IP" "$@"; }
gites() { ssh "${SSH_OPTS[@]}" "gites@$IP" "$@"; }
# Script lu sur l'entrée standard, arguments protégés (printf %q) : un domaine « a, b » reste un seul argument.
adm_bash() { ssh "${SSH_OPTS[@]}" "claude@$IP" "bash -s -- $(printf '%q ' "$@")"; }
gites_bash() { ssh "${SSH_OPTS[@]}" "gites@$IP" "bash -s -- $(printf '%q ' "$@")"; }

echo "1/8 Attente du serveur et de cloud-init…"
for i in $(seq 1 60); do
  if adm 'test -f /var/lib/cloud/gites-pret' 2>/dev/null; then break; fi
  [ "$i" = 60 ] && { echo "Le serveur n'est pas prêt après 10 min (cloud-init). Voir : ssh claude@$IP 'sudo cloud-init status --long'" >&2; exit 1; }
  sleep 10
done
adm 'node --version && caddy version | head -n1'

echo "2/8 Fichiers de configuration sur le serveur…"
TMP="/tmp/gites-install-$$"
adm "mkdir -p $TMP"
scp "${SSH_OPTS[@]}" -q "$ICI/Caddyfile" "$ICI"/gites*.service "$ICI"/gites*.timer "$ICI/deploy.sh" "$ICI/sauvegarde.sh" "claude@$IP:$TMP/"
adm_bash "$TMP" "$DOMAINES" <<'REMOTE'
set -euo pipefail
TMP="$1"; DOMAINES="$2"
sudo install -m 0644 "$TMP"/gites.service "$TMP"/gites-cron.service "$TMP"/gites-cron.timer \
  "$TMP"/gites-backup.service "$TMP"/gites-backup.timer /etc/systemd/system/
sudo install -o gites -g gites -m 0755 "$TMP/deploy.sh" /srv/gites/deploy.sh
sudo install -o gites -g gites -m 0755 "$TMP/sauvegarde.sh" /srv/gites/sauvegarde.sh
sed "s|__DOMAIN__|$DOMAINES|" "$TMP/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable gites.service
sudo systemctl enable --now caddy
sudo systemctl reload caddy
rm -rf "$TMP"
REMOTE

echo "3/8 Fichier /srv/gites/.env (créé seulement s'il manque)…"
gites_bash "https://$PREMIER" <<'REMOTE'
set -euo pipefail
URL="$1"
if [ -f /srv/gites/.env ]; then echo "  .env déjà là : intact."; exit 0; fi
umask 077
cat > /srv/gites/.env <<ENV
# Variables du site des gîtes (lues par systemd et par node/server.mjs). Modèle complet : /srv/gites/app/.env.example
# Valeurs SANS guillemets ni espaces autour du « = ».
PORT=8787
PUBLIC_BASE_URL=$URL
SQLITE_PATH=/srv/gites/data/gites.db
UPLOADS_DIR=/srv/gites/data/uploads
TRUST_PROXY=true
# Jetons tirés au hasard sur ce serveur à l'installation (accès de secours et cron).
ADMIN_TOKEN=$(openssl rand -hex 32)
CRON_KEY=$(openssl rand -hex 32)
EMAILS_ENABLED=false
BEDS24_WRITE_ENABLED=false

# ---- À COLLER PAR JULIEN quand le moment vient (décommenter, redémarrer : sudo systemctl restart gites) ----
#STRIPE_SECRET_KEY=
#STRIPE_PUBLISHABLE_KEY=
#STRIPE_WEBHOOK_SECRET=
#BEDS24_REFRESH_TOKEN=
#BEDS24_WEBHOOK_KEY=
#TURNSTILE_SITE_KEY=
#TURNSTILE_SECRET_KEY=
#SMTP_HOST=
#SMTP_PORT=465
#SMTP_USER=
#SMTP_PASSWORD=
#MAIL_FROM=
#ADMIN_ALLOWED_IPS=
ENV
chmod 600 /srv/gites/.env
echo "  .env créé (jetons aléatoires, rien d'autre de secret)."
REMOTE

echo "4/8 Clé de déploiement GitHub (lecture seule)…"
gites_bash <<'REMOTE'
set -euo pipefail
install -d -m 700 ~/.ssh
[ -f ~/.ssh/deploy_github ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/deploy_github -C "gites-hetzner-lecture-seule"
cat > ~/.ssh/config <<CFG
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/deploy_github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG
chmod 600 ~/.ssh/config
REMOTE
if ! gites "git ls-remote $DEPOT_SSH HEAD" >/dev/null 2>&1; then
  CLE_PUB_TMP="$(mktemp)"
  gites 'cat ~/.ssh/deploy_github.pub' > "$CLE_PUB_TMP"
  # Voie automatique : gh connecté au compte Almarcegui (lecture seule : on ne passe PAS --allow-write).
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo deploy-key add "$CLE_PUB_TMP" --repo "$DEPOT_GH" --title "hetzner-lecture-seule" \
      || echo "  (clé déjà enregistrée, ou refus de gh : on teste l'accès)"
  fi
  rm -f "$CLE_PUB_TMP"
  if ! gites "git ls-remote $DEPOT_SSH HEAD" >/dev/null 2>&1; then
    echo
    echo "  GitHub refuse encore la clé. Clé PUBLIQUE à enregistrer comme deploy key en LECTURE SEULE :"
    gites 'cat ~/.ssh/deploy_github.pub'
    echo "  GitHub > $DEPOT_GH > Settings > Deploy keys > Add deploy key (case « Allow write access » DÉCOCHÉE)."
    if [ -t 0 ]; then
      read -r -p "  Entrée quand c'est fait… " _
    else
      echo "  (session non interactive) : refaire ce script une fois la clé ajoutée." >&2
      exit 3
    fi
    gites "git ls-remote $DEPOT_SSH HEAD" >/dev/null || { echo "GitHub refuse toujours la clé." >&2; exit 1; }
  fi
fi

echo "5/8 Clone du dépôt…"
gites "test -d /srv/gites/app/.git || git clone $DEPOT_SSH /srv/gites/app"

echo "6/8 Premier déploiement (npm ci + build : quelques minutes)…"
gites /srv/gites/deploy.sh
adm 'sudo systemctl enable --now gites-cron.timer gites-backup.timer'

echo "6b/8 Secrets GitHub Actions (si gh est connecté et la clé de déploiement existe)…"
CLE_ACTIONS="$HOME/.ssh/gites_deploy_actions_ed25519"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && [ -f "$CLE_ACTIONS" ]; then
  printf '%s' "$IP" | gh secret set DEPLOY_HOST --repo "$DEPOT_GH"
  printf '%s' "gites" | gh secret set DEPLOY_USER --repo "$DEPOT_GH"
  gh secret set DEPLOY_SSH_KEY --repo "$DEPOT_GH" < "$CLE_ACTIONS"
  # Clé d'hôte relevée sur le serveur par la session SSH déjà authentifiée (pas de confiance aveugle).
  printf '%s %s\n' "$IP" "$(adm 'cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')" | gh secret set DEPLOY_KNOWN_HOSTS --repo "$DEPOT_GH"
  echo "  DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS posés."
else
  echo "  sauté : gh non connecté ou $CLE_ACTIONS absente. À poser à la main (docs/hebergement-hetzner.md)." >&2
fi

echo "7/8 Vérifications depuis le Mac…"
curl -fsS --max-time 10 "http://$IP/api/public/health" && echo "  http://$IP (sonde seulement) : OK"
if curl -fsS --max-time 15 "https://$PREMIER/api/public/health" >/dev/null 2>&1; then
  echo "  https://$PREMIER : OK"
else
  echo "  https://$PREMIER ne répond pas encore (DNS pas posé ou certificat en cours) : normal avant le DNS."
fi

echo "8/8 verify-deploy.mjs…"
if [ "$VERIFIER" = oui ]; then
  gites_bash <<'REMOTE'
set -euo pipefail
n="$(sqlite3 /srv/gites/data/gites.db 'SELECT COUNT(*) FROM bookings' 2>/dev/null || echo 0)"
if [ "$n" != 0 ]; then echo "  Base non vide ($n réservations) : verify-deploy écrit des réservations de test, on ne le lance pas."; exit 0; fi
cd /srv/gites/app
set -a; . /srv/gites/.env; set +a
node node/verify-deploy.mjs http://127.0.0.1:8787
REMOTE
else
  echo "  sauté (--sans-verification)."
fi

cat <<FIN

Serveur installé : $IP
Reste à faire :
  - DNS : $DOMAINES -> $IP (enregistrement A chez Cloudflare, nuage GRIS = « DNS seulement » le temps du certificat) ;
  - Julien colle ses clés (Stripe, Beds24, SMTP) : ssh -i $CLE claude@$IP 'sudo -u gites nano /srv/gites/.env'
    puis sudo systemctl restart gites ;
  - données : deploy/hetzner/migrer-depuis-dev1.sh $IP $PREMIER --sauvegarde-fraiche
FIN
