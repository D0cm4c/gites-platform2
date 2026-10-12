// Réglages : tout ce qui ne sert pas tous les jours, rangé par sujet. Chaque
// ligne ouvre un écran du back-office (l'ancien écran a été retiré le
// 10/10/2026). En bas, ce qui ne regarde que cet appareil : clair ou sombre,
// domaine affiché, déconnexion.
import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { DeviceSettings } from "./settings/Device";

interface Entry {
  to: string;
  label: string;
  hint: string;
}

export function SettingsPage() {
  const { t } = useLingui();

  const groups: { title: string; items: Entry[] }[] = [
    {
      title: t`Aide`,
      items: [{ to: "/reglages/aide", label: t`Comment ça marche`, hint: t`Une journée type, le calendrier, la vente par téléphone, le ménage, les messages, qui appeler` }],
    },
    {
      title: t`Prix et ventes`,
      items: [
        { to: "/reglages/tarifs", label: t`Prix et saisons`, hint: t`Prix de base, saisons, prix fixés à la main, l'année en couleurs` },
        { to: "/reglages/promotions", label: t`Remises et codes promo`, hint: t`Long séjour, réservation tôt ou tardive, codes pour votre site` },
        { to: "/reglages/options", label: t`Options payantes`, hint: t`Sauna, bain chaud, linge, petit-déjeuner…` },
      ],
    },
    {
      title: t`Clients et argent`,
      items: [
        { to: "/reglages/clients", label: t`Clients`, hint: t`Coordonnées et séjours de chaque client` },
        { to: "/reglages/paiements", label: t`Paiements reçus`, hint: t`Tout ce qui a été encaissé ou attendu` },
        { to: "/reglages/encaissements", label: t`Encaissements Stripe`, hint: t`Ce qui est arrivé sur chaque compte Stripe : frais, net, total par mois, export` },
        { to: "/reglages/stripe", label: t`Comptes Stripe`, hint: t`Les clés de chaque propriété, test ou réel, l'adresse du webhook` },
        { to: "/reglages/chiffres", label: t`Chiffres de l'année`, hint: t`Remplissage, revenus, comparaison avec l'an passé, exports` },
        { to: "/reglages/modeles", label: t`Modèles de réponse`, hint: t`Les textes tout prêts pour répondre aux clients : accès, horaires, solde, après le séjour` },
      ],
    },
    {
      title: t`Airbnb, Booking et calendriers`,
      items: [
        { to: "/reglages/plateformes", label: t`Airbnb, Booking et Vrbo`, hint: t`La liaison avec les plateformes, leurs réservations, leurs prix` },
        { to: "/reglages/plateformes/prix", label: t`Promotions Airbnb et prix par plateforme`, hint: t`Remises long séjour, réservation tôt, dernière minute ; un prix propre à chaque plateforme` },
        { to: "/reglages/calendriers", label: t`Calendriers reliés`, hint: t`Adresses à donner aux autres sites, calendriers à lire` },
        { to: "/avis", label: t`Avis`, hint: t`La note Airbnb et Booking, les avis qui attendent une réponse` },
      ],
    },
    {
      title: t`Le domaine`,
      items: [
        { to: "/reglages/domaine", label: t`Le domaine et les biens`, hint: t`Coordonnées, horaires, arrhes, taxe de séjour, mails, conditions, biens` },
        { to: "/reglages/registre", label: t`Registre des voyageurs`, hint: t`Personnes hébergées, export pour la police` },
        { to: "/reglages/import", label: t`Importer depuis elloha`, hint: t`Reprendre des réservations d'un fichier` },
        { to: "/reglages/mise-en-route", label: t`Mise en route`, hint: t`Démarches légales et techniques, où on en est` },
      ],
    },
    {
      title: t`Accès et suivi`,
      items: [
        { to: "/reglages/mon-compte", label: t`Mon compte`, hint: t`Changer mon mot de passe` },
        { to: "/reglages/comptes", label: t`Personnes qui ont accès`, hint: t`Créer un accès, changer un mot de passe, couper un accès` },
        { to: "/reglages/journaux", label: t`Journaux`, hint: t`Qui a fait quoi, mails envoyés aux clients` },
        { to: "/reglages/appareil", label: t`Cet appareil`, hint: t`Clair ou sombre, langue, domaine montré, déconnexion` },
      ],
    },
  ];

  return (
    <div className="pg" style={{ maxWidth: 880 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Réglages</Trans>
        </h1>
      </div>
      <p className="lead">
        <Trans>Ce qui se règle de temps en temps, rangé par sujet. Tout se retrouve aussi dans la barre de gauche.</Trans>
      </p>
      {groups.map((g) => (
        <section key={g.title} className="blk">
          <h2 className="sub">{g.title}</h2>
          <nav className="idx" aria-label={g.title}>
            {g.items.map((e) => (
              <Link key={e.to} to={e.to}>
                <span>
                  <b>{e.label}</b>
                  <small>{e.hint}</small>
                </span>
                <IconChevronRight size={22} />
              </Link>
            ))}
          </nav>
        </section>
      ))}

      <section className="blk">
        <h2 className="sub">
          <Trans>Cet appareil</Trans>
        </h2>
        <DeviceSettings />
      </section>
    </div>
  );
}
