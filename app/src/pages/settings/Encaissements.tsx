// Réglages › Encaissements Stripe : ce qui est arrivé sur le compte Stripe de la
// propriété (via le webhook), avec frais et net quand Stripe les a donnés, le total
// par mois et l'export CSV pour la comptabilité.
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { EncaissementsReport } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { eur } from "../../lib/money";
import { DownloadButton, Empty, Loading, Page, sqlWhen, useWorkingProperty } from "../../ui/kit";

export function EncaissementsPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const q = useQuery({
    queryKey: ["encaissements", pid],
    enabled: pid != null,
    queryFn: () => api<{ report: EncaissementsReport }>("/encaissements", { query: { property: pid } }).then((r) => r.report),
  });
  const backfill = useAction();
  const kind = (k: string) => ({ deposit: t`Arrhes`, balance: t`Solde`, full: t`Séjour entier`, refund: t`Remboursement`, manual: t`Paiement noté à la main` })[k] ?? k;
  const r = q.data;
  const unknown = r?.totals.unknownFees ?? 0;
  const unknownText = t`inconnus`;
  return (
    <Page
      title={t`Encaissements Stripe`}
      back
      tools={picker}
      lead={r ? t`${eur(r.totals.grossCents)} encaissés, ${eur(r.totals.feeCents)} de frais, ${eur(r.totals.netCents)} nets (${r.totals.count} paiements).` : undefined}
    >
      {q.error ? <ErrorLine text={t`Les encaissements n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {pid != null ? (
        <div className="acts">
          <DownloadButton path="/encaissements.csv" query={{ property: pid }} filename={`encaissements-${property?.slug ?? pid}.csv`}>
            {t`Exporter en CSV`}
          </DownloadButton>
          {unknown > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={backfill.state.status === "busy"}
              onClick={() => void backfill.run(() => api(`/encaissements/frais`, { method: "POST", query: { property: pid } }), (x) => t`C'est fait. ${(x as { updated: number }).updated} frais relevés chez Stripe.`)}
            >
              {t`Relever les frais manquants (${unknown})`}
            </button>
          ) : null}
        </div>
      ) : null}
      {r && r.rows.length === 0 ? <Empty title={t`Aucun encaissement Stripe pour cette propriété`} /> : null}
      {r && r.months.length ? (
        <div className="tbl-wrap">
          <table className="tbl dense">
            <caption>{t`Total par mois`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Mois`}</th>
                <th scope="col" className="r">{t`Paiements`}</th>
                <th scope="col" className="r">{t`Brut`}</th>
                <th scope="col" className="r">{t`Frais Stripe`}</th>
                <th scope="col" className="r">{t`Net`}</th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td className="r">{m.count}</td>
                  <td className="r amt">{eur(m.grossCents)}</td>
                  <td className="r amt">{m.unknownFees === m.count ? unknownText : eur(m.feeCents)}</td>
                  <td className="r amt">{m.unknownFees === m.count ? unknownText : eur(m.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {r && r.rows.length ? (
        <div className="tbl-wrap">
          <table className="tbl dense">
            <caption>{t`Encaissements`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Date`}</th>
                <th scope="col">{t`Réservation`}</th>
                <th scope="col">{t`Type`}</th>
                <th scope="col" className="r">{t`Brut`}</th>
                <th scope="col" className="r hide-s">{t`Frais`}</th>
                <th scope="col" className="r hide-s">{t`Net`}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.paymentId}>
                  <td className="nowrap">{sqlWhen(x.receivedAt)}</td>
                  <td className="ref">{x.bookingReference}</td>
                  <td>{kind(x.kind)}</td>
                  <td className="r amt">{eur(x.amountCents)}</td>
                  <td className="r amt hide-s">{x.feeCents === null ? unknownText : eur(x.feeCents)}</td>
                  <td className="r amt hide-s">{x.netCents === null ? unknownText : eur(x.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
