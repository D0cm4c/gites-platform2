// Clients : la liste (recherche par nom ou mail), la fiche en panneau latéral
// avec coordonnées modifiables et séjours. Un séjour ouvre la fiche de la
// réservation.
import { Trans, useLingui } from "@lingui/react/macro";
import { Textarea, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconMail, IconPhone, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import type { Booking } from "../../api/types";
import type { GuestRow } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { stayRange } from "../../lib/dates";
import { eur } from "../../lib/money";
import { useOpenBooking } from "../../shell/Shell";
import { Empty, Fold, Loading, Page, SidePanel } from "../../ui/kit";

function fullName(g: Pick<GuestRow, "firstName" | "lastName">): string {
  return [g.firstName, g.lastName].filter(Boolean).join(" ");
}

export function ClientsPage() {
  const { t } = useLingui();
  const [search, setSearch] = useState("");
  const [q] = useDebouncedValue(search.trim(), 250);
  const list = useQuery({ queryKey: ["guests", q], queryFn: () => api<{ guests: GuestRow[] }>("/guests", { query: { search: q || undefined } }).then((r) => r.guests) });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Page title={t`Clients`} back lead={t`Tous les clients des deux domaines. La recherche lit le nom et le mail.`}>
      <div className="filters">
        <TextInput className="search" size="md" leftSection={<IconSearch size={20} />} placeholder={t`Nom, mail ou téléphone`} aria-label={t`Rechercher un client`} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
      </div>
      {list.error ? <ErrorLine text={t`La liste n'a pas pu être lue.`} /> : null}
      {list.isLoading ? <Loading /> : null}
      {list.data && list.data.length === 0 ? <Empty title={q ? t`Aucun client ne correspond à « ${q} »` : t`Aucun client pour l'instant`} /> : null}
      {list.data && list.data.length ? (
        <div className="tbl-wrap">
          <table className="tbl dense rows-link mcards">
            <caption className="sr">{t`Clients`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Nom`}</th>
                <th scope="col" className="hide-s">{t`Mail`}</th>
                <th scope="col" className="hide-s">{t`Téléphone`}</th>
                <th scope="col" className="r">{t`Séjours`}</th>
                <th scope="col" className="r">{t`Total des séjours`}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((g) => (
                <tr key={g.id} onClick={() => setOpen(g.id)}>
                  <td className="mc-t">
                    <button type="button" className="cell-link" onClick={(e) => (e.stopPropagation(), setOpen(g.id))}>
                      {fullName(g) || t`Client sans nom`}
                    </button>
                    <small className="show-s-inline">{[g.email, g.phone].filter(Boolean).join(", ")}</small>
                  </td>
                  <td className="hide-s mc-off">{g.email || "—"}</td>
                  <td className="hide-s nowrap mc-off">{g.phone || "—"}</td>
                  <td className="r mc-off">{g.bookingsCount ?? 0}</td>
                  <td className="r amt mc-r">{eur(g.totalSpentCents ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open != null ? <ClientPanel id={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

export function ClientPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["guest-full", id], queryFn: () => api<{ guest: GuestRow; bookings: Booking[] }>(`/guests/${id}`) });
  return q.data ? (
    <ClientForm key={q.data.guest.id} guest={q.data.guest} bookings={q.data.bookings} onClose={onClose} />
  ) : (
    <SidePanel opened onClose={onClose} label={t`Fiche client`} title={q.error ? t`Fiche illisible` : t`Chargement…`}>
      {q.error ? <ErrorLine text={t`La fiche n'a pas pu être lue. Fermez-la et réessayez.`} /> : <Loading />}
    </SidePanel>
  );
}

function ClientForm({ guest: g, bookings, onClose }: { guest: GuestRow; bookings: Booking[]; onClose: () => void }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const init = useMemo(() => ({ firstName: g.firstName ?? "", lastName: g.lastName, email: g.email ?? "", phone: g.phone ?? "", address: g.address ?? "", country: g.country ?? "", notes: g.notes ?? "" }), [g]);
  const [v, setV] = useState(init);
  const a = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const field = (k: keyof typeof v, label: string, type = "text") => <TextInput size="md" type={type} label={label} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.currentTarget.value })} />;
  const status = (b: Booking) => (b.status === "cancelled" ? t`annulée` : b.status === "pending" ? t`option` : t`confirmée`);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Fiche client`}
      top={t`Client`}
      title={fullName(g) || t`Client sans nom`}
      dirty={dirty}
      actions={
        <>
          <div className="contact">
            {g.phone ? (
              <a className="btn" href={`tel:${g.phone.replace(/[^\d+]/g, "")}`}>
                <IconPhone size={22} />
                {g.phone}
              </a>
            ) : null}
            {g.email ? (
              <a className="btn" href={`mailto:${g.email}`}>
                <IconMail size={22} />
                <Trans>Écrire un mail</Trans>
              </a>
            ) : null}
          </div>
          <button
            type="button"
            className="btn pri wide"
            disabled={!dirty || v.lastName.trim().length < 1 || a.state.status === "busy"}
            onClick={() => void a.run(() => api(`/guests/${g.id}`, { method: "PATCH", body: v }), t`C'est fait. Fiche client enregistrée.`)}
          >
            {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
          </button>
        </>
      }
    >
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <h3 className="sub3">{t`Séjours (${bookings.length})`}</h3>
      {bookings.length === 0 ? <p className="muted">{t`Aucune réservation.`}</p> : null}
      <div className="panel" style={{ marginBottom: 16 }}>
        {bookings.map((b) => (
          <button
            key={b.id}
            type="button"
           
            className="list-row two"
            onClick={() => {
              onClose();
              openBooking(b.id);
            }}
          >
            <span>
              <b>{b.unitName}</b>
              <small>
                {stayRange(b.checkin, b.checkout)}, {status(b)}
              </small>
            </span>
            <span style={{ textAlign: "right" }}>
              <b className="num">{eur(b.totalCents)}</b>
              <small>{b.reference}</small>
            </span>
          </button>
        ))}
      </div>
      <Fold title={t`Coordonnées`} open>
        <div className="grid2">
          {field("firstName", t`Prénom`)}
          {field("lastName", t`Nom`)}
          {field("email", t`Mail`, "email")}
          {field("phone", t`Téléphone`, "tel")}
          {field("address", t`Adresse`)}
          {field("country", t`Pays`)}
        </div>
      </Fold>
      <Fold title={t`Note`} count={v.notes ? "1" : "0"}>
        <Textarea size="md" label={t`Note (le client ne la voit pas)`} autosize minRows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
      </Fold>
    </SidePanel>
  );
}
