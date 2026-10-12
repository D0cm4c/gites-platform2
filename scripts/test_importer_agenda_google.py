#!/opt/homebrew/bin/python3
# Tests de l'interprétation des titres d'agenda (scripts/importer_agenda_google.py), sur des titres de la même forme que les vrais, noms et adresses remplacés.
# Usage : /opt/homebrew/bin/python3 -B -m unittest scripts/test_importer_agenda_google.py
"""Chaque titre ci-dessous reprend LA FORME d'un titre réel des agendas de papa
(montants, dates, fautes de frappe, adresses collées), avec des noms et des
adresses fictifs : les vrais restent hors du dépôt."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importer_agenda_google as m  # noqa: E402


PROPRIO = "proprietaire@example.invalid"


def jour(eid: str, debut: str, fin: str, titre: str, invites: list[str] | None = None) -> dict:
    ev = {"id": eid, "status": "confirmed", "summary": titre, "start": {"date": f"{debut}T00:00:00Z"}, "end": {"date": f"{fin}T00:00:00Z"},
          "creator": {"email": PROPRIO}, "organizer": {"email": "agenda@group.calendar.google.com"}}
    if invites:
        ev["attendees"] = [{"email": e} for e in invites]
    return ev


def heure(eid: str, debut: str, fin: str, titre: str) -> dict:
    return {"id": eid, "status": "confirmed", "summary": titre, "start": {"dateTime": debut}, "end": {"dateTime": fin}}


def export(maison: list[dict], scierie: list[dict] | None = None) -> dict:
    return {
        "exporte_le": "2026-10-10",
        "calendriers": [
            {"unitId": 1, "feedId": 1, "nom": "location maison du scieur", "evenements": maison},
            {"unitId": 2, "feedId": 2, "nom": "location scierie", "evenements": scierie or []},
        ],
    }


def une(titre: str, debut: str = "2026-03-06", fin: str = "2026-03-09", invites: list[str] | None = None) -> m.Ligne:
    return m.interpreter(export([jour("e1", debut, fin, titre, invites)]))[0]


def pay(l: m.Ligne) -> list[tuple[int, str | None]]:
    return [(p.cents, p.date) for p in l.paiements]


class Paiements(unittest.TestCase):
    def test_deux_paiements_puis_date_de_demande(self):
        l = une("1379 25/12 1039 22/9 jean.dupont@example.be 12/9", "2025-12-26", "2026-01-02")
        self.assertEqual(pay(l), [(137900, "2025-12-25"), (103900, "2025-09-22")])
        self.assertEqual(l.demande, "2025-09-12")
        self.assertEqual((l.statut, l.nom, l.email), ("confirmee", "Jean Dupont", "jean.dupont@example.be"))

    def test_montant_date_simple(self):
        l = une("380 18/11 marie.durand@example.com 3/11", "2026-01-31", "2026-02-02")
        self.assertEqual(pay(l), [(38000, "2025-11-18")])
        self.assertEqual(l.demande, "2025-11-03")

    def test_paye_annee_seule_et_adresse_d_un_mot(self):
        l = une("payé 666 2025 dupontbvba@example.be de dupont 14/9/26", "2026-09-25", "2026-09-28")
        self.assertEqual(pay(l), [(66600, None)])
        self.assertEqual(l.nom, "Dupontbvba")
        self.assertTrue(any("seul mot" in d for d in l.doutes))
        self.assertIn("dupont", l.mentions)

    def test_addition(self):
        self.assertEqual(pay(une("286+166 27/11 paul.martin@example.com 21/11", "2026-01-17", "2026-01-19")), [(45200, "2025-11-27")])
        self.assertEqual(pay(une("275 + 160 21:10 275 25/9 pmartin@example.com du 21 à 16h au 24 à 10h. 29/9", "2025-10-21", "2025-10-25")),
                         [(43500, "2025-10-21"), (27500, "2025-09-25")])

    def test_bain_exterieur(self):
        l = une("1080 bain ext 30/4 luc.petit@example.com", "2026-05-08", "2026-05-11")
        self.assertEqual(pay(l), [(108000, "2026-04-30")])
        self.assertTrue(any("Bain extérieur" in n for n in l.notes))

    def test_supplement_est_du_pas_paye(self):
        l = une("leblanc@example.com vendredi 18H 9/10 supplément  223€", "2026-07-10", "2026-07-13")
        self.assertEqual(pay(l), [])
        self.assertEqual([c for c, _ in l.dus], [22300])
        self.assertEqual(l.total_cents, 22300)

    def test_reste_a_payer_et_solde(self):
        l = une("à payer 884 584 18/7 vanlaar@example.co.uk 15/7", "2025-11-08", "2025-11-12")
        self.assertEqual(pay(l), [(58400, "2025-07-18")])
        self.assertEqual([c for c, _ in l.dus], [88400])
        l = une("Solde 640,00€ plus charges 350,00.\\n. lstaq@example.fr 30/8", "2025-12-13", "2025-12-15")
        self.assertEqual(pay(l), [])
        self.assertEqual([c for c, _ in l.dus], [64000, 35000])

    def test_solde_et_charges_regle(self):
        self.assertEqual(pay(une("solde et charges 1118 19/10 rg@example.be 6/8", "2025-10-28", "2025-10-31")), [(111800, "2025-10-19")])

    def test_demande_avant_l_arrivee(self):
        self.assertEqual(une("sm1@example.com 25/8", "2026-08-17", "2026-08-24").demande, "2025-08-25")

    def test_du_l_emporte_sur_la_date_qui_suit(self):
        l = une("à payer 884 18/7 a.b@example.com", "2025-11-08", "2025-11-12")
        self.assertEqual((pay(l), [c for c, _ in l.dus]), ([], [88400]))
        self.assertEqual(pay(une("supplément 223 5/8 a.b@example.com", "2026-09-08", "2026-09-12")), [])

    def test_point_coupe_le_lien_et_adresse_aussi(self):
        l = une("a payer 412.  572   rzz3@example.com 3/11", "2025-11-08", "2025-11-12")
        self.assertEqual(pay(l), [(57200, None)])
        self.assertEqual(l.demande, "2025-11-03")
        l = une("Paye MARTIN 30/6 666 rose.lenoir@example.com 23/6", "2026-09-11", "2026-09-14")
        self.assertEqual(pay(l), [(66600, "2026-06-30")])
        self.assertEqual(l.demande, "2026-06-23")

    def test_montant_colle_a_sa_date(self):
        self.assertEqual(pay(une("400/6/1. 680 11/2 cl_p@example.com 3/1/25", "2025-02-17", "2025-02-24")),
                         [(40000, "2025-01-06"), (68000, "2025-02-11")])

    def test_decimales_et_mois_en_lettres(self):
        self.assertEqual(pay(une("832,5 10/10 mc@example.com vendredi 18H 9/10", "2026-07-11", "2026-07-13")), [(83250, "2025-10-10")])
        self.assertEqual(pay(une("832 21 juin 2024mailto:stef.xx@example.be 18/6/24", "2025-06-07", "2025-06-10")), [(83200, "2024-06-21")])

    def test_solde_regle_apres_le_depart(self):
        # « 452 17/3 » pour un séjour du 13 au 16/3 : réglé le lendemain, pas un an avant.
        self.assertEqual(pay(une("286 9/3 452 17/3 kqq@example.com", "2026-03-13", "2026-03-16")), [(28600, "2026-03-09"), (45200, "2026-03-17")])


class Adresses(unittest.TestCase):
    def test_adresse_collee_a_une_date(self):
        l = une("555 21/10/24bxx@example.com 14/10/24", "2025-03-08", "2025-03-10")
        self.assertEqual(l.email, "bxx@example.com")
        self.assertEqual(pay(l), [(55500, "2024-10-21")])
        self.assertEqual(une("tom_xyz@example.be31/10/24").email, "tom_xyz@example.be")

    def test_mailto_dans_un_invite(self):
        l = une("mailto:sophie.c@example.com 25/9/24", invites=['"mailto:sophie.c"@example.com'])
        self.assertEqual((l.email, l.nom), ("sophie.c@example.com", "Sophie C"))

    def test_adresse_de_papa_ignoree(self):
        l = une("complément location 30/8  495 jeudi soir au mardi 18h", "2025-10-17", "2025-10-21", [PROPRIO, "jan.x@example.com"])
        self.assertEqual(l.email, "jan.x@example.com")
        self.assertEqual(pay(l), [(49500, "2025-08-30")])

    def test_invitation_creee_par_un_client(self):
        # La majorité des événements est créée par le propriétaire ; celui-ci
        # vient d'une invitation du client : son adresse reste celle du client.
        evs = [jour(f"e{i}", "2026-03-06", "2026-03-09", "TLF") for i in range(3)]
        invit = jour("inv", "2026-04-06", "2026-04-09", "séjour", [PROPRIO, "client.z@example.com"])
        invit["creator"] = {"email": "client.z@example.com"}
        l = {x.event_id: x for x in m.interpreter(export(evs + [invit]))}["inv"]
        self.assertEqual(l.email, "client.z@example.com")

    def test_adresse_generique(self):
        l = une("666 12/2 info@lacantine.example  Jos Dal 28/1/25", "2026-10-16", "2026-10-19")
        self.assertEqual(l.nom, "Jos Dal")

    def test_deux_adresses_le_premier_du_titre(self):
        l = une("Reste à payer 474 +190. 564 5/8 18h le 14 paul.x@example.com 29/8 Annulation.   19/6/25 marie_y@example.com 26/9/24",
                "2025-08-14", "2025-08-18", ["marie_y@example.com"])
        self.assertEqual((l.statut, l.email), ("confirmee", "paul.x@example.com"))
        self.assertEqual(pay(l), [(56400, "2025-08-05")])
        self.assertEqual([c for c, _ in l.dus], [47400, 19000])


class Statuts(unittest.TestCase):
    def test_annule(self):
        self.assertEqual(une("annulé contact.z@brasserie.example 27/12/25").statut, "annulee")
        self.assertEqual(une("Abandonné nina@example.com 12/3").statut, "annulee")

    def test_pas_venus_reste_confirmee(self):
        l = une("Ne sont pas venus claire@example.com 17/12 du lundi 2/2/26 à 16h au vendredi 6/2/26 à 10h", "2026-02-03", "2026-02-07")
        self.assertEqual(l.statut, "confirmee")
        self.assertEqual(l.demande, "2025-12-17")  # les dates « du … au … » sont des horaires
        self.assertTrue(any("Ne sont pas venus" in n for n in l.notes))

    def test_horaire_pas_demande(self):
        self.assertEqual(une("865 4/1 hugues@example.com 5/12/25 du 9/4 à 18h", "2026-04-10", "2026-04-13").demande, "2025-12-05")

    def test_blocages_famille_et_usages(self):
        for titre in ["TLF", "marche lesse et lomme ", "Famille Exemple cartier", "fetes des voisins"]:
            l = une(titre)
            self.assertEqual((l.statut, l.motif), ("blocage", titre.strip()), titre)
        self.assertEqual(une("tante de cartier", invites=["tante.x@example.com"]).statut, "blocage")

    def test_sans_titre_motif_par_defaut(self):
        self.assertEqual((une("").statut, une("").motif), ("blocage", "agenda Google (sans titre)"))

    def test_sans_adresse_ni_montant_blocage_suppose(self):
        l = une("Quelque chose")
        self.assertEqual(l.statut, "blocage")
        self.assertTrue(l.doutes)

    def test_sans_adresse_avec_montant_location(self):
        l = une(" 770 8/4 G de durand", "2025-08-02", "2025-08-08")
        self.assertEqual((l.statut, l.nom), ("confirmee", "G de durand"))
        self.assertEqual(pay(l), [(77000, "2025-04-08")])


class Dates(unittest.TestCase):
    def test_journee_depart_inclus(self):
        # convention de papa : affiché du 2 au 4 (fin Google exclusive = 5) = départ le 4
        l = une("x.y@example.com", "2026-10-02", "2026-10-05")
        self.assertEqual((l.checkin, l.checkout), ("2026-10-02", "2026-10-04"))

    def test_journee_a_la_norme(self):
        m.DEPART_INCLUS = False
        try:
            l = une("x.y@example.com", "2026-10-02", "2026-10-05")
        finally:
            m.DEPART_INCLUS = True
        self.assertEqual((l.checkin, l.checkout), ("2026-10-02", "2026-10-05"))

    def test_journee_d_un_seul_jour_ignoree(self):
        l = une("x.y@example.com", "2026-10-02", "2026-10-03")
        self.assertEqual(l.statut, "ignoree")

    def test_heure_a_bruxelles(self):
        l = m.interpreter(export([heure("e1", "2026-11-01T23:00:00Z", "2026-11-08T09:00:00Z", "dpx@example.com 11/11 vendredi à 10h")]))[0]
        self.assertEqual((l.checkin, l.checkout), ("2026-11-02", "2026-11-08"))
        l = m.interpreter(export([heure("e1", "2025-12-26T21:00:00+01:00", "2026-01-02T21:00:00+01:00", "a.b@example.com")]))[0]
        self.assertEqual((l.checkin, l.checkout), ("2025-12-26", "2026-01-02"))

    def test_une_nuit_a_l_heure_gardee(self):
        l = m.interpreter(export([heure("e1", "2026-03-06T16:00:00+01:00", "2026-03-07T10:00:00+01:00", "a.b@example.com")]))[0]
        self.assertEqual((l.statut, l.checkin, l.checkout), ("confirmee", "2026-03-06", "2026-03-07"))

    def test_mot_de_blocage_dans_une_adresse_ignore(self):
        self.assertEqual(une("640 2/2 paul.cartier@example.com").statut, "confirmee")

    def test_rendez_vous_ignore(self):
        for d, f in [("2025-01-15T10:30:00+01:00", "2025-01-15T11:30:00+01:00"), ("2025-05-25T23:33:55+02:00", "2025-05-26T00:33:55+02:00")]:
            self.assertEqual(m.interpreter(export([heure("e1", d, f, "Rdv électricien 0495000000")]))[0].statut, "ignoree")


class PassesCroisees(unittest.TestCase):
    def test_meme_client_deux_maisons_deux_reservations(self):
        lignes = m.interpreter(export([jour("a", "2025-02-01", "2025-02-03", "luc.m@example.com 31/12")], [jour("b", "2025-02-01", "2025-02-03", "luc.m@example.com 31/12")]))
        self.assertEqual([(l.unit_id, l.statut) for l in lignes], [(1, "confirmee"), (2, "confirmee")])
        self.assertTrue(all(any("autre maison" in n for n in l.notes) for l in lignes))

    def test_meme_paiement_sur_les_deux_agendas_signale(self):
        t = " 640 27/1 fzz@example.com 4/2/25"
        lignes = m.interpreter(export([jour("a", "2025-10-11", "2025-10-13", t)], [jour("b", "2025-10-11", "2025-10-13", t)]))
        self.assertTrue(all(any("deux agendas" in d for d in l.doutes) for l in lignes))

    def test_blocage_suppose_devient_location_si_l_autre_maison_loue(self):
        lignes = m.interpreter(export(
            [jour("a", "2025-04-05", "2025-04-07", "Duval-Test et Swan")],
            [jour("b", "2025-04-05", "2025-04-07", "990 23/3 640 8/11Duval-Test et Swan")],
        ))
        self.assertEqual([(l.statut, l.nom) for l in lignes], [("confirmee", "Duval-Test et Swan"), ("confirmee", "Duval-Test et Swan")])
        self.assertEqual(pay(lignes[1]), [(99000, "2025-03-23"), (64000, "2024-11-08")])

    def test_fusion_meme_client_meme_maison(self):
        lignes = m.interpreter(export([], [
            jour("a", "2025-10-17", "2025-10-20", "payé 611 25/2 de BIKES jy@example.com 24/2/25"),
            jour("b", "2025-10-17", "2025-10-21", "complément location 30/8  495 jeudi soir au mardi 18h", [PROPRIO, "jy@example.com"]),
        ]))
        par_id = {l.event_id: l for l in lignes}
        self.assertEqual(par_id["a"].statut, "ignoree")
        self.assertEqual(sorted(pay(par_id["b"])), [(49500, "2025-08-30"), (61100, "2025-02-25")])

    def test_fusion_a_venir_inscrit_l_autre_annule(self):
        lignes = m.interpreter(export([], [
            jour("a", "2027-10-17", "2027-10-20", "611 25/2 jy@example.com"),
            jour("b", "2027-10-17", "2027-10-21", "495 30/8 jy@example.com"),
        ]))
        par_id = {l.event_id: l for l in lignes}
        self.assertEqual((par_id["a"].statut, par_id["a"].paiements), ("annulee", []))
        self.assertEqual(sorted(pay(par_id["b"])), [(49500, "2026-08-30"), (61100, "2026-02-25")])

    def test_chevauchement_d_un_jour_passe_depart_avance(self):
        lignes = m.interpreter(export([
            jour("a", "2025-12-20", "2025-12-27", "962 7/1/25 gxx@example.com1/1/25 à 10h le vendredi"),
            heure("b", "2025-12-26T21:00:00+01:00", "2026-01-02T21:00:00+01:00", "1379 25/12 myy@example.be 12/9"),
        ]))
        self.assertEqual((lignes[0].checkin, lignes[0].checkout), ("2025-12-20", "2025-12-26"))
        self.assertTrue(lignes[0].doutes)

    def test_chevauchement_a_venir_laisse_et_signale(self):
        lignes = m.interpreter(export([
            jour("a", "2027-07-31", "2027-08-08", "a@example.com"),  # affiché jusqu'au 7 = départ le 7
            jour("b", "2027-08-06", "2027-08-10", "b@example.com"),  # arrivée le 6 : vrai chevauchement
        ]))
        self.assertEqual(lignes[0].checkout, "2027-08-07")
        self.assertTrue(any("conflit" in d for d in lignes[0].doutes))


class ChargeUtile(unittest.TestCase):
    def test_forme_envoyee(self):
        lignes = m.interpreter(export([
            jour("abc", "2026-10-08", "2026-10-12", "832 9/2 jan.e@example.com 5/2 "),
            jour("tlf", "2026-11-25", "2026-11-27", "TLF"),
            heure("rdv", "2025-01-06T18:00:00+01:00", "2025-01-06T19:00:00+01:00", "Rdv"),
        ]))
        charges = m.charges_utiles(lignes)
        self.assertEqual(len(charges), 1)
        self.assertEqual((charges[0]["unitId"], charges[0]["feedId"]), (1, 1))
        evs = {e["uid"]: e for e in charges[0]["evenements"]}
        self.assertEqual(set(evs), {"abc@google.com", "tlf@google.com"})
        self.assertEqual(evs["abc@google.com"]["paiements"], [{"cents": 83200, "date": "2026-02-09", "methode": "transfer"}])
        self.assertEqual((evs["tlf@google.com"]["statut"], evs["tlf@google.com"]["motif"], evs["tlf@google.com"]["paiements"]), ("blocage", "TLF", []))
        self.assertIn("Agenda Google : « 832 9/2", evs["abc@google.com"]["notes"])


if __name__ == "__main__":
    unittest.main()
