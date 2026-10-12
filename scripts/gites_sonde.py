#!/opt/homebrew/bin/python3
# Sonde de la production des gîtes (https://178-105-145-191.sslip.io, Hetzner) : /api/public/health répond ok et le cron a tourné il y a 30 min au plus ; une ligne dans ~/Library/Logs/gites-sonde.log, alerte Telegram (outbox du pont) au passage au rouge, rappel toutes les 12 h, message au retour au vert.
# Usage : /opt/homebrew/bin/python3 scripts/gites_sonde.py [--url https://178-105-145-191.sslip.io] [--seuil-cron 30] [--sans-telegram]   ·   LaunchAgent com.julien.gites-sonde (toutes les 30 min, copie installée par make installer-sonde)
"""Sonde de la production des gîtes, depuis le Mac.

Vérifie, sans aucun secret :
1. GET <url>/api/public/health répond 2xx, sans redirection, avec un JSON dont
   `ok` vaut true (l'application répond et sa base est lisible) ;
2. `cronAgeMinutes` (âge du dernier passage du traitement planifié, que le
   Planificateur Infomaniak déclenche toutes les 15 min) vaut au plus 30 :
   au-delà, ou s'il n'a jamais tourné (null), c'est une alerte — plus de
   rappels de solde, plus de synchro Beds24, plus de relève des messages.

Une panne réseau ou HTTP est retentée une fois après 15 s avant de conclure.

Sorties :
- une ligne par passage dans ~/Library/Logs/gites-sonde.log (« VERT … » ou
  « ROUGE … ») ;
- Telegram, par l'outbox que le pont lit vraiment
  (~/Library/Application Support/TelegramBridge/data/outbox.jsonl, format
  des scripts du vault : id, timestamp, chat_id, text, tag) : au passage au
  rouge, puis un rappel toutes les 12 h tant que ça dure, et un message au
  retour au vert. État entre deux passages : ~/.local/share/gites/sonde-etat.json ;
- code de sortie 0 vert, 1 rouge, 2 erreur d'usage.

Arrêt : launchctl bootout gui/$(id -u)/com.julien.gites-sonde
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

URL_PROD = "https://178-105-145-191.sslip.io"
JOURNAL = Path(os.environ.get("GITES_SONDE_JOURNAL") or (Path.home() / "Library" / "Logs" / "gites-sonde.log"))
OUTBOX = Path(os.environ.get("GITES_SONDE_OUTBOX")
              or (Path.home() / "Library" / "Application Support" / "TelegramBridge" / "data" / "outbox.jsonl"))
ETAT = Path(os.environ.get("GITES_SONDE_ETAT") or (Path.home() / ".local" / "share" / "gites" / "sonde-etat.json"))
CHAT_ID = "8655562662"
RAPPEL_S = 12 * 3600
PAUSE_RETENTE_S = 15


def maintenant() -> dt.datetime:
    return dt.datetime.now().astimezone()


def interroger(url: str, delai_s: float = 20.0) -> tuple[bool, str, float | None]:
    """(répond ok, détail, cronAgeMinutes). Pas de retentative ici."""
    cible = url.rstrip("/") + "/api/public/health"
    try:
        req = urllib.request.Request(cible, headers={"user-agent": "gites-sonde", "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=delai_s) as r:
            if r.geturl() != cible:
                return False, f"redirigé vers {r.geturl()}", None
            corps = r.read(4096).decode("utf-8", "replace")
            if not 200 <= r.status < 300:
                return False, f"HTTP {r.status}", None
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}", None
    except (urllib.error.URLError, OSError) as e:
        return False, f"injoignable ({type(e).__name__}: {str(getattr(e, 'reason', e))[:120]})", None
    try:
        donnees = json.loads(corps)
    except ValueError:
        return False, "réponse qui n'est pas du JSON", None
    if not isinstance(donnees, dict) or donnees.get("ok") is not True:
        return False, f"ok ≠ true ({corps[:120]})", None
    age = donnees.get("cronAgeMinutes")
    return True, "répond", float(age) if isinstance(age, (int, float)) else None


def sonder(url: str, seuil_cron: float, pause_s: float = PAUSE_RETENTE_S) -> tuple[bool, str]:
    ok, detail, age = interroger(url)
    if not ok and pause_s > 0:
        time.sleep(pause_s)
        ok, detail, age = interroger(url)
    if not ok:
        return False, f"le site ne répond pas : {detail}"
    if age is None:
        return False, "le traitement planifié n'a jamais tourné (Planificateur Infomaniak à poser ou arrêté)"
    if age > seuil_cron:
        return False, f"le traitement planifié n'a pas tourné depuis {age:.0f} min (seuil {seuil_cron:.0f})"
    return True, f"site ok, traitement planifié il y a {age:.0f} min"


def lire_etat() -> dict:
    try:
        return json.loads(ETAT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def ecrire_etat(etat: dict) -> None:
    ETAT.parent.mkdir(parents=True, exist_ok=True)
    tmp = ETAT.with_suffix(".tmp")
    tmp.write_text(json.dumps(etat, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, ETAT)


def telegram(texte: str, quand: dt.datetime) -> None:
    ligne = {
        # le pont ignore une ligne sans id ; unique même à la seconde près
        "id": f"gites-sonde-{quand.strftime('%Y%m%d%H%M%S')}-{os.getpid()}-{time.time_ns() % 1_000_000}",
        "timestamp": quand.isoformat(timespec="seconds"),
        "chat_id": CHAT_ID,
        "text": texte,
        "tag": "gites-sonde",
    }
    OUTBOX.parent.mkdir(parents=True, exist_ok=True)
    with OUTBOX.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ligne, ensure_ascii=False) + "\n")


def message_a_envoyer(vert: bool, detail: str, url: str, etat: dict, quand: dt.datetime) -> str | None:
    """Le texte Telegram à envoyer, ou None. Passage au rouge, rappel 12 h, retour au vert."""
    avant = etat.get("vert")
    if vert:
        if avant is False:
            return f"Gîtes : la production est revenue ({url}). {detail}."
        return None
    if avant is not False:
        return f"Gîtes : alerte sur la production ({url}) — {detail}."
    dernier = etat.get("alerte_at")
    try:
        ecoule = (quand - dt.datetime.fromisoformat(dernier)).total_seconds() if dernier else RAPPEL_S
    except ValueError:
        ecoule = RAPPEL_S
    if ecoule >= RAPPEL_S:
        return f"Gîtes : toujours en alerte ({url}) — {detail}."
    return None


def main() -> int:
    p = argparse.ArgumentParser(description="Sonde de la production des gîtes.")
    p.add_argument("--url", default=os.environ.get("GITES_SONDE_URL") or URL_PROD)
    p.add_argument("--seuil-cron", type=float, default=30.0, help="minutes au-delà desquelles le cron est en retard")
    p.add_argument("--sans-telegram", action="store_true", help="journal et sortie seulement (make sonde-prod)")
    p.add_argument("--sans-retente", action="store_true", help=argparse.SUPPRESS)
    a = p.parse_args()
    if not a.url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        p.error("--url doit être en https")

    quand = maintenant()
    vert, detail = sonder(a.url, a.seuil_cron, 0 if a.sans_retente else PAUSE_RETENTE_S)
    ligne = f"{quand.isoformat(timespec='seconds')} {'VERT' if vert else 'ROUGE'} {a.url} {detail}"
    code = 0 if vert else 1
    try:
        JOURNAL.parent.mkdir(parents=True, exist_ok=True)
        with JOURNAL.open("a", encoding="utf-8") as f:
            f.write(ligne + "\n")
    except OSError as e:
        print(f"journal impossible à écrire ({e})", file=sys.stderr)

    if not a.sans_telegram:
        etat = lire_etat()
        texte = message_a_envoyer(vert, detail, a.url, etat, quand)
        if texte:
            try:
                telegram(texte, quand)
                if not vert:
                    etat["alerte_at"] = quand.isoformat(timespec="seconds")
            except OSError as e:
                print(f"outbox Telegram impossible à écrire ({e})", file=sys.stderr)
        etat["vert"] = vert
        etat["vu_at"] = quand.isoformat(timespec="seconds")
        if vert:
            etat.pop("alerte_at", None)
        ecrire_etat(etat)

    print(ligne, file=sys.stdout if vert else sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
