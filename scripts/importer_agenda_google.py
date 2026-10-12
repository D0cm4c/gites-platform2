#!/opt/homebrew/bin/python3
# Lit l'export JSON des deux agendas Google de papa (« location maison du scieur », « location scierie »), en déduit réservations, paiements, annulations et blocages, affiche le tableau événement → action et, avec --oui seulement, l'envoie à POST /api/admin/import/agenda-google (clé de service de ~/.config/gites/service.env).
# Usage : /opt/homebrew/bin/python3 scripts/importer_agenda_google.py <export.json> [--essai | --simuler | --oui] [--depuis AAAA-MM-JJ] [--depart-exclu] [--table-md fichier.md] [--charge-utile fichier.json]
"""Import des agendas Google du père de Julien dans la plateforme.

Les deux agendas Google sont LA base des réservations. Leur flux iCal public ne
donne que « Busy » : la synchronisation crée des réservations sans nom. Ce
script lit l'export complet des événements (titre, invités, dates — fait par les
outils Google Calendar, rangé hors du dépôt : données personnelles) et en tire,
événement par événement :

  - le client : adresse e-mail (invité ou adresse écrite dans le titre), nom
    déduit de l'adresse (« jean.dupont@… » → « Jean Dupont ») ; une adresse
    d'un seul mot reste brute (« dupontbvba » → « Dupontbvba ») ;
  - les paiements : un montant suivi d'une date (« 1379 25/12 1039 22/9 ») ; une
    date seule, la dernière, est la date de la demande ; « à payer », « reste à
    payer », « solde … plus charges », « supplément » = montant dû, pas payé ;
  - le statut : « annul… », « abandonné » → annulée ; famille et usages de papa
    (TLF, marche Lesse et Lomme, famille de Cartier, fêtes…) et
    événements sans client ni montant → blocage manuel avec motif ; rendez-vous
    de quelques heures → ignoré ;
  - les dates : événement sur la journée → arrivée = début, départ = fin
    (exclusive, comme le flux iCal) ; événement à l'heure → dates à Bruxelles
    (même règle que la synchronisation iCal depuis #112).

Le même client sur les deux agendas aux mêmes dates donne DEUX réservations, une
par maison (c'est ce que fait papa ; le Domaine n'est pas une chambre Beds24),
avec une note qui le dit.

Modes (un seul) :
  --essai     (défaut) tableau seulement, rien n'est envoyé nulle part
  --simuler   le serveur dit ce qu'il ferait (essai: true), sans rien écrire
  --oui       écrit : crée, complète, annule, bloque (idempotent : relançable)

Les sorties (--table-md, --charge-utile) contiennent des noms et des adresses :
à ranger dans le vault, jamais dans le dépôt.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

BRUXELLES = ZoneInfo("Europe/Brussels")
# Locaux d'adresse qui ne disent rien de la personne : le nom vient alors du texte.
LOCAUX_GENERIQUES = {"info", "contact", "reservation", "reservations", "booking", "admin", "mail", "hello", "office", "bonjour"}
# Famille, amis et usages propres de papa : un blocage, jamais une vente.
MOTS_BLOCAGE = [
    r"\btlf\b", r"marche\s+lesse", r"cartier", r"f[eê]tes?\s+des\s+voisins",
]
MOTS_ANNULATION = re.compile(r"annul|abandonn", re.I)
MOIS = {
    "janvier": 1, "fevrier": 2, "février": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "aout": 8, "août": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12, "décembre": 12,
}
PAIEMENT_APRES_DEPART_JOURS = 21  # une date sans année se lit au plus tard trois semaines après le départ
RDV_MAX_HEURES = 6  # un événement à l'heure plus court (ou sur un seul jour) est un rendez-vous, pas un séjour

RE_EMAIL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
RE_TEL = re.compile(r"(?<!\d)(?:\+32|0032|0)4\d{2}[ ./]?\d{2}[ ./]?\d{2}[ ./]?\d{2}(?!\d)")
_MONTANT = r"\d{3,5}(?:,\d{1,2})?"
RE_JETONS = re.compile(
    r"(?P<datefull>(?<!\d)(?P<fj>\d{1,2})\s*/\s*(?P<fm>\d{1,2})\s*/\s*(?P<fa>\d{2}|\d{4})(?!\d))"
    r"|(?P<datedm>(?<![\d,])(?P<dj>\d{1,2})\s*[/:]\s*(?P<dm>\d{1,2})(?![\d/]))"
    r"|(?P<datemois>(?:(?P<mj>\d{1,2})\s+|d[ée]but\s+|fin\s+|mi[- ])?(?P<mn>janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)(?:\s+(?P<ma>\d{4}|\d{2})(?![\d/]))?)"
    r"|(?P<annee>(?<![\d,/])20[2-3]\d(?![\d,/]))"
    rf"|(?P<montant>(?<![\d,./])(?P<m1>{_MONTANT})(?P<mplus>(?:\s*\+\s*{_MONTANT})*)\s*€?(?![\d/]))"
    r"|(?P<heure>(?<!\d)\d{1,2}\s*[hH]\d{0,2}(?![a-zA-Z]))",
    re.I,
)
RE_DU = re.compile(r"(?:reste\s+[àa]\s+payer|[àa]\s+payer|solde(?!\s+et)|plus\s+charges|charges|suppl[ée]ment)\s*$", re.I)


# ---------------------------------------------------------------------------
# Modèle
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class Paiement:
    cents: int
    date: str | None  # AAAA-MM-JJ, ou None si la date est inconnue
    libelle: str  # le morceau du titre d'où il vient

    def charge(self) -> dict:
        return {"cents": self.cents, "date": self.date, "methode": "transfer"}


@dataclasses.dataclass
class Ligne:
    calendrier: str
    unit_id: int
    feed_id: int
    event_id: str
    titre: str
    checkin: str
    checkout: str
    minute: bool  # événement à l'heure (et non sur la journée)
    emails: list[str]
    statut: str = "confirmee"  # confirmee | annulee | blocage | ignoree
    email: str | None = None
    nom: str | None = None
    telephone: str | None = None
    paiements: list[Paiement] = dataclasses.field(default_factory=list)
    dus: list[tuple[int, str]] = dataclasses.field(default_factory=list)
    demande: str | None = None
    mentions: str = ""
    motif: str | None = None
    raison: str | None = None  # pour une ligne ignorée
    notes: list[str] = dataclasses.field(default_factory=list)
    doutes: list[str] = dataclasses.field(default_factory=list)
    sans_montant: bool = True

    @property
    def uid(self) -> str:
        return f"{self.event_id}@google.com"

    @property
    def total_cents(self) -> int:
        return sum(p.cents for p in self.paiements) + sum(c for c, _ in self.dus)

    def evenement(self) -> dict:
        """Une ligne de `evenements` pour la route serveur."""
        notes = [f"Agenda Google : « {self.titre} »"] + self.notes
        return {
            "uid": self.uid,
            "checkin": self.checkin,
            "checkout": self.checkout,
            "nom": self.nom,
            "email": self.email,
            "telephone": self.telephone,
            "personnes": None,
            "totalCents": self.total_cents or None,
            "paiements": [p.charge() for p in self.paiements] if self.statut != "blocage" else [],
            "notes": "\n".join(notes),
            "statut": self.statut,
            "motif": self.motif,
        }


# ---------------------------------------------------------------------------
# Lecture d'un événement
# ---------------------------------------------------------------------------

def _sans_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()


DEPART_INCLUS = True  # convention de papa (décision Julien 11/10/2026) ; --depart-exclu pour un agenda à la norme


def dates_evenement(ev: dict, depart_inclus: bool | None = None) -> tuple[str, str, bool, float]:
    """(arrivée, départ, à l'heure ?, durée en heures). Journée entière : papa
    bloque aussi le jour du départ (« du 22 au 26 » affiché = départ le 26), donc
    on retire un jour à la fin exclusive de Google — la plateforme, elle, est à
    la norme (départ exclu). À l'heure : la date de l'instant à Bruxelles, déjà
    juste."""
    if depart_inclus is None:
        depart_inclus = DEPART_INCLUS
    debut, fin = ev.get("start", {}), ev.get("end", {})
    if "date" in debut:
        fin_date = fin["date"][:10]
        if depart_inclus:
            fin_date = (dt.date.fromisoformat(fin_date) - dt.timedelta(days=1)).isoformat()
        return debut["date"][:10], fin_date, False, 24.0
    a = dt.datetime.fromisoformat(debut["dateTime"].replace("Z", "+00:00"))
    b = dt.datetime.fromisoformat(fin["dateTime"].replace("Z", "+00:00"))
    heures = (b - a).total_seconds() / 3600
    return a.astimezone(BRUXELLES).date().isoformat(), b.astimezone(BRUXELLES).date().isoformat(), True, heures


def nettoyer_titre(titre: str) -> str:
    s = titre.replace("\\n", " ").replace("\n", " ")
    s = re.sub(r"mailto:", " ", s, flags=re.I)
    # « 21/10/24berberv@… », « 8/11Gys-Potters » : une date collée à un mot.
    s = re.sub(r"(\d{1,2}/\d{1,2}(?:/\d{2,4})?)(?=[A-Za-zÀ-ÿ])", r"\1 ", s)
    # « 400/6/1 » : 400 € le 6/1.
    s = re.sub(r"(?<![\d/])(\d{3,5})/(\d{1,2}/\d{1,2})", r"\1 \2", s)
    return s


def adresses_du_proprietaire(cal: dict) -> set[str]:
    """Qui tient l'agenda, lu dans les données (jamais écrit dans le code) :
    l'adresse de l'agenda lui-même, et le créateur de la majorité de ses
    événements (papa). Un événement créé par un client (invitation) ne fait
    pas de ce client le propriétaire."""
    evs = cal.get("evenements", [])
    adresses = {str(cal.get("calendarId", "")).lower()}
    createurs = Counter(str((e.get("creator") or {}).get("email", "")).lower() for e in evs)
    createurs.pop("", None)
    if createurs:
        qui, n = createurs.most_common(1)[0]
        if n * 2 >= len(evs):
            adresses.add(qui)
    for e in evs:
        o = str((e.get("organizer") or {}).get("email", "")).lower()
        if o.endswith("@group.calendar.google.com"):
            adresses.add(o)
    return adresses - {""}


def emails_de(ev: dict, texte: str, proprietaire: set[str] = frozenset()) -> list[str]:
    vus: list[str] = []
    candidats = [m.group(0) for m in RE_EMAIL.finditer(texte)]
    for a in ev.get("attendees", []) or []:
        e = str(a.get("email", "")).replace('"', "").replace("mailto:", "")
        if RE_EMAIL.fullmatch(e):
            candidats.append(e)
    for e in candidats:
        e = e.strip(".").lower()
        if e not in vus and e not in proprietaire:
            vus.append(e)
    return vus


def nom_depuis_email(email: str) -> tuple[str | None, bool]:
    """(nom, ambigu ?). None si l'adresse est générique (info@…)."""
    local = email.split("@", 1)[0]
    if local.lower() in LOCAUX_GENERIQUES:
        return None, True
    morceaux = [re.sub(r"\d+", "", m) for m in re.split(r"[._\-+]+", local)]
    morceaux = [m for m in morceaux if m]
    if not morceaux:
        return local, True
    nom = " ".join(m[:1].upper() + m[1:].lower() for m in morceaux)
    return nom, len(morceaux) == 1


def annee_pour(jour: int, mois: int, au_plus_tard: dt.date) -> dt.date | None:
    """La date (jour, mois) la plus récente qui ne dépasse pas `au_plus_tard`."""
    for annee in (au_plus_tard.year, au_plus_tard.year - 1, au_plus_tard.year - 2):
        try:
            d = dt.date(annee, mois, jour)
        except ValueError:
            continue
        if d <= au_plus_tard:
            return d
    return None


def _cents(txt: str) -> int:
    return round(float(txt.replace(",", ".")) * 100)


def lire_texte(texte: str, au_plus_tard: dt.date) -> dict:
    """Montants, dates et reste du texte d'un titre (sans les adresses)."""
    jetons = []
    for m in RE_JETONS.finditer(texte):
        if m.group("datefull"):
            a = int(m.group("fa"))
            a = a + 2000 if a < 100 else a
            try:
                d = dt.date(a, int(m.group("fm")), int(m.group("fj")))
                jetons.append(("date", d.isoformat(), m))
            except ValueError:
                jetons.append(("bruit", m.group(0), m))
        elif m.group("datedm"):
            j, mo = int(m.group("dj")), int(m.group("dm"))
            d = annee_pour(j, mo, au_plus_tard) if 1 <= mo <= 12 and 1 <= j <= 31 else None
            jetons.append(("date", d.isoformat(), m) if d else ("bruit", m.group(0), m))
        elif m.group("datemois"):
            mo = MOIS[_sans_accents(m.group("mn")).replace("û", "u")]
            if m.group("mj") and m.group("ma"):
                a = int(m.group("ma"))
                a = a + 2000 if a < 100 else a
                jetons.append(("date", dt.date(a, mo, int(m.group("mj"))).isoformat(), m))
            elif m.group("mj"):
                d = annee_pour(int(m.group("mj")), mo, au_plus_tard)
                jetons.append(("date", d.isoformat() if d else None, m))
            else:
                # « août 25 », « début avril » : le mois sans le jour.
                a = m.group("ma")
                a = (int(a) + 2000 if int(a) < 100 else int(a)) if a else (au_plus_tard.year if mo <= au_plus_tard.month else au_plus_tard.year - 1)
                jetons.append(("periode", f"{a}-{mo:02d}", m))
        elif m.group("annee"):
            jetons.append(("periode", m.group("annee"), m))
        elif m.group("montant"):
            parts = [m.group("m1")] + re.findall(_MONTANT, m.group("mplus") or "")
            jetons.append(("montant", [_cents(p) for p in parts], m))
        elif m.group("heure"):
            jetons.append(("heure", m.group(0), m))

    paiements: list[Paiement] = []
    dus: list[tuple[int, str]] = []
    dates_libres: list[str] = []
    periodes_libres: list[str] = []
    consommes: set[int] = set()
    for i, (typ, val, m) in enumerate(jetons):
        if typ != "montant":
            continue
        suivant = jetons[i + 1] if i + 1 < len(jetons) else None
        precedent = jetons[i - 1] if i > 0 else None
        avant = texte[: m.start()]
        # Ce qui sépare le montant du jeton suivant : un « . » ou un mot ferme le lien.
        entre_suivant = texte[m.end(): suivant[2].start()] if suivant else ""
        # « 1080 bain ext 30/4 », « 500 Joris 5/8 » : deux mots au plus entre le
        # montant et sa date ; une adresse (§) ou un point coupe le lien.
        lie_suivant = suivant is not None and re.fullmatch(r"[\s/]*(?:[A-Za-zÀ-ÿ'’\-]+\s+){0,2}?[\s/]*", entre_suivant + " ") is not None
        libelle = m.group(0).strip()
        # Contexte « dû » : le mot qui précède IMMÉDIATEMENT le montant (« à payer
        # 884 », « Solde 640,00€ plus charges 350,00 », « supplément 223 ») ; il
        # l'emporte sur une date qui suit (« à payer 884 18/7 » n'est pas payé).
        # « solde et charges 1118 19/10 » : réglé, pas dû.
        du = RE_DU.search(avant.rstrip()) is not None and not re.search(r"solde\s+et\s+charges$", avant.rstrip(), re.I)
        if du:
            for c in val:
                dus.append((c, libelle))
        elif lie_suivant and suivant[0] == "date":
            paiements.append(Paiement(sum(val), suivant[1], f"{libelle} {suivant[2].group(0).strip()}"))
            consommes.add(i + 1)
        elif lie_suivant and suivant[0] == "periode":
            paiements.append(Paiement(sum(val), None, f"{libelle} {suivant[2].group(0).strip()}"))
            consommes.add(i + 1)
        elif precedent is not None and precedent[0] == "date" and (i - 1) not in consommes and re.fullmatch(r"\s*", texte[precedent[2].end(): m.start()]):
            # « complément location 30/8  495 », « Paye MARTIN 30/6 666 ».
            paiements.append(Paiement(sum(val), precedent[1], f"{precedent[2].group(0).strip()} {libelle}"))
            consommes.add(i - 1)
        else:
            paiements.append(Paiement(sum(val), None, libelle))
    for i, (typ, val, m) in enumerate(jetons):
        if i in consommes:
            continue
        # « du 9/4 à 18h », « au vendredi 6/2/26 » : un horaire, pas la demande.
        horaire = re.search(r"(?:\b(?:du|au|le|jusqu'?[àa])|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s*$", texte[: m.start()], re.I)
        if typ == "date" and val and not horaire:
            dates_libres.append(val)
        elif typ == "periode":
            periodes_libres.append(val)

    # Le reste : ce qui n'est ni montant, ni date, ni heure.
    reste = texte
    for typ, _val, m in sorted(jetons, key=lambda j: -j[2].start()):
        if typ in ("montant", "date", "periode", "bruit"):
            reste = reste[: m.start()] + " " + reste[m.end():]
    reste = re.sub(r"\s+", " ", reste.replace("§", " ")).strip(" .,;-")
    return {"paiements": paiements, "dus": dus, "dates": dates_libres, "periodes": periodes_libres, "reste": reste}


MOTS_HORS_NOM = re.compile(
    r"(?<![\w-])(pay[ée]e?|paye|reste|[àa] payer|solde|plus charges|charges|annul\w*|abandonn\w*|[àa] relouer|compl[ée]ment|location|suppl[ée]ment|\d+\s*h\d*|\d+)(?![\w-])",
    re.I,
)


def lire_evenement(cal: dict, ev: dict, au_plus_tard_export: dt.date, proprietaire: set[str] = frozenset()) -> Ligne:
    titre = (ev.get("summary") or "").strip()
    checkin, checkout, minute, heures = dates_evenement(ev)
    texte = nettoyer_titre(titre)
    emails = emails_de(ev, texte, proprietaire)
    ligne = Ligne(cal["nom"], int(cal["unitId"]), int(cal["feedId"]), ev["id"], titre, checkin, checkout, minute, emails)

    if checkin >= checkout or (minute and heures < RDV_MAX_HEURES):
        ligne.statut, ligne.raison = "ignoree", "rendez-vous ou rappel de quelques heures, pas un séjour"
        return ligne

    sans_adresses = RE_EMAIL.sub(" § ", texte)
    tel = RE_TEL.search(sans_adresses)
    if tel:
        ligne.telephone = re.sub(r"[ ./]", "", tel.group(0))
        sans_adresses = sans_adresses.replace(tel.group(0), " ")
    # Les paiements précèdent l'arrivée ; une date « libre » aussi (la demande).
    # Un paiement précède l'arrivée, ou suit de peu le départ (solde réglé après).
    lu = lire_texte(sans_adresses, min(dt.date.fromisoformat(checkout) + dt.timedelta(days=PAIEMENT_APRES_DEPART_JOURS), au_plus_tard_export))
    ligne.paiements, ligne.dus = lu["paiements"], lu["dus"]
    ligne.sans_montant = not lu["paiements"] and not lu["dus"]
    ligne.mentions = lu["reste"]
    if lu["dates"]:
        # La demande précède l'arrivée : une date sans année lue après l'arrivée
        # (fenêtre des paiements) recule d'un an.
        d = dt.date.fromisoformat(lu["dates"][-1])
        if d > dt.date.fromisoformat(checkin):
            try:
                d = d.replace(year=d.year - 1)
            except ValueError:
                d = d.replace(year=d.year - 1, day=28)
        ligne.demande = d.isoformat()
    if lu["periodes"] and not lu["dates"]:
        ligne.demande = lu["periodes"][-1]

    # Les mots de blocage se cherchent hors des adresses (« x.cartier@… » est un client).
    texte_min = _sans_accents(RE_EMAIL.sub(" ", texte))
    if any(re.search(p, texte_min) for p in MOTS_BLOCAGE):
        ligne.statut = "blocage"
        ligne.motif = re.sub(r"\s+", " ", titre).strip()[:200] or "agenda Google (sans titre)"
        return ligne
    if MOTS_ANNULATION.search(titre) and len(emails) > 1:
        # « … jules… Annulation. … anne… » : l'annulation vise l'ancien client,
        # les dates ont été relouées.
        ligne.doutes.append("annulation écrite avec deux clients : gardée confirmée pour le premier (dates relouées ?)")
    elif MOTS_ANNULATION.search(titre):
        ligne.statut = "annulee"
    elif not emails and ligne.sans_montant:
        ligne.statut = "blocage"
        ligne.motif = re.sub(r"\s+", " ", titre).strip()[:200] or "agenda Google (sans titre)"
        ligne.doutes.append("ni adresse ni montant : blocage supposé (famille, usage de papa ?)")
        return ligne

    # Le client.
    attendus = [str(a.get("email", "")).replace('"', "").replace("mailto:", "").lower() for a in ev.get("attendees", []) or []]
    attendus = [a for a in attendus if a in emails]
    if len(emails) > 1:
        # Le premier écrit dans le titre : papa y met le client en cours, l'ancien
        # (« À relouer », « Annulation ») vient après. Sinon l'invité.
        dans_titre = [e.strip(".").lower() for e in RE_EMAIL.findall(texte) if e.strip(".").lower() in emails]
        choisi = dans_titre[0] if dans_titre else (attendus[0] if attendus else emails[0])
        autres = [e for e in emails if e != choisi]
        ligne.doutes.append(f"plusieurs adresses ({', '.join(emails)}) : client retenu {choisi}")
        ligne.notes.append(f"Autres adresses dans l'agenda : {', '.join(autres)}")
    else:
        choisi = emails[0] if emails else None
    ligne.email = choisi
    nom_texte = re.sub(r"\s+", " ", MOTS_HORS_NOM.sub(" ", ligne.mentions)).strip(" .,;-+") or None
    if choisi:
        nom, ambigu = nom_depuis_email(choisi)
        if nom is None:
            nom = nom_texte or choisi.split("@", 1)[1].split(".")[0].capitalize()
            ligne.doutes.append(f"adresse générique ({choisi}) : nom pris dans le texte « {nom} »")
        elif ambigu:
            ligne.doutes.append(f"nom déduit d'une adresse d'un seul mot, gardé brut : « {nom} »")
        ligne.nom = nom
    else:
        ligne.nom = nom_texte or ligne.mentions or titre
        ligne.doutes.append(f"pas d'adresse : nom pris dans le texte « {ligne.nom} »")

    # Notes lisibles.
    if ligne.paiements:
        ligne.notes.append("Paiements lus : " + " ; ".join(
            f"{p.cents / 100:.2f} € le {p.date}" if p.date else f"{p.cents / 100:.2f} € (date inconnue : « {p.libelle} »)"
            for p in ligne.paiements))
    if ligne.dus:
        ligne.notes.append("Montant(s) dû(s) d'après l'agenda : " + " ; ".join(f"{c / 100:.2f} € (« {l} »)" for c, l in ligne.dus))
        ligne.doutes.append("montant « à payer » / « solde » / « supplément » compté dans le total, pas comme payé")
    if ligne.demande:
        ligne.notes.append(f"Demande du {ligne.demande}")
    if ligne.mentions:
        ligne.notes.append(f"Mentions : {ligne.mentions}")
    if re.search(r"bain\s+ext", titre, re.I):
        ligne.notes.append("Bain extérieur compris dans le montant (« bain ext »)")
    if re.search(r"ne sont pas venus", titre, re.I):
        ligne.notes.append("Ne sont pas venus (séjour payé, gardé confirmé)")
        ligne.doutes.append("« Ne sont pas venus » : gardé confirmé (no-show), pas annulé")
    if re.search(r"relouer", titre, re.I):
        ligne.doutes.append("« À relouer » : qui occupe vraiment ces dates ?")
    if any(p.date is None for p in ligne.paiements):
        ligne.doutes.append("paiement sans date précise")
    if ligne.statut == "annulee" and ligne.paiements:
        ligne.doutes.append("annulée avec un paiement enregistré : arrhes gardées ou remboursées ?")
    return ligne


# ---------------------------------------------------------------------------
# Passes croisées
# ---------------------------------------------------------------------------

def _mots(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-zà-ÿ\-]{3,}", _sans_accents(s)) if w not in {"paye", "payer", "anniversaire", "et", "les", "des"}}


def _chevauche(a: Ligne, b: Ligne) -> bool:
    return a.checkin < b.checkout and b.checkin < a.checkout


def passes_croisees(lignes: list[Ligne], aujourdhui: dt.date) -> None:
    actives = lambda: [l for l in lignes if l.statut in ("confirmee", "blocage")]  # noqa: E731

    # 1. Blocage supposé (ni adresse ni montant) dont l'autre maison porte une
    #    vraie location au même nom, aux mêmes dates : c'est une location.
    for l in lignes:
        if l.statut != "blocage" or l.emails or not l.sans_montant or any(re.search(p, _sans_accents(RE_EMAIL.sub(" ", l.titre))) for p in MOTS_BLOCAGE):
            continue
        for o in lignes:
            if o.unit_id != l.unit_id and o.statut == "confirmee" and _chevauche(l, o) and _mots(l.titre) & _mots(o.titre):
                l.statut, l.motif = "confirmee", None
                l.nom = re.sub(r"\s+", " ", MOTS_HORS_NOM.sub(" ", l.mentions)).strip(" .,;-") or l.titre
                l.doutes = [f"sans adresse ni montant, mais l'autre maison loue aux mêmes dates au même nom ({o.event_id}) : location supposée, client « {l.nom} »"]
                l.notes.append(f"Mentions : {l.mentions}")
                break

    # 2. Même client, même maison, séjours qui se chevauchent : un seul séjour.
    for l in lignes:
        if l.statut != "confirmee" or not l.email:
            continue
        for o in lignes:
            if o is l or o.statut != "confirmee" or o.unit_id != l.unit_id or o.email != l.email or not _chevauche(l, o):
                continue
            garde, fond = (l, o) if (l.checkout, l.checkin) >= (o.checkout, o.checkin) and l.checkin <= o.checkin else (o, l)
            if not (garde.checkin <= fond.checkin and fond.checkout <= garde.checkout):
                continue
            garde.paiements += fond.paiements
            garde.dus += fond.dus
            garde.notes.append(f"Fusionnée avec l'événement {fond.event_id} (« {fond.titre} »)")
            garde.doutes.append(f"deux événements du même client sur la même maison fusionnés ({fond.event_id})")
            if dt.date.fromisoformat(fond.checkout) > aujourdhui:
                # À venir : son UID reste dans le flux iCal ; inscrit annulé (motif
                # que la synchro ne rouvre pas), sans paiement, pour qu'elle ne le
                # recrée pas en « Busy ».
                fond.statut, fond.paiements, fond.dus = "annulee", [], []
                fond.notes = [f"Fusionnée dans {garde.uid} : même client, même maison, dates incluses"]
            else:
                fond.statut, fond.raison = "ignoree", f"fusionnée dans {garde.uid} (même client, même maison, dates incluses)"

    # 3. Même client sur les deux maisons aux mêmes dates : deux réservations.
    for l in lignes:
        if l.statut != "confirmee":
            continue
        for o in lignes:
            if o.unit_id != l.unit_id and o.statut == "confirmee" and o.checkin == l.checkin and o.checkout == l.checkout and (
                (l.email and o.email == l.email) or (not l.email and not o.email and _mots(l.titre) & _mots(o.titre))
            ):
                l.notes.append(f"Même client sur l'autre maison aux mêmes dates ({o.calendrier}, {o.event_id}) : une réservation par maison, comme dans les agendas (Domaine entier ?)")
                if l.paiements and o.paiements and sorted((p.cents, p.date) for p in l.paiements) == sorted((p.cents, p.date) for p in o.paiements):
                    l.doutes.append("le même paiement est écrit sur les deux agendas : compté sur chaque maison, peut-être deux fois")

    # 4. Chevauchement d'une nuit avec l'arrivée suivante sur la même maison :
    #    papa note le jour du départ. Séjour passé → départ avancé (sinon le
    #    second serait refusé) ; séjour à venir → laissé (la synchro iCal le
    #    remettrait), signalé.
    for unit in {l.unit_id for l in lignes}:
        sejours = sorted((l for l in actives() if l.unit_id == unit), key=lambda l: (l.checkin, l.checkout))
        for i, a in enumerate(sejours):
            for b in sejours[i + 1:]:
                if b.checkin >= a.checkout:
                    break
                nuits = (dt.date.fromisoformat(a.checkout) - dt.date.fromisoformat(b.checkin)).days
                if nuits == 1 and a.checkin < b.checkin and dt.date.fromisoformat(a.checkout) <= aujourdhui:
                    a.notes.append(f"Départ avancé du {a.checkout} au {b.checkin} : l'agenda chevauchait d'un jour l'arrivée suivante ({b.event_id})")
                    a.doutes.append(f"départ avancé au {b.checkin} (chevauchement d'un jour avec {b.event_id})")
                    a.checkout = b.checkin
                else:
                    a.doutes.append(f"chevauche {b.event_id} ({b.checkin}→{b.checkout}) : le second sera refusé (conflit)")


def interpreter(export: dict, depuis: str | None = None) -> list[Ligne]:
    exporte = dt.date.fromisoformat(str(export.get("exporte_le", dt.date.today().isoformat()))[:10])
    lignes: list[Ligne] = []
    for cal in export["calendriers"]:
        proprietaire = adresses_du_proprietaire(cal)
        for ev in cal["evenements"]:
            if ev.get("status") == "cancelled":
                continue
            l = lire_evenement(cal, ev, exporte, proprietaire)
            if depuis and l.checkout <= depuis:
                l.statut, l.raison = "ignoree", f"terminé avant le {depuis}"
            lignes.append(l)
    passes_croisees(lignes, exporte)
    lignes.sort(key=lambda l: (l.unit_id, l.checkin, l.event_id))
    return lignes


# ---------------------------------------------------------------------------
# Sorties
# ---------------------------------------------------------------------------

ACTION = {"confirmee": "réservation", "annulee": "réservation annulée", "blocage": "blocage manuel", "ignoree": "ignoré"}


def _eur(c: int) -> str:
    return f"{c / 100:,.2f}".replace(",", " ").replace(".", ",").replace(" ", " ") + " €"


def tableau(lignes: list[Ligne], nominatif: bool = True) -> str:
    out = ["| Maison | Événement | Dates | Titre | Action | Client | Payé | Total | Doutes |", "|---|---|---|---|---|---|---|---|---|"]
    for l in lignes:
        client = (f"{l.nom} <{l.email}>" if l.email else (l.nom or "")) if l.statut in ("confirmee", "annulee") else (l.motif or l.raison or "")
        payes = " + ".join(_eur(p.cents) + (f" ({l_date(p.date)})" if p.date else "") for p in l.paiements) if l.statut != "blocage" else ""
        titre = l.titre.replace("|", "/").replace("\\n", " ").replace("\n", " ")
        if not nominatif:
            client, titre = ("client" if l.statut in ("confirmee", "annulee") else (l.motif and "motif" or l.raison or "")), "—"
        out.append(
            f"| {'Scieur' if l.unit_id == 1 else 'Scierie'} | `{l.event_id[:8]}` | {l.checkin} → {l.checkout} | {titre} | {ACTION[l.statut]} | {client} | {payes} | "
            f"{_eur(l.total_cents) if l.total_cents and l.statut != 'blocage' else ''} | {'<br>'.join(l.doutes)} |"
        )
    return "\n".join(out)


def l_date(iso: str) -> str:
    a, m, j = iso.split("-")
    return f"{j}/{m}/{a}"


def charges_utiles(lignes: list[Ligne]) -> list[dict]:
    par_cal: dict[tuple[int, int], list[dict]] = {}
    for l in lignes:
        if l.statut == "ignoree":
            continue
        par_cal.setdefault((l.unit_id, l.feed_id), []).append(l.evenement())
    return [{"unitId": u, "feedId": f, "evenements": evs} for (u, f), evs in sorted(par_cal.items())]


def resume(lignes: list[Ligne]) -> dict:
    r: dict[str, dict[str, int]] = {}
    for l in lignes:
        r.setdefault(l.calendrier, {"evenements": 0, "confirmee": 0, "annulee": 0, "blocage": 0, "ignoree": 0})
        r[l.calendrier]["evenements"] += 1
        r[l.calendrier][l.statut] += 1
    return r


def main() -> int:
    p = argparse.ArgumentParser(description="Import des agendas Google de papa dans la plateforme des gîtes.")
    p.add_argument("export", help="export JSON des agendas (hors dépôt : données personnelles)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--essai", action="store_true", help="(défaut) tableau seulement, rien n'est envoyé")
    mode.add_argument("--simuler", action="store_true", help="le serveur dit ce qu'il ferait, sans rien écrire")
    mode.add_argument("--oui", action="store_true", help="écrire sur le serveur (idempotent)")
    p.add_argument("--depuis", help="ignorer les séjours terminés avant cette date (AAAA-MM-JJ)")
    p.add_argument("--depart-exclu", action="store_true", help="agenda tenu à la norme (jour de départ libre) : ne pas retirer un jour aux journées entières")
    p.add_argument("--table-md", help="écrire le tableau nominatif dans ce fichier (à ranger dans le vault)")
    p.add_argument("--charge-utile", help="écrire le JSON envoyé au serveur dans ce fichier (à ranger dans le vault)")
    a = p.parse_args()
    global DEPART_INCLUS
    DEPART_INCLUS = not a.depart_exclu

    export = json.loads(Path(a.export).read_text(encoding="utf-8"))
    lignes = interpreter(export, a.depuis)
    print(tableau(lignes))
    print()
    print(json.dumps(resume(lignes), ensure_ascii=False, indent=2))
    charges = charges_utiles(lignes)
    if a.table_md:
        Path(a.table_md).write_text(tableau(lignes) + "\n", encoding="utf-8")
    if a.charge_utile:
        Path(a.charge_utile).write_text(json.dumps(charges, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not (a.oui or a.simuler):
        print("\nEssai : rien n'a été envoyé. --simuler pour l'avis du serveur, --oui pour écrire.", file=sys.stderr)
        return 0

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gites_admin import Api, Erreur, lire_config  # noqa: E402

    try:
        api = Api(*lire_config())
        for c in charges:
            r = api.objet("POST", "/api/admin/import/agenda-google", {**c, "essai": bool(a.simuler)})
            print(json.dumps(r, ensure_ascii=False, indent=2))
    except Erreur as e:
        print(json.dumps({"erreur": str(e)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
