// Paiements : tout ce qui a été encaissé ou attendu, du plus récent au plus
// ancien. Une ligne ouvre le détail en panneau latéral, d'où l'on passe à la
// réservation.
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { PaymentRow } from "../../api/types2";
import { ErrorLine } from "../../lib/action";
import { eur } from "../../lib/money";
import { useScope } from "../../lib/scope";
import { useOpenBooking } from "../../shell/Shell";
import { Empty, Loading, Page, SidePanel, sqlWhen } from "../../ui/kit";

type Filter = "all" | "ok" | "wait" | "ko";

export function usePaymentWords() {
  const { t } = useLingui();
  const kind = (k: string) => ({ deposit: t`Arrhes`, balance: t`Solde`, full: t`Séjour entier`, refund: t`Remboursement`, manual: t`Paiement noté à la main` })[k] ?? k;
  const method = (m: string) => ({ stripe: t`carte bancaire`, transfer: t`virement`, cash: t`espèces`, other: t`autre moyen` })[m] ?? m;
  const status = (p: PaymentRow) =>
    p.status === "succeeded" ? t`reçu` : p.status === "pending" ? t`en attente` : p.outcome === "expired" ? t`lien expiré sans paiement` : p.outcome === "superseded" ? t`lien remplacé par un autre` : t`n'a pas abouti`;
  const tone = (p: PaymentRow) => (p.status === "succeeded" ? "soldee" : p.status === "pending" ? "option" : p.outcome ? "muted-pill" : "annulee");
  return { kind, method, status, tone };
}

export function PaymentsPage() {
  const { t } = useLingui();
  const { scope } = useScope();
  const q = useQuery({ queryKey: ["payments", scope], queryFn: () => api<{ payments: PaymentRow[] }>("/payments", { query: { property: scope === "all" ? undefined : scope } }).then((r) => r.payments) });
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<PaymentRow | null>(null);
  const w = usePaymentWords();
  const rows = (q.data ?? []).filter((p) => filter === "all" || (filter === "ok" ? p.status === "succeeded" : filter === "wait" ? p.status === "pending" : p.status !== "succeeded" && p.status !== "pending"));
  const received = (q.data ?? []).filter((p) => p.status === "succeeded").reduce((s, p) => s + (p.kind === "refund" ? -p.amountCents : p.amountCents), 0);
  const F: { id: Filter; label: string }[] = [
    { id: "all", label: t`Tous` },
    { id: "ok", label: t`Reçus` },
    { id: "wait", label: t`En attente` },
    { id: "ko", label: t`Sans suite` },
  ];
  return (
    <Page title={t`Paiements reçus`} back lead={q.data ? t`${eur(received)} reçus au total sur les ${q.data.length} derniers paiements affichés.` : undefined}>
      <div className="filters">
        <div className="chips" role="group" aria-label={t`Filtrer les paiements`}>
          {F.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {q.error ? <ErrorLine text={t`Les paiements n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data && rows.length === 0 ? <Empty title={t`Aucun paiement ici`} /> : null}
      {rows.length ? (
        <div className="tbl-wrap">
          <table className="tbl dense rows-link mcards">
            <caption className="sr">{t`Paiements`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Date`}</th>
                <th scope="col">{t`Réservation`}</th>
                <th scope="col">{t`Type`}</th>
                <th scope="col" className="hide-s">{t`Moyen`}</th>
                <th scope="col" className="r">{t`Montant`}</th>
                <th scope="col" className="hide-s">{t`État`}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => setOpen(p)}>
                  <td className="nowrap mc-t">
                    <button type="button" className="cell-link" onClick={(e) => (e.stopPropagation(), setOpen(p))}>
                      {sqlWhen(p.receivedAt ?? p.createdAt)}
                    </button>
                  </td>
                  <td className="ref" data-l={t`Réservation`}>{p.bookingReference}</td>
                  <td>{w.kind(p.kind)}</td>
                  <td className="hide-s" data-l={t`Moyen`}>{w.method(p.method)}</td>
                  <td className="r amt mc-r">{p.kind === "refund" ? `− ${eur(p.amountCents)}` : eur(p.amountCents)}</td>
                  <td className="hide-s">
                    <span className={`pill ${w.tone(p)}`}>{w.status(p)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <PaymentPanel p={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function PaymentPanel({ p, onClose }: { p: PaymentRow; onClose: () => void }) {
  const { t } = useLingui();
  const w = usePaymentWords();
  const openBooking = useOpenBooking();
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Paiement`}
      top={w.kind(p.kind)}
      title={p.kind === "refund" ? `− ${eur(p.amountCents)}` : eur(p.amountCents)}
      pill={<span className={`pill ${w.tone(p)}`}>{w.status(p)}</span>}
      actions={
        <button
          type="button"
          className="btn pri wide"
          onClick={() => {
            onClose();
            openBooking(p.bookingId);
          }}
        >
          {t`Ouvrir la réservation ${p.bookingReference ?? ""}`}
        </button>
      }
    >
      <dl className="facts">
        <div>
          <dt>{t`Moyen`}</dt>
          <dd>{w.method(p.method)}</dd>
        </div>
        <div>
          <dt>{t`Réservation`}</dt>
          <dd>{p.bookingReference}</dd>
        </div>
        <div>
          <dt>{t`Créé le`}</dt>
          <dd>{sqlWhen(p.createdAt)}</dd>
        </div>
        <div>
          <dt>{t`Reçu le`}</dt>
          <dd>{p.receivedAt ? sqlWhen(p.receivedAt) : t`pas encore`}</dd>
        </div>
      </dl>
      {p.note && !p.outcome ? <p className="note">{t`Note : ${p.note}`}</p> : null}
    </SidePanel>
  );
}
