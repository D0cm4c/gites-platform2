// Routes de l'écran d'administration. Historique en hash (/admin/#/calendrier) :
// le serveur n'a qu'un fichier à servir, /admin/index.html, sans réécriture
// d'URL. Les adresses de l'ancien écran (#/dash, #/cal, #/resa…) mènent au
// bon écran : liens gardés dans un favori, un mail, ou la carte Santé.
// La fiche ouverte vit dans l'adresse (?resa=12) : un lien la rouvre.
import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";

import type { ReactNode } from "react";

import { isLoggedIn } from "./api/client";
import { Shell } from "./shell/Shell";
import { LoginPage } from "./pages/Login";
import { TodayPage } from "./pages/Today";
import { CalendarPage } from "./pages/Calendar";
import { BookingsPage } from "./pages/Bookings";
import { MessagesPage } from "./pages/Messages";
import { CleaningPage } from "./pages/Cleaning";
import { SettingsPage } from "./pages/Settings";
import { AccountsPage } from "./pages/settings/Accounts";
import { ChannelsPage } from "./pages/settings/Channels";
import { ChannelPricesPage } from "./pages/settings/ChannelPrices";
import { HelpPage } from "./pages/settings/Help";
import { ClientsPage } from "./pages/settings/Clients";
import { DomainPage } from "./pages/settings/Domain";
import { IcalPage } from "./pages/settings/Ical";
import { ImportPage } from "./pages/settings/Import";
import { LogsPage } from "./pages/settings/Logs";
import { OptionsPage } from "./pages/settings/Options";
import { PaymentsPage } from "./pages/settings/Payments";
import { StripeAccountsPage } from "./pages/settings/StripeAccounts";
import { EncaissementsPage } from "./pages/settings/Encaissements";
import { PromotionsPage } from "./pages/settings/Promotions";
import { RegisterPage } from "./pages/settings/Register";
import { StartupPage } from "./pages/settings/Startup";
import { StatsPage } from "./pages/settings/Stats";
import { TarifsPage } from "./pages/settings/Tarifs";
import { TemplatesPage } from "./pages/settings/Templates";
import { MyAccountPage } from "./pages/settings/MyAccount";
import { DevicePage } from "./pages/settings/Device";
import { ReviewsPage } from "./pages/Reviews";
import { ImprovementsPage } from "./pages/settings/Improvements";

export interface RootSearch {
  resa?: number;
  /** message à ouvrir dans Messages */
  msg?: number;
}

const rootRoute = createRootRoute({
  component: Outlet,
  validateSearch: (s: Record<string, unknown>): RootSearch => {
    const out: RootSearch = {};
    const n = Number(s.resa);
    if (Number.isInteger(n) && n > 0) out.resa = n;
    const m = Number(s.msg);
    if (Number.isInteger(m) && m > 0) out.msg = m;
    return out;
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/connexion", component: LoginPage });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: Shell,
  beforeLoad: () => {
    if (!isLoggedIn()) throw redirect({ to: "/connexion" });
  },
});

const todayRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: TodayPage });
const calendarRoute = createRoute({ getParentRoute: () => appRoute, path: "/calendrier", component: CalendarPage });
const bookingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/reservations", component: BookingsPage });
const messagesRoute = createRoute({ getParentRoute: () => appRoute, path: "/messages", component: MessagesPage });
const cleaningRoute = createRoute({ getParentRoute: () => appRoute, path: "/menage", component: CleaningPage });
const reviewsRoute = createRoute({ getParentRoute: () => appRoute, path: "/avis", component: ReviewsPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/reglages", component: SettingsPage });
// Réglages du lot 1 : tout ce que l'ancien /admin/ savait faire.
const sub = (path: string, component: () => ReactNode) => createRoute({ getParentRoute: () => appRoute, path: `/reglages/${path}`, component });
const settingsRoutes = [
  sub("tarifs", TarifsPage),
  sub("promotions", PromotionsPage),
  sub("options", OptionsPage),
  sub("clients", ClientsPage),
  sub("paiements", PaymentsPage),
  sub("stripe", StripeAccountsPage),
  sub("encaissements", EncaissementsPage),
  sub("chiffres", StatsPage),
  sub("plateformes", ChannelsPage),
  sub("plateformes/prix", ChannelPricesPage),
  sub("calendriers", IcalPage),
  sub("comptes", AccountsPage),
  sub("domaine", DomainPage),
  sub("registre", RegisterPage),
  sub("import", ImportPage),
  sub("mise-en-route", StartupPage),
  sub("journaux", LogsPage),
  sub("modeles", TemplatesPage),
  sub("mon-compte", MyAccountPage),
  sub("ameliorations", ImprovementsPage),
  sub("aide", HelpPage),
  sub("appareil", DevicePage),
];

// Adresses de l'ancien écran (favoris, mails, carte Santé) : on mène au bon
// écran. La fiche ouverte (?resa=) et le reste de l'adresse sont gardés.
const LEGACY: Record<string, string> = {
  "/dash": "/",
  "/cal": "/calendrier",
  "/plan": "/calendrier",
  "/cal/prix": "/reglages/tarifs",
  "/tarifs": "/reglages/tarifs",
  "/cal/annee": "/reglages/tarifs",
  "/resa": "/reservations",
  "/clients": "/reglages/clients",
  "/paiements": "/reglages/paiements",
  "/stats": "/reglages/chiffres",
  "/promos": "/reglages/promotions",
  "/options": "/reglages/options",
  "/canaux": "/reglages/plateformes",
  "/ical": "/reglages/calendriers",
  "/users": "/reglages/comptes",
  "/params": "/reglages/domaine",
  "/startup": "/reglages/mise-en-route",
};
const legacyRoutes = Object.entries(LEGACY).map(([from, to]) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: from,
    beforeLoad: ({ search }) => {
      throw redirect({ to, search, replace: true });
    },
  }),
);

const routeTree = rootRoute.addChildren([
  loginRoute,
  ...legacyRoutes,
  appRoute.addChildren([todayRoute, calendarRoute, bookingsRoute, messagesRoute, cleaningRoute, reviewsRoute, settingsRoute, ...settingsRoutes]),
]);

export function makeRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false, scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof makeRouter>;
declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
