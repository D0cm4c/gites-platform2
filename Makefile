# Gites Platform : les commandes du dépôt (méthode reprise de Greffe, 09/10/2026).
#
# `make check` : tout ce qui doit passer avant de dire « fini ».
# `make livrer` : la production (site Node chez Infomaniak, décision du 10/10/2026),
# et seulement par là ; `make livrer-essai` : l'essai ; `make livrer-cloudflare` :
# l'ancien Worker de production, tant qu'il existe.
#
# ⚠️ Jamais `make check | tail … && git commit` : un tube rend le code de sortie de
# sa DERNIÈRE commande, et l'échec de `make check` passe inaperçu (arrivé sur
# Greffe le 02/10/2026). Lancer `make check` seul, ou sous `set -o pipefail`.
# Une suite de commandes dont une étape prépare la suivante s'enchaîne par `&&`.
#
# Le make d'Apple est GNU Make 3.81 : il ignore .SHELLFLAGS. Chaque ligne de
# recette est donc une commande simple (make s'arrête si elle échoue), et la
# logique à plusieurs étapes vit dans des scripts Python (scripts/livrer.py,
# scripts/sauvegarde_nuit.py), pas dans des tubes ni des `if` de shell.
#
# Le dossier du dépôt contient un émoji et des espaces (« 🔧 Dev/Gites Platform ») :
# les recettes travaillent en chemins relatifs.

SHELL := /bin/bash
# node et npm viennent de Homebrew ; le python de Homebrew est le seul qui lise
# ~/Documents sous launchd (TCC). wrangler : celui du dépôt (npm ci), jamais un
# wrangler global ni un `npx` qui télécharge.
export PATH := /opt/homebrew/bin:$(PATH)
PYTHON := /opt/homebrew/bin/python3
WRANGLER := node_modules/.bin/wrangler
VITEST := node_modules/.bin/vitest
# Marque posée par un `make check` vert sur un arbre propre : le commit vérifié.
# scripts/livrer.py refuse de livrer si elle ne vaut pas HEAD.
MARQUE_CHECK := .wrangler/check-ok
PORT ?= 8788

.PHONY: installer dev test check sauvegarde sauvegarde-cloudflare livrer livrer-essai livrer-cloudflare sonde-prod sonde-essai sonde-cloudflare installer-sonde deployer-hetzner sonde-hetzner _outils

# make livrer SANS_SAUVEGARDE=oui : livrer sans sauvegarde préalable, le temps que le compte « sauvegarde » existe.
SANS_SAUVEGARDE ?=
OPTION_SAUVEGARDE := $(if $(filter oui,$(SANS_SAUVEGARDE)),--sans-sauvegarde,)
# Copie de la sonde lue par le LaunchAgent com.julien.gites-sonde (hors du dépôt :
# elle ne dépend ni d'un worktree ni d'une branche).
SONDE_INSTALLEE := $(HOME)/.local/share/gites/gites_sonde.py

installer:  ## dépendances, telles que le verrou les fixe
	npm ci

_outils:
	@test -x $(WRANGLER) -a -x $(VITEST) || { echo "node_modules incomplet : make installer d'abord."; exit 1; }

dev: _outils  ## base locale à jour, puis serveur local sur 8788 (jamais 8787, pris par un autre service)
	npm run -s db:migrate:local
	$(WRANGLER) dev --port $(PORT)

test: _outils  ## les tests, un fichier après l'autre (en parallèle, Miniflare se marche dessus sur ce Mac)
	$(VITEST) run --no-file-parallelism

check: _outils  ## tout ce qui doit passer avant de dire « fini » ; sur un arbre propre, marque le commit vérifié
	rm -f $(MARQUE_CHECK)
	npm run -s typecheck
	$(VITEST) run --no-file-parallelism
	npm run -s check:images
	@# les scripts Python se lisent sans erreur (ast, et non py_compile : pas de __pycache__ dans l'arbre)
	$(PYTHON) -B -c 'import ast, sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' scripts/sauvegarde_nuit.py scripts/livrer.py scripts/gites_sonde.py scripts/gites_admin.py scripts/importer_agenda_google.py scripts/test_importer_agenda_google.py
	@# l'interprétation des titres d'agenda (import Google), sur des titres de la forme des vrais
	$(PYTHON) -B -m unittest -q scripts/test_importer_agenda_google.py
	@etat="$$(git status --porcelain)" || { echo "git status a échoué : aucune marque posée."; exit 1; }; \
	head="$$(git rev-parse HEAD)" || { echo "git rev-parse a échoué : aucune marque posée."; exit 1; }; \
	if [ -z "$$etat" ] && [ -n "$$head" ]; then mkdir -p .wrangler && echo "$$head" > $(MARQUE_CHECK) && echo "check vert sur $${head:0:8} : livrable."; \
	else echo "check vert, mais l'arbre n'est pas propre : rien n'est livrable avant un commit et un nouveau make check."; fi

sauvegarde:  ## copie horodatée de la base de PRODUCTION (Infomaniak, HTTPS, compte « sauvegarde ») dans sauvegardes/, ligne dans ~/Library/Logs/gites-sauvegarde.log
	$(PYTHON) scripts/sauvegarde_nuit.py --cible infomaniak --origine manuel

sauvegarde-cloudflare:  ## export de l'ancienne base D1 de production (wrangler, lecture seule), tant que le Worker existe
	$(PYTHON) scripts/sauvegarde_nuit.py --cible cloudflare --origine manuel

livrer:  ## PRODUCTION Infomaniak (go de Julien), depuis main : gardes, sauvegarde, push de main, geste Manager (redémarrer), sonde
	$(PYTHON) scripts/livrer.py --cible prod $(OPTION_SAUVEGARDE)

livrer-cloudflare:  ## l'ancien Worker de production (wrangler), depuis main : gardes, sauvegarde D1, migrations distantes, déploiement, sonde
	$(PYTHON) scripts/livrer.py --cible cloudflare

livrer-essai:  ## ESSAI, depuis n'importe quelle branche : gardes, sauvegarde de la base d'essai, migrations, déploiement avec le jeton d'essai, sonde
	$(PYTHON) scripts/livrer.py --cible essai

sonde-prod:  ## la production : /api/public/health ok ET traitement planifié passé il y a 30 min au plus (journal, sans Telegram)
	$(PYTHON) scripts/gites_sonde.py --sans-telegram

sonde-cloudflare:  ## la sonde publique de l'ancien Worker
	$(PYTHON) scripts/livrer.py --sonde cloudflare

installer-sonde:  ## copie scripts/gites_sonde.py là où le LaunchAgent com.julien.gites-sonde la lit (à refaire après un changement de la sonde)
	mkdir -p $(dir $(SONDE_INSTALLEE))
	install -m 0644 scripts/gites_sonde.py $(SONDE_INSTALLEE)

sonde-essai:  ## la sonde publique de l'essai
	$(PYTHON) scripts/livrer.py --sonde essai

# Serveur Hetzner (docs/hebergement-hetzner.md). Variables : HETZNER_HOST (adresse ou nom du serveur),
# HETZNER_URL (adresse publique pour la sonde), HETZNER_CLE (clé SSH de Claude, par défaut ~/.ssh/gites_hetzner_ed25519).
HETZNER_HOST ?=
HETZNER_CLE ?= $(HOME)/.ssh/gites_hetzner_ed25519
HETZNER_URL ?=

deployer-hetzner:  ## déploie main sur le serveur Hetzner sans passer par GitHub : make deployer-hetzner HETZNER_HOST=<ip-ou-nom> (ssh gites@… /srv/gites/deploy.sh)
	@test -n "$(HETZNER_HOST)" || { echo "Donner HETZNER_HOST=<ip-ou-nom>"; exit 1; }
	ssh -i $(HETZNER_CLE) -o IdentitiesOnly=yes gites@$(HETZNER_HOST) /srv/gites/deploy.sh

sonde-hetzner:  ## la sonde publique du serveur Hetzner : make sonde-hetzner HETZNER_URL=https://<domaine> (ou http://<ip>) ; /api/public/health doit répondre ok
	@test -n "$(HETZNER_URL)" || { echo "Donner HETZNER_URL=https://<domaine> (ou http://<ip>)"; exit 1; }
	curl -fsS --max-time 15 $(HETZNER_URL)/api/public/health
