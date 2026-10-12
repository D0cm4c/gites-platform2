// Calendriers reliés (iCal) : l'adresse de chaque bien à donner aux autres
// sites, et les calendriers d'autres sites que la plateforme lit toutes les
// 15 minutes. Un calendrier lu s'ouvre en panneau latéral.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, Switch, TextInput } from "@mantine/core";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import type { FeedSyncResult, IcalFeed, IcalResponse, UnitFull } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Confirm, Empty, Loading, Page, Section, SidePanel, sqlWhen, useWorkingProperty } from "../../ui/kit";
import { useUnitsFull } from "./useAdmin";

function useSyncText() {
  const { t } = useLingui();
  return (r: FeedSyncResult) => {
    if (r.error) throw new Error(t`Le calendrier n'a pas pu être lu : ${r.error}.`);
    const parts = [t`${r.imported} nouvelle(s)`, t`${r.updated} modifiée(s)`, t`${r.cancelled} annulée(s)`];
    return t`C'est fait. ${parts.join(", ")}${r.conflicts.length ? t`, ${r.conflicts.length} en désaccord (voir Airbnb, Booking et Vrbo)` : ""}.`;
  };
}

export function IcalPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const toast = useToast();
  const q = useQuery({ queryKey: ["ical", pid], queryFn: () => api<IcalResponse>("/ical", { query: { property: pid } }), enabled: pid != null });
  const units = useUnitsFull(pid);
  const [open, setOpen] = useState<IcalFeed | "new" | null>(null);
  const all = useAction();
  const syncText = useSyncText();
  return (
    <Page title={t`Calendriers reliés`} back tools={picker} lead={t`Pour les sites qui ne passent pas par Beds24 : chacun lit nos dates, et nous lisons les siennes. Le délai côté Airbnb est d'environ deux heures.`}>
      {q.error ? <ErrorLine text={t`Les calendriers n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <>
          <Section title={t`Nos calendriers, à donner aux autres sites`} hint={t`À coller dans Airbnb (« Importer un calendrier ») ou ailleurs. Si le Domaine entier est réservé, les deux maisons y apparaissent prises.`}>
            <div className="panel">
              {q.data.exports.map((e) => (
                <div key={e.unitId} className="list-row two static">
                  <span>
                    <b>{e.unitName}</b>
                    <small className="mono-line">{e.url}</small>
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(e.url);
                        toast(t`Adresse de ${e.unitName} copiée.`);
                      } catch {
                        toast(t`L'adresse n'a pas pu être copiée : sélectionnez-la et copiez-la à la main.`, true);
                      }
                    }}
                  >
                    <IconCopy size={20} />
                    <Trans>Copier</Trans>
                  </button>
                </div>
              ))}
            </div>
          </Section>
          <Section
            title={t`Calendriers d'autres sites`}
            hint={t`Lus toutes les 15 minutes. Si une date lue est déjà prise ici, elle est refusée et signalée.`}
            tools={
              <>
                <button type="button" className="btn" disabled={all.state.status === "busy" || !q.data.feeds.some((f) => f.active)} onClick={() =>
                    void all.run(async () => {
                      // Seulement les calendriers de ce domaine (/ical-sync relirait tous les domaines).
                      const feeds = q.data!.feeds.filter((f) => f.active);
                      const bad: string[] = [];
                      for (const f of feeds) {
                        // Un flux en panne n'empêche pas de relire les suivants.
                        try {
                          const r = await api<{ result: FeedSyncResult }>(`/ical-feeds/${f.id}/sync`, { method: "POST" });
                          if (r.result.error) bad.push(f.name);
                        } catch {
                          bad.push(f.name);
                        }
                      }
                      if (bad.length) throw new Error(t`Relu, sauf : ${bad.join(", ")} (voir leur fiche).`);
                      return feeds.length;
                    }, (n) => t`C'est fait. ${n as number} calendrier(s) relu(s).`)
                  }>
                  {all.state.status === "busy" ? t`Un instant…` : t`Tout relire maintenant`}
                </button>
                <button type="button" className="btn pri" onClick={() => setOpen("new")}>
                  <IconPlus size={20} />
                  <Trans>Ajouter un calendrier</Trans>
                </button>
              </>
            }
          >
            {all.state.status === "error" ? <ErrorLine text={all.state.text} /> : null}
            {q.data.feeds.length === 0 ? (
              <Empty title={t`Aucun calendrier lu`}>
                <p>{t`Ajoutez l'adresse iCal donnée par un autre site pour que ses réservations bloquent les dates ici.`}</p>
              </Empty>
            ) : (
              <div className="panel">
                {q.data.feeds.map((f) => (
                  <button key={f.id} type="button" className={`list-row two${f.active ? "" : " off"}`} onClick={() => setOpen(f)}>
                    <span>
                      <b>{f.name}</b>
                      <small>
                        {f.unitName}, {f.active ? (f.lastSyncAt ? t`lu le ${sqlWhen(f.lastSyncAt)}` : t`jamais lu`) : t`en pause`}
                      </small>
                    </span>
                    {f.lastStatus && f.lastStatus !== "ok" ? <span className="pill annulee">{t`problème`}</span> : <span className="go">{t`Ouvrir`}</span>}
                  </button>
                ))}
              </div>
            )}
          </Section>
        </>
      ) : null}
      {open && units.data ? <FeedPanel feed={open === "new" ? null : open} units={units.data.units.filter((u) => u.active)} onClose={() => setOpen(null)} syncText={syncText} /> : null}
    </Page>
  );
}

function FeedPanel({ feed, units, onClose, syncText }: { feed: IcalFeed | null; units: UnitFull[]; onClose: () => void; syncText: (r: FeedSyncResult) => string }) {
  const { t } = useLingui();
  const init = useMemo(() => ({ unitId: String(feed?.unitId ?? units[0]?.id ?? ""), name: feed?.name ?? "", url: feed?.url ?? "", active: feed?.active ?? true, departureDayIncluded: feed?.departureDayIncluded ?? false }), [feed, units]);
  const [v, setV] = useState(init);
  const [asking, setAsking] = useState(false);
  const a = useAction();
  const sync = useAction();
  const del = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const valid = v.name.trim().length >= 2 && /^https?:\/\//.test(v.url.trim()) && !!v.unitId;
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Calendrier relié`}
      top={feed?.unitName ?? t`Nouveau calendrier`}
      title={v.name.trim() || t`Calendrier sans nom`}
      dirty={dirty}
      actions={
        <>
          <button
            type="button"
            className="btn pri wide"
            disabled={!valid || (!dirty && !!feed) || a.state.status === "busy"}
            onClick={async () => {
              const ok = await a.run(
                () => (feed ? api(`/ical-feeds/${feed.id}`, { method: "PATCH", body: { name: v.name.trim(), url: v.url.trim(), active: v.active, departureDayIncluded: v.departureDayIncluded } }) : api("/ical-feeds", { method: "POST", body: { unitId: Number(v.unitId), name: v.name.trim(), url: v.url.trim(), departureDayIncluded: v.departureDayIncluded } })),
                feed ? t`C'est fait. Calendrier enregistré.` : t`C'est fait. Calendrier ajouté ; il sera lu dans les 15 minutes.`,
              );
              if (ok) onClose();
            }}
          >
            {a.state.status === "busy" ? t`Un instant…` : feed ? t`Enregistrer` : t`Ajouter`}
          </button>
          {feed ? (
            <button type="button" className="btn wide" disabled={sync.state.status === "busy" || dirty} onClick={() => void sync.run(() => api<{ result: FeedSyncResult }>(`/ical-feeds/${feed.id}/sync`, { method: "POST" }).then((r) => syncText(r.result)), (r) => r as string)}>
              {sync.state.status === "busy" ? t`Un instant…` : t`Relire maintenant`}
            </button>
          ) : null}
        </>
      }
      more={feed ? [{ label: t`Retirer ce calendrier`, danger: true, onClick: () => setAsking(true) }] : []}
    >
      {feed?.lastStatus ? <p className="lead">{t`Dernière lecture : ${feed.lastSyncAt ? sqlWhen(feed.lastSyncAt) : t`jamais`}, ${feed.lastStatus === "ok" ? t`sans problème` : feed.lastStatus}.`}</p> : null}
      {!feed ? (
        <Select size="md" label={t`Bien concerné`} allowDeselect={false} value={v.unitId} onChange={(x) => setV({ ...v, unitId: x ?? "" })} data={units.map((u) => ({ value: String(u.id), label: u.name }))} />
      ) : null}
      <TextInput mt="sm" size="md" label={t`Nom`} placeholder={t`Par exemple : Airbnb, le Moulin`} value={v.name} onChange={(e) => setV({ ...v, name: e.currentTarget.value })} />
      <TextInput mt="sm" size="md" label={t`Adresse iCal`} placeholder="https://www.airbnb.com/calendar/ical/…" value={v.url} onChange={(e) => setV({ ...v, url: e.currentTarget.value })} />
      {feed ? <Switch mt="lg" size="md" label={t`Lu toutes les 15 minutes`} checked={v.active} onChange={(e) => setV({ ...v, active: e.currentTarget.checked })} /> : null}
      <Switch
        mt="md"
        size="md"
        label={t`Le jour du départ est inclus dans ce calendrier`}
        description={t`À cocher pour un agenda tenu à la main qui bloque aussi le jour du départ (du 22 au 26 = départ le 26). Airbnb, Booking et Beds24 laissent le jour du départ libre : pour eux, ne pas cocher.`}
        checked={v.departureDayIncluded}
        onChange={(e) => setV({ ...v, departureDayIncluded: e.currentTarget.checked })}
      />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      {sync.state.status === "error" ? <ErrorLine text={sync.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Retirer ${feed?.name ?? ""} ?`}
        text={t`Le calendrier ne sera plus lu. Les réservations déjà reprises restent.`}
        yes={t`Retirer`}
        danger
        busy={del.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          const ok = await del.run(() => api(`/ical-feeds/${feed!.id}`, { method: "DELETE" }), t`C'est fait. Calendrier retiré.`);
          setAsking(false);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
