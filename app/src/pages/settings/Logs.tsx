// Journaux : « ce qui a été fait » (journal d'audit, GET /audit) et « mails
// envoyés » (GET /email-log). Ces deux routes existaient sans écran. Une ligne
// ouvre son détail en panneau latéral.
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { AuditRow, EmailLogRow } from "../../api/types2";
import { ErrorLine } from "../../lib/action";
import { useOpenBooking } from "../../shell/Shell";
import { eur } from "../../lib/money";
import { Empty, Fold, Loading, Page, SidePanel, sqlWhen } from "../../ui/kit";

const ACTIONS: Record<string, MessageDescriptor> = {
  "booking.create_manual": msg`réservation prise par téléphone`,
  "booking.confirm_manual": msg`réservation confirmée`,
  "booking.cancel": msg`réservation annulée`,
  "booking.modify": msg`séjour modifié`,
  "booking.modify_guest": msg`coordonnées d'un client modifiées`,
  "payment.manual": msg`paiement noté à la main`,
  "email.balance_reminder": msg`rappel du solde envoyé`,
  "email.voucher_resent": msg`confirmation renvoyée`,
  "email.confirmation_resent": msg`confirmation et conditions générales renvoyées`,
  "message.reply": msg`message envoyé à un client`,
  "rate.override": msg`prix fixé à la main`,
  "rate.override_clear": msg`retour au prix de saison`,
  "rate.create": msg`prix créé`,
  "rate.update": msg`prix changé`,
  "rate.delete": msg`prix supprimé`,
  "season.create": msg`saison créée`,
  "season.update": msg`saison modifiée`,
  "season.delete": msg`saison supprimée`,
  "promotion.create": msg`remise créée`,
  "promotion.update": msg`remise modifiée`,
  "promotion.delete": msg`remise supprimée`,
  "option.create": msg`option créée`,
  "option.update": msg`option modifiée`,
  "option.delete": msg`option supprimée`,
  "settings.update": msg`réglages du domaine changés`,
  "unit.update": msg`bien modifié`,
  "unit.create": msg`bien créé`,
  "unit.links": msg`liaisons d'un bien changées`,
  "user.create": msg`accès créé`,
  "user.reset_password": msg`nouveau mot de passe`,
  "user.enable": msg`accès rendu`,
  "user.disable": msg`accès coupé`,
  "user.delete": msg`compte supprimé`,
  "guest.update": msg`fiche client modifiée`,
  "guest_register.record": msg`voyageurs inscrits au registre`,
  "guest_register.export": msg`registre exporté`,
  "block.create": msg`dates bloquées`,
  "block.delete": msg`blocage levé`,
  "beds24.push": msg`calendriers envoyés aux plateformes`,
  "beds24.invite_code": msg`liaison Beds24 rétablie`,
  "pricing.channel_markups": msg`majorations des plateformes changées`,
  "pricing.push_channel": msg`majoration appliquée aux plateformes`,
  "checklist.update": msg`mise en route mise à jour`,
  "sync_conflict.ignored": msg`désaccord de calendrier mis de côté`,
  "sync_conflict.reopened": msg`désaccord de calendrier rouvert`,
};

function actionLabel(a: string): string {
  const d = ACTIONS[a];
  return d ? i18n._(d) : a.replace(/[._]/g, " ");
}

const KINDS: Record<string, MessageDescriptor> = {
  voucher: msg`confirmation de réservation`,
  confirmation: msg`confirmation et conditions générales`,
  balance_reminder: msg`rappel du solde`,
  message: msg`message`,
  auto_reply: msg`accusé de réception`,
  hold: msg`option en attente`,
  cancel: msg`annulation`,
};
function kindLabel(k: string): string {
  const d = KINDS[k];
  return d ? i18n._(d) : k.replace(/_/g, " ");
}

export function LogsPage() {
  const { t } = useLingui();
  const [tab, setTab] = useState<"audit" | "mails">("audit");
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api<{ entries: AuditRow[] }>("/audit", { query: { limit: 300 } }).then((r) => r.entries), enabled: tab === "audit" });
  const mails = useQuery({ queryKey: ["email-log"], queryFn: () => api<{ emails: EmailLogRow[] }>("/email-log").then((r) => r.emails), enabled: tab === "mails" });
  const [openA, setOpenA] = useState<AuditRow | null>(null);
  const [openM, setOpenM] = useState<EmailLogRow | null>(null);
  return (
    <Page title={t`Journaux`} back lead={t`Pour retrouver qui a fait quoi, et ce qui a été écrit aux clients.`}>
      <div className="tabs" role="tablist" aria-label={t`Journal`}>
        <button type="button" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>
          {t`Ce qui a été fait`}
        </button>
        <button type="button" role="tab" aria-selected={tab === "mails"} onClick={() => setTab("mails")}>
          {t`Mails envoyés`}
        </button>
      </div>
      {tab === "audit" ? (
        <>
          {audit.error ? <ErrorLine text={t`Le journal n'a pas pu être lu.`} /> : null}
          {audit.isLoading ? <Loading /> : null}
          {audit.data && audit.data.length === 0 ? <Empty title={t`Rien d'écrit pour l'instant`} /> : null}
          {audit.data?.length ? (
            <div className="panel">
              {audit.data.map((e) => (
                <button key={e.id} type="button" className="list-row two" onClick={() => setOpenA(e)}>
                  <span>
                    <b>{actionLabel(e.action)}</b>
                    <small>
                      {sqlWhen(e.createdAt)}
                      {e.entity ? `, ${entityText(e.entity)}` : ""}
                    </small>
                  </span>
                  <small>{actorOf(e)}</small>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {mails.error ? <ErrorLine text={t`Le journal des mails n'a pas pu être lu.`} /> : null}
          {mails.isLoading ? <Loading /> : null}
          {mails.data && mails.data.length === 0 ? <Empty title={t`Aucun mail envoyé`} /> : null}
          {mails.data?.length ? (
            <div className="panel">
              {mails.data.map((m) => (
                <button key={m.id} type="button" className="list-row two" onClick={() => setOpenM(m)}>
                  <span>
                    <b>{m.subject}</b>
                    <small>
                      {sqlWhen(m.createdAt)}, {t`à ${m.toEmail}`}
                    </small>
                  </span>
                  <MailPill m={m} />
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {openA ? <AuditPanel e={openA} onClose={() => setOpenA(null)} /> : null}
      {openM ? <MailPanel m={openM} onClose={() => setOpenM(null)} /> : null}
    </Page>
  );
}

function actorOf(e: AuditRow): string {
  try {
    const d = e.detail ? (JSON.parse(e.detail) as { par?: string }) : null;
    if (d?.par) return d.par;
  } catch {
    /* détail non JSON */
  }
  return e.actor === "admin" ? "back-office" : e.actor;
}

function MailPill({ m }: { m: EmailLogRow }) {
  const { t } = useLingui();
  if (m.status === "sent") return <span className="pill soldee">{t`parti`}</span>;
  if (m.status === "failed") return <span className="pill annulee">{t`pas parti`}</span>;
  if (m.status === "stub") return <span className="pill muted-pill">{t`préparé, envoi coupé`}</span>;
  return <span className="pill option">{m.status}</span>;
}

const KEYS: Record<string, string> = {
  from: "du", to: "au", checkin: "arrivée", checkout: "départ", reason: "motif", name: "nom", status: "état",
  priceCents: "prix", priceWeekCents: "prix en semaine", priceWeekendCents: "prix du week-end", holidayPct: "fériés (%)",
  minNights: "nuits minimum", weekdays: "jours", days: "jours", removed: "jours remis au prix de saison", dateStart: "début",
  dateEnd: "fin", label: "libellé", code: "code", discountPct: "remise (%)", discountCents: "remise", threshold: "seuil",
  active: "actif", occupants: "voyageurs", lignes: "lignes", property: "domaine", channel: "plateforme", markupPct: "majoration (%)",
  amountCents: "montant", method: "moyen", unitId: "bien", seasonId: "saison", partnerIds: "biens liés", capacityBase: "personnes",
  capacityMax: "personnes au plus", cleaningFeeCents: "ménage", depositPct: "arrhes (%)", note: "note", corrections: "corrections",
};
const HIDDEN = new Set(["par", "rooms", "pushed", "updated", "created"]);

function valueText(k: string, v: unknown): string {
  if (v == null) return "aucun";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "number" && /Cents$/.test(k)) return eur(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function entityText(e: string | null): string {
  if (!e) return "l'ensemble";
  const [kind, id] = e.split(":");
  const k = ({ booking: "réservation", unit: "bien", season: "saison", rate: "prix", promotion: "remise", option: "option", user: "compte", guest: "client", property: "domaine", feed: "calendrier relié", conflict: "désaccord", checklist: "démarche" } as Record<string, string>)[kind ?? ""];
  return k ? `${k} ${id}` : "réglage général";
}

function AuditPanel({ e, onClose }: { e: AuditRow; onClose: () => void }) {
  const { t } = useLingui();
  let detail: [string, string][] = [];
  try {
    const d = e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : {};
    detail = Object.entries(d)
      .filter(([k]) => !HIDDEN.has(k))
      .map(([k, v]) => [KEYS[k] ?? k.replace(/([A-Z])/g, " $1").toLowerCase(), valueText(k, v)]);
  } catch {
    if (e.detail) detail = [["détail", e.detail]];
  }
  return (
    <SidePanel opened onClose={onClose} label={t`Entrée du journal`} top={sqlWhen(e.createdAt)} title={actionLabel(e.action)}>
      <dl className="facts">
        <div>
          <dt>{t`Par`}</dt>
          <dd>{actorOf(e)}</dd>
        </div>
        <div>
          <dt>{t`Sur`}</dt>
          <dd>{entityText(e.entity)}</dd>
        </div>
      </dl>
      {detail.length ? (
        <table className="tbl">
          <tbody>
            {detail.map(([k, v], i) => (
              <tr key={i}>
                <td>{k}</td>
                <td style={{ overflowWrap: "anywhere" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {e.detail ? (
        <Fold title={t`Détail technique`}>
          <p className="mono-line">{e.detail}</p>
        </Fold>
      ) : null}
    </SidePanel>
  );
}

function MailPanel({ m, onClose }: { m: EmailLogRow; onClose: () => void }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Mail`}
      top={kindLabel(m.kind)}
      title={m.subject}
      pill={<MailPill m={m} />}
      actions={
        m.bookingId ? (
          <button
            type="button"
            className="btn wide"
            onClick={() => {
              onClose();
              openBooking(m.bookingId!);
            }}
          >
            {t`Ouvrir la réservation`}
          </button>
        ) : undefined
      }
    >
      <p className="lead">{t`À ${m.toEmail}, le ${sqlWhen(m.createdAt)}.`}</p>
      {m.status === "failed" && m.errorDetail ? <ErrorLine text={t`Raison : ${m.errorDetail}`} /> : null}
      <div className="bub">{m.bodyText}</div>
    </SidePanel>
  );
}
