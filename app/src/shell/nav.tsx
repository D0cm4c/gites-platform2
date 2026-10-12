// Le plan de navigation, écrit une fois : la barre latérale de l'ordinateur,
// la feuille « Plus » du téléphone et le fil d'Ariane des pages le lisent.
import { useLingui } from "@lingui/react/macro";
import {
  IconAdjustmentsHorizontal, IconBook2, IconBrush, IconCalendar, IconCalendarShare, IconChartBar, IconCreditCard,
  IconDeviceDesktop, IconDiscount, IconHelpCircle, IconHome2, IconKey, IconMessageDots, IconList, IconListCheck, IconMessage,
  IconPlugConnected, IconRosetteDiscount, IconSparkles, IconStar, IconSun, IconTemplate, IconTicket, IconUserCircle, IconUsers,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

export interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /** compteur affiché à côté (messages non lus, ménages du jour) */
  badge?: "unread" | "cleaning" | "improvements";
  /** la page couvre aussi ses sous-adresses (Beds24 et canaux → /reglages/plateformes/…) */
  exact?: boolean;
}
export interface NavSection {
  id: string;
  title: string;
  entries: NavEntry[];
}

const I = 20;

export function useNav(): NavSection[] {
  const { t } = useLingui();
  return [
    {
      id: "quotidien",
      title: t`Quotidien`,
      entries: [
        { to: "/", label: t`Aujourd'hui`, icon: <IconSun size={I} />, exact: true },
        { to: "/calendrier", label: t`Calendrier`, icon: <IconCalendar size={I} /> },
        { to: "/reservations", label: t`Réservations`, icon: <IconList size={I} /> },
        { to: "/messages", label: t`Messages`, icon: <IconMessage size={I} />, badge: "unread" },
        { to: "/menage", label: t`Ménage`, icon: <IconBrush size={I} />, badge: "cleaning" },
      ],
    },
    {
      id: "argent",
      title: t`Clients et argent`,
      entries: [
        { to: "/reglages/clients", label: t`Clients`, icon: <IconUsers size={I} /> },
        { to: "/reglages/paiements", label: t`Paiements`, icon: <IconCreditCard size={I} /> },
        { to: "/reglages/chiffres", label: t`Chiffres`, icon: <IconChartBar size={I} /> },
      ],
    },
    {
      id: "prix",
      title: t`Prix`,
      entries: [
        { to: "/reglages/tarifs", label: t`Prix et saisons`, icon: <IconTicket size={I} /> },
        { to: "/reglages/plateformes/prix", label: t`Promotions`, icon: <IconRosetteDiscount size={I} /> },
        { to: "/reglages/promotions", label: t`Remises`, icon: <IconDiscount size={I} /> },
        { to: "/reglages/options", label: t`Options`, icon: <IconSparkles size={I} /> },
      ],
    },
    {
      id: "plateformes",
      title: t`Plateformes`,
      entries: [
        { to: "/reglages/plateformes", label: t`Beds24 et canaux`, icon: <IconPlugConnected size={I} />, exact: true },
        { to: "/reglages/calendriers", label: t`Calendriers iCal`, icon: <IconCalendarShare size={I} /> },
        { to: "/avis", label: t`Avis`, icon: <IconStar size={I} /> },
      ],
    },
    {
      id: "reglages",
      title: t`Réglages`,
      entries: [
        { to: "/reglages/domaine", label: t`Domaine`, icon: <IconHome2 size={I} /> },
        { to: "/reglages/comptes", label: t`Comptes`, icon: <IconKey size={I} /> },
        { to: "/reglages/modeles", label: t`Modèles`, icon: <IconTemplate size={I} /> },
        { to: "/reglages/mon-compte", label: t`Mon compte`, icon: <IconUserCircle size={I} /> },
        { to: "/reglages/appareil", label: t`Cet appareil`, icon: <IconDeviceDesktop size={I} /> },
        { to: "/reglages/mise-en-route", label: t`Mise en route`, icon: <IconListCheck size={I} /> },
        { to: "/reglages/journaux", label: t`Journaux`, icon: <IconBook2 size={I} /> },
        { to: "/reglages/ameliorations", label: t`Améliorations`, icon: <IconMessageDots size={I} />, badge: "improvements" },
        { to: "/reglages/aide", label: t`Aide`, icon: <IconHelpCircle size={I} /> },
        { to: "/reglages", label: t`Tous les réglages`, icon: <IconAdjustmentsHorizontal size={I} />, exact: true },
      ],
    },
  ];
}

/** La section de la barre latérale qui contient une adresse (pour le fil d'Ariane). */
export function sectionOf(nav: NavSection[], path: string): { section: NavSection; entry: NavEntry } | null {
  let best: { section: NavSection; entry: NavEntry } | null = null;
  for (const section of nav)
    for (const entry of section.entries) {
      const hit = entry.to === path || (!entry.exact && entry.to !== "/" && path.startsWith(`${entry.to}/`));
      if (hit && (!best || entry.to.length > best.entry.to.length)) best = { section, entry };
    }
  return best;
}
