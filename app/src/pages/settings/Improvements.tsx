// Suivi des améliorations souhaitées par les testeurs (bouton « Amélioration ? »
// présent sur toutes les pages). Liste triable, filtre par statut, fiche en
// panneau latéral (statut, note interne, page d'origine), export CSV.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, Textarea } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import { ErrorLine, useAction } from "../../lib/action";
import { improvementsCsv } from "../../improvements/csv";
import { NOTE_MAX, type Improvement, type ImprovementList, type ImprovementStatus } from "../../improvements/types";
import { Empty, Loading, Page, SidePanel, sqlWhen } from "../../ui/kit";

export function useStatusLabel() {
  const { t } = useLingui();
  return (s: ImprovementStatus): string =>
    ({ nouveau: t`Nouveau`, en_cours: t`En cours`, fait: t`Fait`, ecarte: t`Écarté` })[s];
}

const STATUSES: ImprovementStatus[] = ["nouveau", "en_cours", "fait", "ecarte"];
type SortKey = "recent" | "ancien" | "page" | "auteur" | "statut";

function pill(s: ImprovementStatus): string {
  return s === "fait" ? "soldee" : s === "nouveau" ? "option" : s === "ecarte" ? "muted-pill" : "plat";
}

export function ImprovementsPage() {
  const { t } = useLingui();
  const label = useStatusLabel();
  const [filter, setFilter] = useState<ImprovementStatus | "tous">("tous");
  const [sort, setSort] = useState<SortKey>("recent");
  const [open, setOpen] = useState<Improvement | null>(null);
  const q = useQuery({ queryKey: ["improvements", filter], queryFn: () => api<ImprovementList>("/improvements", { query: { status: filter === "tous" ? undefined : filter } }) });
  const rows = useMemo(() => {
    const list = q.data?.improvements ?? [];
    const by: Record<SortKey, (a: Improvement, b: Improvement) => number> = {
      recent: (a, b) => b.id - a.id,
      ancien: (a, b) => a.id - b.id,
      page: (a, b) => a.pagePath.localeCompare(b.pagePath) || b.id - a.id,
      auteur: (a, b) => a.author.localeCompare(b.author) || b.id - a.id,
      statut: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.id - a.id,
    };
    return [...list].sort(by[sort]);
  }, [q.data, sort]);
  const counts = q.data?.counts;
  const total = counts ? STATUSES.reduce((n, s) => n + counts[s], 0) : 0;

  const exportCsv = () => {
    const header = [t`Numéro`, t`Date`, t`Auteur`, t`Page`, t`Adresse`, t`Statut`, t`Remarque`, t`Note interne`, t`Largeur d'écran`, t`Mise à jour`];
    const blob = new Blob([improvementsCsv(rows, header, label)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ameliorations.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <Page
      title={t`Améliorations`}
      back
      lead={t`Les remarques écrites avec le bouton « Amélioration ? », présent sur toutes les pages, avec la page où la personne se trouvait.`}
      tools={
        <button type="button" className="btn" onClick={exportCsv} disabled={rows.length === 0}>
          <IconDownload size={20} />
          <Trans>Exporter en CSV</Trans>
        </button>
      }
    >
      {q.error ? <ErrorLine text={t`Les remarques n'ont pas pu être lues.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
            <div role="group" aria-label={t`Filtrer par statut`} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" className="chip" aria-pressed={filter === "tous"} onClick={() => setFilter("tous")}>
                {t`Toutes (${total})`}
              </button>
              {STATUSES.map((s) => (
                <button key={s} type="button" className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>
                  {`${label(s)} (${counts?.[s] ?? 0})`}
                </button>
              ))}
            </div>
            <Select
              style={{ marginLeft: "auto", minWidth: 200 }}
              size="md"
              allowDeselect={false}
              aria-label={t`Trier par`}
              label={t`Trier par`}
              value={sort}
              onChange={(v) => v && setSort(v as SortKey)}
              data={[
                { value: "recent", label: t`Plus récentes d'abord` },
                { value: "ancien", label: t`Plus anciennes d'abord` },
                { value: "page", label: t`Page` },
                { value: "auteur", label: t`Auteur` },
                { value: "statut", label: t`Statut` },
              ]}
            />
          </div>
          {rows.length === 0 ? (
            <Empty title={total === 0 ? t`Aucune remarque pour l'instant` : t`Aucune remarque avec ce statut`}>
              <p>{t`Les remarques arrivent ici dès qu'une personne utilise le bouton « Amélioration ? » en bas à droite de l'écran.`}</p>
            </Empty>
          ) : (
            <div className="panel">
              {rows.map((r) => (
                <button key={r.id} type="button" className="list-row two" onClick={() => setOpen(r)}>
                  <span>
                    <b className="clamp-2">{r.text}</b>
                    <small>
                      {r.author}, {sqlWhen(r.createdAt)}, {r.pageTitle || r.pagePath}
                    </small>
                  </span>
                  <span className={`pill ${pill(r.status)}`}>{label(r.status)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}
      {open ? <ImprovementPanel key={open.id} item={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function ImprovementPanel({ item, onClose }: { item: Improvement; onClose: () => void }) {
  const { t } = useLingui();
  const label = useStatusLabel();
  const router = useRouter();
  const act = useAction();
  const [status, setStatus] = useState<ImprovementStatus>(item.status);
  const [note, setNote] = useState(item.adminNote ?? "");
  const dirty = status !== item.status || note.trim() !== (item.adminNote ?? "");
  const goToPage = () => {
    onClose();
    router.history.push(item.pagePath);
  };
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Remarque numéro ${item.id}`}
      title={t`Remarque de ${item.author}`}
      top={sqlWhen(item.createdAt)}
      pill={<span className={`pill ${pill(item.status)}`}>{label(item.status)}</span>}
      dirty={dirty}
    >
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 17 }}>{item.text}</p>
      <p className="hint">
        <Trans>Page :</Trans>{" "}
        <a
          href={`#${item.pagePath}`}
          onClick={(e) => {
            e.preventDefault();
            goToPage();
          }}
        >
          {item.pageTitle || item.pagePath}
        </a>{" "}
        <span className="mono-line">({item.pagePath})</span>
      </p>
      {item.viewportWidth ? (
        <p className="hint">
          <Trans>Largeur de la fenêtre : {item.viewportWidth} px</Trans>
        </p>
      ) : null}
      <Select
        mt="md"
        size="md"
        allowDeselect={false}
        label={t`Statut`}
        value={status}
        onChange={(v) => v && setStatus(v as ImprovementStatus)}
        data={STATUSES.map((s) => ({ value: s, label: label(s) }))}
      />
      <Textarea mt="md" size="md" autosize minRows={3} label={t`Note interne`} description={t`Visible par les personnes connectées, pas par les voyageurs.`} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      {act.state.status === "error" ? <ErrorLine text={act.state.text} /> : null}
      <button
        type="button"
        className="btn pri wide"
        style={{ marginTop: 16 }}
        disabled={!dirty || act.state.status === "busy"}
        onClick={() =>
          void act.run(() => api(`/improvements/${item.id}`, { method: "PATCH", body: { status, adminNote: note.trim() || null } }), t`C'est enregistré.`).then((ok) => ok && onClose())
        }
      >
        {act.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
      </button>
    </SidePanel>
  );
}
