// Réservations : recherche (nom, mail, référence), périodes, ouverture de la fiche.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconPlus, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { api } from "../api/client";
import type { Booking } from "../api/types";
import { bookingState } from "../booking/BookingPanel";
import { ErrorLine } from "../lib/action";
import { stayPhase, type StayPhase } from "../../../src/core/stay-phase";
import { shortDate, stayRange, todayBrussels } from "../lib/dates";
import { channelName } from "../lib/derive";
import { eur } from "../lib/money";
import { useScope } from "../lib/scope";
import { useSale } from "../sale/SaleFlow";
import { useOpenBooking } from "../shell/Shell";
import { DownloadButton } from "../ui/kit";

type Period = "upcoming" | "current" | "past" | "";
type SortKey = "name" | "checkin" | "submitted" | "amount";
type Sort = { k: SortKey; dir: 1 | -1 } | null;

function sortRows(list: Booking[], sort: Sort): Booking[] {
  if (!sort) return list;
  const key = (b: Booking): string | number => (sort.k === "name" ? (b.guestName || "").toLocaleLowerCase("fr") : sort.k === "checkin" ? b.checkin : sort.k === "submitted" ? b.createdAt : b.totalCents);
  return [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "fr")) * sort.dir;
  });
}

/** En-tête triable : un clic trie, un second inverse ; aria-sort dit l'état. */
function SortTh({ k, sort, onSort, right, className, children }: { k: SortKey; sort: Sort; onSort: (s: Sort) => void; right?: boolean; className?: string; children: ReactNode }) {
  const on = sort?.k === k;
  return (
    <th scope="col" className={[right ? "r" : null, className].filter(Boolean).join(" ") || undefined} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="th-sort" onClick={() => onSort(on && sort.dir === 1 ? { k, dir: -1 } : { k, dir: 1 })}>
        {children}
        {on ? sort.dir === 1 ? <IconArrowUp size={16} aria-hidden /> : <IconArrowDown size={16} aria-hidden /> : <IconArrowsSort size={16} aria-hidden className="muted" />}
      </button>
    </th>
  );
}

export function BookingsPage() {
  const { t } = useLingui();
  const { scope } = useScope();
  const openBooking = useOpenBooking();
  const sell = useSale();
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<Period>("upcoming");
  const [status, setStatus] = useState<string>("");
  const [q] = useDebouncedValue(search.trim(), 250);
  const list = useQuery({
    queryKey: ["bookings", scope, period, q, status],
    queryFn: () =>
      api<{ bookings: Booking[] }>("/bookings", { query: { property: scope === "all" ? undefined : scope, period: q ? undefined : period || undefined, search: q || undefined, status: status || undefined, limit: 300 } }).then((r) => r.bookings),
  });
  const PERIODS: { id: Period; label: string }[] = [
    { id: "upcoming", label: t`À venir` },
    { id: "current", label: t`En cours` },
    { id: "past", label: t`Passées` },
    { id: "", label: t`Toutes` },
  ];
  const [sort, setSort] = useState<Sort>(null);
  const rows = sortRows(list.data ?? [], sort);
  const nightsLabel = (a: string, b: string) => {
    const n = Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    return n > 1 ? t`${n} nuits` : t`1 nuit`;
  };
  const today = todayBrussels();
  const PHASES: Record<StayPhase, string> = { "arrive-today": t`arrive aujourd'hui`, "arrive-tomorrow": t`arrive demain`, "leaves-today": t`part aujourd'hui` };
  const phaseOf = (b: Booking) => {
    const p = stayPhase(b, today);
    return p ? PHASES[p] : null;
  };
  const sourceLabel = (b: Booking) =>
    b.source === "direct" ? t`site` : b.source === "manual" ? t`téléphone` : b.source === "import" ? t`import elloha` : b.channelLabel?.trim() || t`iCal`;
  const pill: Record<string, string> = { option: t`Option`, solde: t`Solde à encaisser`, soldee: t`Payée`, plat: t`Autre site`, annulee: t`Annulée` };
  return (
    <div className="pg">
      <div className="head">
        <h1 className="title">
          <Trans>Réservations</Trans>
        </h1>
        <div className="tools">
          <button type="button" className="btn pri" onClick={() => sell()}>
            <IconPlus size={18} />
            {t`Nouvelle vente`}
          </button>
          <DownloadButton path="/bookings.csv" query={{ property: scope === "all" ? undefined : scope }} filename="reservations.csv">
            {t`Exporter`}
          </DownloadButton>
          <Link className="btn" to="/reglages/import">
            {t`Importer depuis elloha`}
          </Link>
        </div>
      </div>
      <div className="filters">
        <TextInput
          className="search"
          size="md"
          leftSection={<IconSearch size={20} />}
          placeholder={t`Nom, mail, téléphone ou référence`}
          aria-label={t`Rechercher une réservation`}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          size="md"
          w={210}
          aria-label={t`État des réservations`}
          allowDeselect={false}
          value={status}
          onChange={(v) => setStatus(v ?? "")}
          data={[
            { value: "", label: t`Tous les états` },
            { value: "confirmed", label: t`Confirmées` },
            { value: "pending", label: t`Options en cours` },
            { value: "cancelled", label: t`Annulées` },
          ]}
        />
        <div className="chips" role="group" aria-label={t`Période`}>
          {PERIODS.map((p) => (
            <button key={p.id || "all"} type="button" className="chip" aria-pressed={!q && period === p.id} disabled={!!q} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {list.error ? <ErrorLine text={t`La liste n'a pas pu être lue. Réessayez.`} /> : null}
      {list.isLoading ? <p className="loading">{t`Chargement…`}</p> : null}
      {list.data && rows.length === 0 ? (
        <div className="empty">
          <h3>{q ? t`Aucune réservation ne correspond à « ${q} »` : t`Aucune réservation sur cette période`}</h3>
          <p>{q ? t`Essayez le nom de famille seul, ou la référence (par exemple PM-2026-012).` : t`Choisissez une autre période, ou faites une nouvelle vente depuis le calendrier.`}</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl dense bk mcards">
            <caption className="sr">{t`Réservations, ${rows.length} lignes. Les en-têtes Client, Séjour, Soumise le et Total trient la liste.`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Réf.`}</th>
                <SortTh k="name" sort={sort} onSort={setSort}>{t`Client`}</SortTh>
                <th scope="col" className="hide-s">{t`Bien`}</th>
                <SortTh k="checkin" sort={sort} onSort={setSort}>{t`Séjour`}</SortTh>
                <SortTh k="submitted" sort={sort} onSort={setSort} className="hide-s">{t`Soumise le`}</SortTh>
                <SortTh k="amount" sort={sort} onSort={setSort} right>{t`Total`}</SortTh>
                <th scope="col" className="r hide-s">{t`Payé`}</th>
                <th scope="col" className="hide-s">{t`État`}</th>
                <th scope="col" className="hide-s">{t`Source`}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const st = bookingState(b);
                const balance = b.totalCents - b.paidCents;
                return (
                  <tr key={b.id} onClick={() => openBooking(b.id)}>
                    <td className="ref">{b.reference}</td>
                    <td className="mc-t">
                      <button type="button" className="cell-link" onClick={(e) => (e.stopPropagation(), openBooking(b.id))}>
                        {b.guestName || channelName(b)}
                      </button>
                      <small className="show-s-inline">{b.unitName}</small>
                    </td>
                    <td className="hide-s mc-off">{b.unitName}</td>
                    <td>
                      {stayRange(b.checkin, b.checkout)}
                      <small>
                        {nightsLabel(b.checkin, b.checkout)}
                        {phaseOf(b) ? <span className="phase"> · {phaseOf(b)}</span> : null}
                      </small>
                    </td>
                    <td className="r mc-r">
                      <b className="amt">{st === "plat" && !b.totalCents ? "—" : eur(b.totalCents)}</b>
                      {st === "solde" ? <small>{t`reste ${eur(balance)}`}</small> : null}
                    </td>
                    <td className="r hide-s mc-off">{b.paidCents ? eur(b.paidCents) : "—"}</td>
                    <td className="hide-s muted">
                      {shortDate(b.createdAt.slice(0, 10))}
                      <small className="show-s-inline">{sourceLabel(b)}</small>
                    </td>
                    <td className="hide-s">
                      <span className={`pill ${st}`}>{pill[st]}</span>
                    </td>
                    <td className="hide-s muted mc-off">{sourceLabel(b)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
