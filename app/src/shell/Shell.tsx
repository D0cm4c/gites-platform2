// La coque de l'écran. À l'ordinateur (≥ 1024 px, disposition A) : une barre
// latérale fixe de 240 px, repliable en icônes (56 px, choix retenu sur
// l'appareil, Ctrl/⌘ B), avec le domaine en haut et la personne connectée en
// bas. Au téléphone (B) : la barre d'onglets du bas, dont « Plus » ouvre tout
// le menu en feuille. Retour de Julien du 10/10 : « On veut une barre latérale ».
import { Trans, useLingui } from "@lingui/react/macro";
import { AppShell, Drawer, Menu, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconBrush, IconCalendar, IconCheck, IconDots, IconHome2, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLogout, IconMessage, IconSelector, IconSun } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { api, currentUser, logout } from "../api/client";
import { useMessages, useProperties, useTasks } from "../api/hooks";
import { BookingPanel } from "../booking/BookingPanel";
import { addDays, todayBrussels } from "../lib/dates";
import { useScope, type Scope } from "../lib/scope";
import { useLayout } from "../lib/useLayout";
import { Confirm, hasUnsaved } from "../ui/kit";
import { SaleProvider } from "../sale/SaleFlow";
import { SuggestionButton } from "../improvements/SuggestionButton";
import type { ImprovementList } from "../improvements/types";
import { useNav, type NavEntry } from "./nav";

const FOLD_KEY = "gp2_nav_replie";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

function DomainSelector({ variant }: { variant: "side" | "top" | "icon" }) {
  const { t } = useLingui();
  const { scope, setScope: applyScope } = useScope();
  const [pending, setPending] = useState<Scope | null>(null);
  // Une saisie en cours dépend du domaine affiché : on demande avant d'en changer.
  const setScope = (s: Scope) => (s !== scope && hasUnsaved() ? setPending(s) : applyScope(s));
  const { data: properties = [] } = useProperties();
  const current = scope === "all" ? null : properties.find((p) => p.id === scope);
  const label = current ? current.name : t`Tous mes gîtes`;
  const detail = current ? (current.commune ?? "") : properties.map((p) => p.name.replace(/^(Les Gîtes du |Le )/, "")).join(t` et `);
  return (
    <Menu position={variant === "icon" ? "right-start" : "bottom-start"} shadow="md" width={280}>
      {variant === "icon" ? (
        <Tooltip label={label} position="right" withArrow events={{ hover: true, focus: true, touch: false }}>
          <Menu.Target>
            <button className="dom-icon" type="button" aria-label={t`Choisir le domaine affiché, actuellement : ${label}`}>
              <IconHome2 size={20} aria-hidden />
            </button>
          </Menu.Target>
        </Tooltip>
      ) : (
        <Menu.Target>
          <button className={`dom dom-${variant}`} type="button" aria-label={t`Choisir le domaine affiché, actuellement : ${label}`}>
            <span className="dom-txt">
              <b>{label}</b>
              {detail ? <small>{detail}</small> : null}
            </span>
            <IconSelector size={18} className="dom-chev" aria-hidden />
          </button>
        </Menu.Target>
      )}
      <Menu.Dropdown>
        <Menu.Item onClick={() => setScope("all")} rightSection={scope === "all" ? <IconCheck size={18} /> : null} style={{ minHeight: 44 }}>
          <Trans>Tous mes gîtes</Trans>
        </Menu.Item>
        {properties.map((p) => (
          <Menu.Item key={p.id} onClick={() => setScope(p.id)} rightSection={scope === p.id ? <IconCheck size={18} /> : null} style={{ minHeight: 44 }}>
            {p.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
      <Confirm
        open={pending != null}
        title={t`Changer de domaine sans enregistrer ?`}
        text={t`Des modifications de cette page ne sont pas enregistrées. En changeant de domaine, elles seront perdues.`}
        yes={t`Changer sans enregistrer`}
        no={t`Rester sur ce domaine`}
        danger
        onYes={() => {
          if (pending != null) applyScope(pending);
          setPending(null);
        }}
        onNo={() => setPending(null)}
      />
    </Menu>
  );
}

/** Compteurs des entrées : messages non lus, ménages du jour pas encore faits. */
type BadgeKind = "unread" | "cleaning" | "improvements";
function useCounts(): Record<BadgeKind, number> {
  const today = todayBrussels();
  const unread = useMessages("nouveau").data?.length ?? 0;
  const tasks = useTasks(today, addDays(today, 1)).data ?? [];
  const cleaning = tasks.filter((x) => x.dueDate === today && x.status !== "fait" && x.status !== "annule").length;
  // Remarques d'amélioration encore « nouveau » (l'entrée Réglages › Améliorations).
  const improvements = useQuery({ queryKey: ["improvements", "nouveau"], queryFn: () => api<ImprovementList>("/improvements", { query: { status: "nouveau" } }) }).data?.counts.nouveau ?? 0;
  return { unread, cleaning, improvements };
}

function Badge({ n, kind }: { n: number; kind: BadgeKind }) {
  const { t } = useLingui();
  if (!n) return null;
  return (
    <span className={`badge b-${kind}`}>
      <span aria-hidden>{n}</span>
      <span className="sr">{kind === "unread"
          ? n > 1 ? t`, ${n} non lus` : t`, 1 non lu`
          : kind === "improvements"
            ? n > 1 ? t`, ${n} nouvelles` : t`, 1 nouvelle`
            : n > 1 ? t`, ${n} aujourd'hui` : t`, 1 aujourd'hui`}</span>
    </span>
  );
}

function SideLink({ e, folded, count, onClick }: { e: NavEntry; folded: boolean; count: number; onClick?: () => void }) {
  const link = (
    <Link
      to={e.to}
      className="nl"
      activeOptions={{ exact: e.exact ?? false, includeSearch: false }}
      activeProps={{ "aria-current": "page" }}
      search={(s: object) => s}
      onClick={onClick}
    >
      {e.icon}
      <span className={folded ? "sr" : "nl-t"}>{e.label}</span>
      {e.badge ? <Badge n={count} kind={e.badge} /> : null}
    </Link>
  );
  return folded ? (
    <Tooltip label={e.label} position="right" withArrow openDelay={150} events={{ hover: true, focus: true, touch: false }}>
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await logout();
    qc.clear();
    await navigate({ to: "/connexion" });
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function Sidebar({ folded, toggle }: { folded: boolean; toggle: () => void }) {
  const { t } = useLingui();
  const nav = useNav();
  const counts = useCounts();
  const signOut = useLogout();
  const user = currentUser() ?? "?";
  const keys = isMac ? "⌘ B" : "Ctrl B";
  return (
    <>
      <div className="side-top">
        <DomainSelector variant={folded ? "icon" : "side"} />
      </div>
      <nav className="side-nav" aria-label={t`Menu principal`}>
        {nav.map((s) => (
          <div key={s.id} className="side-sec" role="group" aria-labelledby={`nav-${s.id}`}>
            <p className={folded ? "sr" : "side-h"} id={`nav-${s.id}`}>
              {s.title}
            </p>
            {s.entries.map((e) => (
              <SideLink key={e.to} e={e} folded={folded} count={e.badge ? counts[e.badge] : 0} />
            ))}
          </div>
        ))}
      </nav>
      <div className={`side-foot${folded ? " col" : ""}`}>
        {folded ? null : (
          <span className="avatar" aria-hidden>
            {initials(user)}
          </span>
        )}
        {folded ? null : (
          <span className="who-t">
            <b>{user}</b>
            <small>
              <Trans>Connecté</Trans>
            </small>
          </span>
        )}
        <Tooltip label={t`Se déconnecter`} position="right" withArrow events={{ hover: true, focus: true, touch: false }}>
          <button type="button" className="side-btn icon" onClick={() => void signOut()} aria-label={t`Se déconnecter`}>
            <IconLogout size={18} />
          </button>
        </Tooltip>
        <Tooltip label={folded ? t`Déplier le menu (${keys})` : t`Replier le menu (${keys})`} position="right" withArrow events={{ hover: true, focus: true, touch: false }}>
          <button
            type="button"
            className="side-btn icon"
            onClick={toggle}
            aria-expanded={!folded}
            aria-label={folded ? t`Déplier le menu` : t`Replier le menu`}
            aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"}
          >
            {folded ? <IconLayoutSidebarLeftExpand size={18} /> : <IconLayoutSidebarLeftCollapse size={18} />}
          </button>
        </Tooltip>
      </div>
    </>
  );
}

function TabLink({ to, icon, children, badge, exact }: { to: string; icon: ReactNode; children: ReactNode; badge?: ReactNode; exact?: boolean }) {
  return (
    <Link to={to} activeOptions={{ exact: exact ?? false, includeSearch: false }} activeProps={{ "aria-current": "page" }} search={(s: object) => s}>
      {icon}
      {children}
      {badge}
    </Link>
  );
}

/** Au téléphone : quatre onglets et « Plus », qui ouvre tout le menu en feuille. */
function TabBar() {
  const { t } = useLingui();
  const counts = useCounts();
  const nav = useNav();
  const signOut = useLogout();
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);
  const inTabs = ["/", "/calendrier", "/messages", "/menage"];
  const elsewhere = !inTabs.some((p) => (p === "/" ? path === "/" : path.startsWith(p)));
  return (
    <>
      <nav className="tabbar" aria-label={t`Menu principal`}>
        <TabLink to="/" icon={<IconSun size={22} />} exact>
          <Trans>Aujourd'hui</Trans>
        </TabLink>
        <TabLink to="/calendrier" icon={<IconCalendar size={22} />}>
          <Trans>Calendrier</Trans>
        </TabLink>
        <TabLink to="/messages" icon={<IconMessage size={22} />} badge={<Badge n={counts.unread} kind="unread" />}>
          <Trans>Messages</Trans>
        </TabLink>
        <TabLink to="/menage" icon={<IconBrush size={22} />} badge={<Badge n={counts.cleaning} kind="cleaning" />}>
          <Trans>Ménage</Trans>
        </TabLink>
        <button type="button" className="tab-more" aria-haspopup="dialog" aria-expanded={open} aria-current={elsewhere ? "page" : undefined} onClick={() => setOpen(true)}>
          <IconDots size={22} />
          <Trans>Plus</Trans>
        </button>
      </nav>
      <Drawer opened={open} onClose={() => setOpen(false)} position="bottom" size="88%" title={<b style={{ fontSize: 20 }}>{t`Tout le menu`}</b>} closeButtonProps={{ "aria-label": t`Fermer`, size: "lg" }} classNames={{ content: "sheet-all" }}>
        <nav aria-label={t`Tout le menu`}>
          {nav.map((s) => (
            <section key={s.id} className="all-sec" aria-labelledby={`all-${s.id}`}>
              <h2 id={`all-${s.id}`}>{s.title}</h2>
              {s.entries.map((e) => (
                <Link key={e.to} to={e.to} className="nl" activeOptions={{ exact: e.exact ?? false, includeSearch: false }} activeProps={{ "aria-current": "page" }} onClick={() => setOpen(false)}>
                  {e.icon}
                  <span className="nl-t">{e.label}</span>
                  {e.badge ? <Badge n={counts[e.badge]} kind={e.badge} /> : null}
                </Link>
              ))}
            </section>
          ))}
        </nav>
        <button type="button" className="btn wide" style={{ marginTop: 16 }} onClick={() => void signOut()}>
          <IconLogout size={20} />
          {t`Se déconnecter (${currentUser() ?? "?"})`}
        </button>
      </Drawer>
    </>
  );
}

/** Le réseau est-il là ? (événements online/offline du navigateur) */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function Shell() {
  const online = useOnline();
  const layout = useLayout();
  const search = useSearch({ strict: false }) as { resa?: number };
  const navigate = useNavigate();
  const [folded, setFolded] = useState(readFolded);
  const toggle = () =>
    setFolded((f) => {
      try {
        localStorage.setItem(FOLD_KEY, f ? "0" : "1");
      } catch {
        /* stockage indisponible : le choix vaut pour la visite */
      }
      return !f;
    });
  useHotkeys([["mod+B", () => layout === "A" && toggle()]]);
  return (
    <SaleProvider>
      <AppShell navbar={{ width: folded ? 56 : 240, breakpoint: "64em", collapsed: { mobile: true } }} padding={0} withBorder={false} transitionDuration={0}>
        {layout === "A" ? (
          <AppShell.Navbar className={`side${folded ? " folded" : ""}`}>
            <Sidebar folded={folded} toggle={toggle} />
          </AppShell.Navbar>
        ) : null}
        <AppShell.Main className="page-main">
          {online ? null : (
            <div className="offline" role="status">
              <Trans>Hors ligne : vous voyez la dernière version gardée sur cet appareil. Rien ne peut être changé avant le retour du réseau.</Trans>
            </div>
          )}
          {layout === "B" ? (
            <header className="top">
              <DomainSelector variant="top" />
            </header>
          ) : null}
          <div className="page">
            <Outlet />
          </div>
        </AppShell.Main>
      </AppShell>
      {layout === "B" ? <TabBar /> : null}
      <SuggestionButton />
      <BookingPanel
        id={search.resa ?? null}
        onClose={() => void navigate({ to: ".", search: (s: object) => ({ ...s, resa: undefined }) })}
      />
    </SaleProvider>
  );
}

/** Ouvre la fiche d'une réservation sans quitter l'écran courant. */
export function useOpenBooking(): (id: number) => void {
  const navigate = useNavigate();
  return (id: number) => void navigate({ to: ".", search: (s: object) => ({ ...s, resa: id }) });
}
