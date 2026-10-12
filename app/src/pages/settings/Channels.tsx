// Airbnb, Booking et Vrbo (par Beds24) : l'état de la liaison en clair, le
// code d'invitation à coller pour la rétablir, les gestes manuels (tester,
// rapatrier, envoyer), les prix envoyés aux plateformes, les correspondances,
// les réservations venues des plateformes, les désaccords de calendrier
// (« conflits ») et le journal. Mêmes routes que l'ancien « Canaux OTA ».
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Textarea, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconPlugConnected } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import type { Beds24Status, ChannelsOverview, MarkupState, PriceLinkingState, SyncConflict } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { stayRange } from "../../lib/dates";
import { parsePct, pctFr } from "../../lib/markups";
import { eur } from "../../lib/money";
import { Beds24PropertyCard } from "./Beds24Property";
import { Confirm, Empty, Fold, Loading, Page, SaveBar, Section, SidePanel, sqlWhen, useWorkingProperty } from "../../ui/kit";



export function ChannelsPage() {
  const { t } = useLingui();
  const detailWords: Record<string, string> = { rooms: t`chambres`, pushed: t`envoyés`, updated: t`mis à jour`, created: t`créés`, par: t`par` };
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const ov = useQuery({ queryKey: ["channels", pid], queryFn: () => api<ChannelsOverview>("/channels/overview", { query: { property: pid } }), enabled: pid != null });
  const mk = useQuery({ queryKey: ["markups"], queryFn: () => api<MarkupState>("/channel-markups") });
  const linking = useQuery({ queryKey: ["price-linking"], queryFn: () => api<PriceLinkingState>("/channels/price-linking") });
  const [conflict, setConflict] = useState<SyncConflict | null>(null);
  const d = ov.data;
  const open = (d?.conflicts ?? []).filter((c) => c.status === "open");
  const ignored = (d?.conflicts ?? []).filter((c) => c.status === "ignored");
  // La route renvoie les réservations Beds24 de tous les domaines : on ne
  // garde que celles des biens de celui-ci.
  const channelBookings = (d?.channelBookings ?? []).filter((b) => d?.units.some((u) => u.name === b.unitName));
  return (
    <Page title={t`Airbnb, Booking et Vrbo`} back tools={picker} lead={t`Les plateformes reçoivent vos disponibilités et vos prix par Beds24, un service de liaison. Vous n'avez pas à ouvrir Beds24 : tout se suit ici.`}>
      {ov.error ? <ErrorLine text={t`L'état des plateformes n'a pas pu être lu.`} /> : null}
      {ov.isLoading ? <Loading /> : null}
      {d && pid ? (
        <>
          <LinkCard d={d} propertyId={pid} />
          {d.configured ? <Beds24PropertyCard propertyId={pid} /> : null}
          {linking.data?.enabled ? <p className="note">{t`Prix par plateforme en place : Beds24 ajoute à chaque plateforme son pourcentage ci-dessous. Le bouton « Appliquer » ne compte plus tant qu'ils sont en place.`}</p> : null}
          {mk.data ? <MarkupsCard m={mk.data} /> : mk.error ? <ErrorLine text={t`Les prix envoyés aux plateformes n'ont pas pu être lus.`} /> : null}
          <Section title={t`Promotions Airbnb et prix par plateforme`} hint={t`Remises long séjour, réservation tôt, dernière minute et non remboursable sur Airbnb ; un prix propre à chaque plateforme, calculé par Beds24 avec les pourcentages ci-dessus.`}>
            <Link to="/reglages/plateformes/prix" className="btn">
              {t`Régler les promotions et les prix par plateforme`}
            </Link>
          </Section>
          <Section title={t`Désaccords de calendrier`} hint={t`Ce qu'une plateforme annonce et que nous n'avons pas pu reprendre : ces dates restent en vente d'un côté et prises de l'autre. Un désaccord disparaît tout seul quand la liaison ne le revoit plus.`}>
            {open.length === 0 ? (
              <p className="ok-line">
                <IconCheck size={20} />
                <Trans>Aucun désaccord : tout ce que les plateformes annoncent est repris ici.</Trans>
              </p>
            ) : (
              <div className="panel">
                {open.map((c) => (
                  <button key={c.id} type="button" className="list-row two" onClick={() => setConflict(c)}>
                    <span>
                      <b>{c.unitName}</b>
                      <small>
                        {stayRange(c.checkin, c.checkout)}, {c.label}
                      </small>
                    </span>
                    <span className="pill annulee">{t`à trancher`}</span>
                  </button>
                ))}
              </div>
            )}
            {ignored.length ? (
              <Fold title={t`Désaccords mis de côté`} count={String(ignored.length)}>
                <div className="panel">
                  {ignored.map((c) => (
                    <button key={c.id} type="button" className="list-row two off" onClick={() => setConflict(c)}>
                      <span>
                        <b>{c.unitName}</b>
                        <small>
                          {stayRange(c.checkin, c.checkout)}, {c.ignoreReason ? t`motif : ${c.ignoreReason}` : c.label}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </Fold>
            ) : null}
          </Section>
          <Section title={t`Réservations venues des plateformes`}>
            {channelBookings.length === 0 ? (
              <Empty title={t`Aucune pour l'instant`}>
                <p>{t`Elles apparaîtront ici, dans le calendrier et dans Réservations dès que les annonces seront reliées.`}</p>
              </Empty>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl dense">
                  <thead>
                    <tr>
                      <th scope="col">{t`Réf.`}</th>
                      <th scope="col">{t`Plateforme`}</th>
                      <th scope="col">{t`Bien`}</th>
                      <th scope="col">{t`Séjour`}</th>
                      <th scope="col">{t`Client`}</th>
                      <th scope="col" className="r">
                        {t`Montant`}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelBookings.map((b) => (
                      <tr key={b.reference}>
                        <td className="ref">{b.reference}</td>
                        <td>{b.channelLabel ?? t`plateforme`}</td>
                        <td>{b.unitName}</td>
                        <td>{stayRange(b.checkin, b.checkout)}</td>
                        <td>{b.guestName || "—"}</td>
                        <td className="r">{b.totalCents ? eur(b.totalCents) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title={t`Correspondance des biens`} hint={t`Chaque bien d'ici et son équivalent chez Beds24. La correspondance se règle une fois, dans Beds24.`}>
            <table className="tbl">
              <tbody>
                {d.units.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.beds24RoomId ? t`relié (chambre n° ${u.beds24RoomId})` : u.isComposite ? t`vendu ici seulement ; ses deux maisons se ferment toutes seules ailleurs` : t`pas encore relié`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Fold title={t`Journal de la liaison`} count={String(d.events.length)} open>
            {d.events.length === 0 ? <p className="muted">{t`Encore rien.`}</p> : null}
            <ul className="log">
              {d.events.map((e) => (
                <li key={e.id}>
                  <b>{sqlWhen(e.createdAt)}</b> {beds24Action(e.action)}
                  {e.detail ? <small>{readableDetail(e.detail, detailWords)}</small> : null}
                </li>
              ))}
            </ul>
          </Fold>
          {d.webhookUrl ? (
            <Fold title={t`Détail technique`}>
              <p className="muted">{t`Adresse de notification à donner à Beds24 lors de la mise en ligne :`}</p>
              <p className="mono-line">{d.webhookUrl}</p>
            </Fold>
          ) : null}
        </>
      ) : null}
      {conflict ? <ConflictPanel c={conflict} onClose={() => setConflict(null)} /> : null}
    </Page>
  );
}

function beds24Action(a: string): string {
  if (a === "beds24.push") return i18n._(msg`calendriers envoyés aux plateformes`);
  if (a === "beds24.pull") return i18n._(msg`réservations rapatriées`);
  if (a === "beds24.invite_code") return i18n._(msg`liaison rétablie avec un code d'invitation`);
  return a.replace(/^beds24\./, "").replace(/_/g, " ");
}

function LinkCard({ d, propertyId }: { d: ChannelsOverview; propertyId: number }) {
  const { t } = useLingui();
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Beds24Status | null>(null);
  const invite = useAction();
  const test = useAction();
  const pull = useAction();
  const push = useAction();
  const showInvite = !d.configured || (status != null && !status.connected);
  return (
    <section className={`linkcard${d.configured ? " on" : " off"}`} aria-labelledby="h-liaison">
      <div className="lc-h">
        {d.configured ? <IconPlugConnected size={28} /> : <IconAlertTriangle size={28} />}
        <div>
          <h2 className="sub" id="h-liaison">
            {d.configured ? t`Liaison en place` : t`Liaison coupée`}
          </h2>
          <p>
            {d.configured
              ? t`Chaque réservation, annulation ou changement de prix part tout de suite vers les plateformes. Dernier rapatriement : ${d.lastPull ? sqlWhen(d.lastPull) : t`jamais`}.`
              : t`Les plateformes ne reçoivent plus vos disponibilités : elles pourraient vendre des dates déjà prises ici. Rétablissez la liaison avec un code d'invitation Beds24.`}
          </p>
          {d.property?.beds24PropertyId ? <p className="muted">{t`Domaine relié chez Beds24 : n° ${d.property.beds24PropertyId}.`}</p> : d.configured ? <p className="muted">{t`Ce domaine n'est pas encore relié à une propriété Beds24.`}</p> : null}
        </div>
      </div>
      {d.configured ? (
        <div className="acts">
          <button
            type="button"
            className="btn"
            disabled={test.state.status === "busy"}
            onClick={() =>
              void test.run(async () => {
                const s = await api<Beds24Status>("/beds24/status");
                setStatus(s);
                if (!s.connected) throw new Error(t`Beds24 ne répond pas avec ce compte. Rétablissez la liaison avec un nouveau code d'invitation (ci-dessous).`);
                return s;
              }, (r) => t`C'est fait. Beds24 répond : ${(r as Beds24Status).properties?.length ?? 0} propriété(s) visible(s).`)
            }
          >
            {test.state.status === "busy" ? t`Un instant…` : t`Tester la liaison`}
          </button>
          <button type="button" className="btn" disabled={pull.state.status === "busy"} onClick={() => void pull.run(() => api<{ imported: number; updated: number; cancelled: number }>("/beds24/pull", { method: "POST", body: { propertyId } }), (r) => { const x = r as { imported: number; updated: number; cancelled: number }; return t`C'est fait. ${x.imported} nouvelle(s), ${x.updated} modifiée(s), ${x.cancelled} annulée(s).`; })}>
            {pull.state.status === "busy" ? t`Un instant…` : t`Rapatrier les réservations`}
          </button>
          <button type="button" className="btn" disabled={push.state.status === "busy"} onClick={() => void push.run(() => api<{ pushed: { unitName: string }[] }>("/beds24/push", { method: "POST", body: { propertyId } }), (r) => t`C'est fait. Calendriers envoyés : ${(r as { pushed: { unitName: string }[] }).pushed.map((x) => x.unitName).join(", ") || t`aucun bien relié`}.`)}>
            {push.state.status === "busy" ? t`Un instant…` : t`Envoyer les calendriers maintenant`}
          </button>
        </div>
      ) : null}
      {[test, pull, push].map((a, i) => (a.state.status === "error" ? <ErrorLine key={i} text={a.state.text} /> : null))}
      {showInvite || d.configured ? (
        <details className="fold" open={showInvite}>
          <summary>{d.configured ? t`Rétablir la liaison avec un nouveau code` : t`Rétablir la liaison`}</summary>
          <div className="fold-b">
            <ol className="steps-list">
              <li>{t`Connectez-vous sur beds24.com.`}</li>
              <li>{t`Ouvrez Settings, puis Apps & Integrations, puis API.`}</li>
              <li>{t`Créez un « invite code » avec lecture et écriture (réservations, disponibilités, propriétés, canaux), sans liste d'adresses IP.`}</li>
              <li>{t`Copiez le code et collez-le ici.`}</li>
            </ol>
            <div className="row-in">
              <TextInput size="md" label={t`Code d'invitation Beds24`} value={code} onChange={(e) => setCode(e.currentTarget.value)} autoComplete="off" spellCheck={false} style={{ flex: "1 1 280px" }} />
              <button
                type="button"
                className="btn pri"
                disabled={code.trim().length < 6 || invite.state.status === "busy"}
                onClick={async () => {
                  const ok = await invite.run(
                    () => api<{ ok: boolean; status?: Beds24Status }>("/beds24/invite-code", { method: "POST", body: { code: code.trim() } }),
                    (r) => ((r as { status?: Beds24Status }).status?.connected ? t`C'est fait. Liaison rétablie : Beds24 répond.` : t`C'est fait. Code enregistré ; Beds24 ne répond pas encore, testez la liaison dans un instant.`),
                  );
                  if (ok) setCode("");
                }}
              >
                {invite.state.status === "busy" ? t`Un instant…` : t`Rétablir la liaison`}
              </button>
            </div>
            <p className="hint">{t`Le code ne sert qu'une fois : il est échangé contre un accès durable, gardé par le serveur. Il n'y a rien d'autre à faire.`}</p>
            {invite.state.status === "error" ? <ErrorLine text={t`Le code n'a pas été accepté (${invite.state.text}) Vérifiez qu'il est complet et qu'il n'a pas déjà servi, ou créez-en un nouveau.`} /> : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function MarkupsCard({ m }: { m: MarkupState }) {
  const { t } = useLingui();
  const init = useMemo(() => Object.fromEntries(m.channels.map((c) => [c.channel, c.markupPct as number | string])), [m]);
  const [v, setV] = useState(init);
  const [base, setBase] = useState(init);
  const dirtyNow = JSON.stringify(v) !== JSON.stringify(base);
  // Une relecture (après un test Beds24, par exemple) n'efface jamais une
  // saisie en cours : elle ne remplace le formulaire que s'il est intact.
  useEffect(() => {
    if (!dirtyNow) setV(init);
    setBase(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);
  const [apply, setApply] = useState<string | null | undefined>(undefined);
  const save = useAction();
  const app = useAction();
  const parsed = m.channels.map((c) => ({ ...c, pct: parsePct(v[c.channel] ?? "") }));
  const bad = parsed.find((c) => c.pct == null || c.pct < 0 || c.pct > m.maxPct);
  const changed = parsed.filter((c) => c.pct !== c.markupPct);
  const dirty = changed.length > 0;
  const applied = m.channels.find((c) => c.channel === m.pushChannel);
  const appliedChange = changed.find((c) => c.channel === m.pushChannel);
  const [confirmSave, setConfirmSave] = useState(false);
  const doSave = () => save.run(() => api("/channel-markups", { method: "PUT", body: { channels: parsed.map((c) => ({ channel: c.channel, label: c.label, markupPct: c.pct })) } }), t`C'est fait. Pourcentages enregistrés.`);
  return (
    <Section title={t`Prix envoyés aux plateformes`} hint={t`Les plateformes prennent une commission : on y affiche un prix un peu plus haut qu'en direct. Le prix de votre site ne change jamais.`}>
      <p className="lead">
        {applied
          ? t`Aujourd'hui : + ${pctFr(m.pushMarkupPct)} % (référence ${applied.label}). Une nuit à ${eur(m.example.directCents)} sur votre site part à ${eur(m.example.pushedCents)} sur les plateformes.`
          : t`Aujourd'hui : aucune majoration. Les plateformes reçoivent le prix de votre site, commission non compensée.`}
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th>{t`Plateforme`}</th>
            <th>{t`Majoration`}</th>
            <th>{t`Exemple`}</th>
            <th className="r" />
          </tr>
        </thead>
        <tbody>
          {m.channels.map((c) => {
            const ex = m.examples.find((e) => e.channel === c.channel);
            return (
              <tr key={c.channel}>
                <td>{c.label}</td>
                <td>
                  <NumberInput size="md" w={120} min={0} max={m.maxPct} step={0.5} decimalSeparator="," suffix=" %" aria-label={t`Majoration ${c.label}, en pourcentage`} value={v[c.channel]} onChange={(x) => setV({ ...v, [c.channel]: x })} />
                </td>
                <td>{t`${eur(m.example.directCents)} → ${eur(ex?.suggestedCents ?? m.example.directCents)}`}</td>
                <td className="r">
                  {c.channel === m.pushChannel ? (
                    <span className="pill soldee">{t`appliquée`}</span>
                  ) : (
                    <button type="button" className="btn" disabled={dirty || app.state.status === "busy"} title={dirty ? t`Enregistrez d'abord les pourcentages` : undefined} onClick={() => setApply(c.channel)}>
                      {t`Appliquer`}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {m.pushChannel ? (
        <button type="button" className="btn ghost" style={{ marginTop: 8 }} disabled={dirty} onClick={() => setApply(null)}>
          {t`Ne plus majorer`}
        </button>
      ) : null}
      {bad ? <ErrorLine text={t`${bad.label} : la majoration va de 0 à ${m.maxPct} %.`} /> : null}
      {app.state.status === "error" ? <ErrorLine text={app.state.text} /> : null}
      <SaveBar
        dirty={dirty}
        busy={save.state.status === "busy"}
        error={save.state.status === "error" ? save.state.text : null}
        label={t`Enregistrer les pourcentages`}
        onReset={() => setV(base)}
        onSave={() => {
          if (bad) return;
          if (appliedChange) setConfirmSave(true);
          else void doSave();
        }}
      />
      <Confirm
        open={confirmSave}
        title={t`Changer la majoration appliquée ?`}
        text={appliedChange ? t`${appliedChange.label} passe de + ${pctFr(appliedChange.markupPct)} % à + ${pctFr(appliedChange.pct ?? 0)} %. Les calendriers repartent tout de suite vers les plateformes ; le prix de votre site ne change pas.` : ""}
        yes={t`Enregistrer et envoyer`}
        onNo={() => setConfirmSave(false)}
        onYes={async () => {
          setConfirmSave(false);
          await doSave();
        }}
      />
      <Confirm
        open={apply !== undefined}
        title={apply ? t`Majorer les prix envoyés aux plateformes ?` : t`Ne plus majorer ?`}
        text={
          apply
            ? t`Tous les prix envoyés aux plateformes augmentent de + ${pctFr(m.channels.find((c) => c.channel === apply)?.markupPct ?? 0)} %, pour tous les biens et toutes les dates. Ils repartent tout de suite. Le prix de votre site ne change pas.`
            : t`Les plateformes recevront le prix de votre site, sans compenser leur commission. Les calendriers repartent tout de suite.`
        }
        yes={apply ? t`Majorer` : t`Ne plus majorer`}
        busy={app.state.status === "busy"}
        onNo={() => setApply(undefined)}
        onYes={async () => {
          await app.run(() => api("/channel-markups/apply", { method: "POST", body: { channel: apply } }), apply ? t`C'est fait. Prix des plateformes majorés.` : t`C'est fait. Les plateformes reçoivent le prix de votre site.`);
          setApply(undefined);
        }}
      />
    </Section>
  );
}

function ConflictPanel({ c, onClose }: { c: SyncConflict; onClose: () => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const a = useAction();
  const ignored = c.status === "ignored";
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Désaccord de calendrier`}
      top={c.unitName}
      title={stayRange(c.checkin, c.checkout)}
      pill={<span className={`pill ${ignored ? "muted-pill" : "annulee"}`}>{ignored ? t`mis de côté` : t`à trancher`}</span>}
      dirty={reason.trim().length > 0}
      actions={
        <>
          <button type="button" className="btn wide" onClick={() => void navigate({ to: "/calendrier" })}>
            {t`Voir le calendrier`}
          </button>
          {ignored ? (
            <button type="button" className="btn pri wide" disabled={a.state.status === "busy"} onClick={async () => { if (await a.run(() => api(`/sync-conflicts/${c.id}`, { method: "PATCH", body: { status: "open", reason: "" } }), t`C'est fait. Désaccord rouvert.`)) onClose(); }}>
              {t`Rouvrir`}
            </button>
          ) : (
            <button type="button" className="btn pri wide" onClick={() => setAsking(true)}>
              {t`Mettre de côté`}
            </button>
          )}
        </>
      }
    >
      <p className="lead">{c.label}</p>
      <dl className="facts">
        <div>
          <dt>{t`Venu de`}</dt>
          <dd>{c.channelLabel || (c.source === "ical" ? t`un calendrier relié` : t`une plateforme`)}</dd>
        </div>
        <div>
          <dt>{t`Réservation d'ici`}</dt>
          <dd>{c.bookingReference ?? t`aucune`}</dd>
        </div>
        <div>
          <dt>{t`Vu la première fois`}</dt>
          <dd>{sqlWhen(c.firstSeenAt)}</dd>
        </div>
        <div>
          <dt>{t`Revu`}</dt>
          <dd>{sqlWhen(c.lastSeenAt)}</dd>
        </div>
      </dl>
      {ignored && c.ignoreReason ? <p className="note">{t`Motif : ${c.ignoreReason}`}</p> : null}
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Mettre ce désaccord de côté ?`}
        text={t`Il ne s'affichera plus comme à trancher. Le motif reste écrit, pour pouvoir relire la décision plus tard.`}
        yes={t`Mettre de côté`}
        yesDisabled={reason.trim().length < 3}
        busy={a.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          if (reason.trim().length < 3) return;
          const ok = await a.run(() => api(`/sync-conflicts/${c.id}`, { method: "PATCH", body: { status: "ignored", reason: reason.trim() } }), t`C'est fait. Désaccord mis de côté.`);
          setAsking(false);
          if (ok) onClose();
        }}
      >
        <Textarea size="md" label={t`Motif`} autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </Confirm>
    </SidePanel>
  );
}

/** Le détail d'un événement de liaison arrive en JSON brut : on le lit en français (« 2 chambres »), sans accolades. */
function readableDetail(detail: string, words: Record<string, string>): string {
  if (!detail.startsWith("{")) return detail.slice(0, 140);
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${words[k] ?? k} : ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(", ")
      .slice(0, 140);
  } catch {
    return detail.slice(0, 140);
  }
}
