// Fiche réservation en panneau latéral (plan v4, changement 5) : téléphone et
// mail cliquables, trois actions selon l'état, le reste sous « Plus », les
// détails repliés. Toute action passe par useAction : verrou, puis « C'est
// fait » ou l'erreur en clair.
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Drawer, Menu, Modal, NumberInput, Select, Textarea, TextInput } from "@mantine/core";
import {
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconCurrencyEuro,
  IconDots,
  IconFileText,
  IconHome,
  IconMail,
  IconMessage,
  IconPencil,
  IconPhone,
  IconSend,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { api, openAdminPdf } from "../api/client";
import { useBooking, useGuest, useProperties } from "../api/hooks";
import type { AuditEntry, Booking, BookingDetail, Guest, QuoteResponse } from "../api/types";
import { ErrorLine, useAction } from "../lib/action";
import { diffDays, hourLabel, longDate, todayBrussels } from "../lib/dates";
import { channelName, isChannel } from "../lib/derive";
import { eur } from "../lib/money";
import { TemplateChips } from "../messages/TemplateChips";
import { useToast } from "../lib/toasts";
import { useLayout } from "../lib/useLayout";
import { RegisterSection } from "./Register";
import { sqlWhen } from "../ui/kit";

export type BookingState = "option" | "solde" | "soldee" | "plat" | "annulee";

export function bookingState(b: Booking): BookingState {
  if (b.status === "cancelled") return "annulee";
  if (b.status === "pending") return "option";
  if (isChannel(b)) return "plat";
  return b.totalCents - b.paidCents > 0 ? "solde" : "soldee";
}

function useTimes(propertyId: number | undefined) {
  return useQuery({
    queryKey: ["settings", propertyId],
    queryFn: () => api<{ settings: { checkinTime: string; checkoutTime: string } }>("/settings", { query: { property: propertyId } }).then((r) => r.settings),
    enabled: propertyId != null,
    staleTime: 5 * 60_000,
  });
}

type Dialog = null | "pay" | "write" | "cancel" | "edit" | "notes" | "link";

export function BookingPanel({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t } = useLingui();
  const layout = useLayout();
  const q = useBooking(id);
  const [dialog, setDialog] = useState<Dialog>(null);
  useEffect(() => setDialog(null), [id]);
  return (
    <Drawer
      opened={id != null}
      onClose={onClose}
      position="right"
      size={layout === "A" ? 480 : "100%"}
      title={<span className="sr">{t`Fiche de la réservation`}</span>}
      padding="md"
      // Le panneau lui-même n'a pas de saisie : il se ferme au clic à côté.
      // Les boîtes de saisie (encaisser, écrire, annuler…) ne le font jamais.
      closeOnClickOutside={dialog == null}
      closeOnEscape={dialog == null}
      closeButtonProps={{ "aria-label": t`Fermer la fiche`, size: "lg" }}
    >
      {q.isLoading ? <p className="loading">{t`Chargement de la fiche…`}</p> : null}
      {q.error ? <ErrorLine text={t`La fiche n'a pas pu être lue. Fermez-la et réessayez.`} /> : null}
      {q.data ? <Fiche detail={q.data} dialog={dialog} setDialog={setDialog} /> : null}
    </Drawer>
  );
}

function Fiche({ detail, dialog, setDialog }: { detail: BookingDetail; dialog: Dialog; setDialog: (d: Dialog) => void }) {
  const { t } = useLingui();
  const b = detail.booking;
  const guest = useGuest(b.guestId).data;
  const times = useTimes(b.propertyId).data;
  const state = bookingState(b);
  const today = todayBrussels();
  const nights = diffDays(b.checkin, b.checkout);
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const late = balance > 0 && b.status === "confirmed" && !!b.balanceDueDate && b.balanceDueDate <= today;
  const name = b.guestName?.trim() || (isChannel(b) ? t`Réservation ${channelName(b)}` : t`Client sans nom`);
  const phone = guest?.phone?.trim() || null;
  const email = b.guestEmail ?? guest?.email ?? null;

  const pill: Record<BookingState, string> = {
    option: t`Option, arrhes pas encore payées`,
    solde: t`Solde à encaisser`,
    soldee: t`Confirmée et payée`,
    plat: t`Via ${channelName(b)}`,
    annulee: t`Annulée`,
  };

  return (
    <>
      <div className="p-head">
        <div className="p-top">
          <IconHome size={18} />
          {b.unitName}
        </div>
        <h2>{name}</h2>
        <span className={`pill ${state}`}>{pill[state]}</span>
        <div className="contact">
          {phone ? (
            <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
              <IconPhone size={22} />
              {phone}
            </a>
          ) : null}
          {email ? (
            <a className="btn" href={`mailto:${email}`}>
              <IconMail size={22} />
              <Trans>Écrire un mail</Trans>
            </a>
          ) : null}
          {!phone && !email ? (
            <p className="muted" style={{ margin: 0 }}>
              <Trans>Ni téléphone ni mail sur cette réservation.</Trans>
            </p>
          ) : null}
        </div>
      </div>
      <div className="p-body">
        {state === "annulee" ? (
          <div className="err" role="status">
            <IconX size={20} />
            <p>
              <Trans>Réservation annulée.</Trans> {b.cancelReason ? t`Motif : ${b.cancelReason}` : null}
            </p>
          </div>
        ) : null}
        <dl className="facts">
          <div>
            <dt>
              <Trans>Arrivée</Trans>
            </dt>
            <dd>
              {longDate(b.checkin)}
              {times ? `, ${hourLabel(times.checkinTime)}` : ""}
            </dd>
          </div>
          <div>
            <dt>
              <Trans>Départ</Trans>
            </dt>
            <dd>
              {longDate(b.checkout)}
              {times ? `, ${hourLabel(times.checkoutTime)}` : ""}
            </dd>
          </div>
          <div>
            <dt>
              <Trans>Durée</Trans>
            </dt>
            <dd>{nights > 1 ? t`${nights} nuits` : t`1 nuit`}</dd>
          </div>
          <div>
            <dt>
              <Trans>Voyageurs</Trans>
            </dt>
            <dd>
              {b.adults + b.children > 0
                ? b.children > 0
                  ? t`${b.adults} adulte(s) et ${b.children} enfant(s)`
                  : t`${b.adults} adulte(s)`
                : t`non communiqué`}
            </dd>
          </div>
          <div>
            <dt>
              <Trans>Réservé</Trans>
            </dt>
            <dd>
              {b.source === "manual" ? t`par téléphone` : b.source === "import" ? t`import elloha` : t`sur ${channelName(b)}`}
            </dd>
          </div>
          <div>
            <dt>
              <Trans>Référence</Trans>
            </dt>
            <dd>{b.reference}</dd>
          </div>
          <div className="wide">
            <dt>
              <Trans>Client</Trans>
            </dt>
            <dd>
              {b.guestName?.trim() || "—"}
              {email || phone ? <small>{[email, phone].filter(Boolean).join(", ")}</small> : null}
            </dd>
          </div>
        </dl>
        {b.guestNotes ? <p className="note">{t`Message du client : ${b.guestNotes}`}</p> : null}

        {isChannel(b) ? (
          <div className="money">
            <p>
              <span>
                <Trans>Paiement</Trans>
              </span>
              <span>{t`encaissé par ${channelName(b)}`}</span>
            </p>
          </div>
        ) : (
          <div className="money">
            <p>
              <span>
                <Trans>Total du séjour</Trans>
              </span>
              <b>{eur(b.totalCents)}</b>
            </p>
            <p>
              <span>
                <Trans>Déjà payé</Trans>
              </span>
              <span>{eur(b.paidCents)}</span>
            </p>
            {balance > 0 && b.status !== "cancelled" ? (
              <p className="due">
                <span>
                  {b.status === "pending" ? t`Arrhes attendues` : t`Solde`}
                  {b.status === "confirmed" && b.balanceDueDate ? t`, attendu le ${longDate(b.balanceDueDate)}` : ""}
                </span>
                <span>{eur(b.status === "pending" ? Math.max(0, b.depositCents - b.paidCents) : balance)}</span>
              </p>
            ) : null}
            {b.paidCents > b.totalCents && b.status !== "cancelled" ? (
              <p className="due">
                <span>{t`À rembourser (trop-perçu, à faire à la main)`}</span>
                <span>{eur(b.paidCents - b.totalCents)}</span>
              </p>
            ) : null}
            {late ? (
              <span className="late">
                {t`En retard de ${diffDays(b.balanceDueDate as string, today)} jours.`}
              </span>
            ) : null}
            {b.status === "pending" && b.holdExpiresAt ? (
              <span className="late">{t`Sans arrhes reçues, les dates se libèrent le ${longDate(b.holdExpiresAt.slice(0, 10))}.`}</span>
            ) : null}
          </div>
        )}

        {state !== "annulee" ? <MainActions b={b} state={state} balance={balance} setDialog={setDialog} /> : null}
        {state !== "annulee" ? <MoreMenu b={b} setDialog={setDialog} /> : null}

        <Fold title={t`Devis`} count={eur(detail.quote?.totalCents ?? b.totalCents)}>
          <table className="tbl dense mini">
            <tbody>
              {(detail.quote?.lines ?? []).map((l, i) => (
                <tr key={i}>
                  <td>{l.publicLabel ?? l.label}</td>
                  <td className="r">{eur(l.amountCents)}</td>
                </tr>
              ))}
              {detail.quote?.lines?.length ? null : (
                <tr>
                  <td className="muted">{t`Pas de devis enregistré`}</td>
                  <td className="r">{eur(b.totalCents)}</td>
                </tr>
              )}
              <tr className="tot">
                <td>{t`Total`}</td>
                <td className="r">{eur(b.totalCents)}</td>
              </tr>
            </tbody>
          </table>
        </Fold>
        <Fold title={t`Paiements`} count={detail.payments.length ? t`${detail.payments.filter((p) => p.status === "succeeded").length} reçu(s)` : t`aucun`}>
          {detail.payments.length === 0 ? (
            <p className="muted">{t`Aucun paiement reçu.`}</p>
          ) : (
            <table className="tbl dense mini">
              <thead>
                <tr>
                  <th scope="col">{t`Date`}</th>
                  <th scope="col">{t`Type`}</th>
                  <th scope="col">{t`Moyen`}</th>
                  <th scope="col" className="r">
                    {t`Montant`}
                  </th>
                  <th scope="col">{t`État`}</th>
                </tr>
              </thead>
              <tbody>
                {detail.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{shortIso((p.receivedAt ?? p.createdAt).slice(0, 10))}</td>
                    <td>{payKindLabel(p.kind)}</td>
                    <td>{methodLabel(p.method)}</td>
                    <td className="r">{eur(p.amountCents)}</td>
                    <td>
                      <span className={`pill ${p.status === "succeeded" ? "soldee" : p.status === "pending" ? "option" : "muted-pill"}`}>
                        {p.status === "succeeded" ? t`reçu` : p.status === "pending" ? t`en attente` : t`n'a pas abouti`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Fold>
        <Fold title={t`Notes internes`} count={b.internalNotes ? "1" : "0"}>
          <p className="note">{b.internalNotes || t`Aucune note.`}</p>
        </Fold>
        <Fold title={t`Mails envoyés`} count={String(detail.emails.length)}>
          {detail.emails.length === 0 ? (
            <p className="muted">{t`Aucun mail pour l'instant.`}</p>
          ) : (
            <table className="tbl dense mini">
              <thead>
                <tr>
                  <th scope="col">{t`Envoyé le`}</th>
                  <th scope="col">{t`Objet`}</th>
                  <th scope="col">{t`Destinataire`}</th>
                  <th scope="col">{t`État`}</th>
                </tr>
              </thead>
              <tbody>
                {[...detail.emails]
                  .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
                  .map((m) => (
                    <tr key={m.id}>
                      <td>{sqlWhen(m.createdAt)}</td>
                      <td>
                        {m.subject}
                        {m.attachments && m.attachments.length > 0 ? <small>{t`Pièce jointe :`} {m.attachments.map((a) => a.filename).join(", ")}</small> : null}
                      </td>
                      <td>{m.toEmail ?? ""}</td>
                      <td>
                        <span className={`pill ${m.status === "sent" ? "soldee" : m.status === "failed" ? "annulee" : "muted-pill"}`}>
                          {m.status === "sent" ? t`parti` : m.status === "failed" ? t`pas parti` : m.status === "stub" ? t`préparé (envoi coupé)` : m.status}
                        </span>
                        {m.errorDetail ? <small>{m.errorDetail}</small> : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Fold>
        <Fold title={t`Historique`} count={String(detail.history.length + 1)}>
          <table className="tbl dense mini">
            <tbody>
              {[...detail.history]
                .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
                .map((h) => (
                  <tr key={h.id}>
                    <td>{sqlWhen(h.createdAt)}</td>
                    <td>{historyLabel(h.action)}</td>
                    <td className="muted">{historyWho(h)}</td>
                  </tr>
                ))}
              <tr>
                <td>{sqlWhen(b.createdAt)}</td>
                <td>{t`réservation enregistrée`}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </Fold>
        <Fold title={t`Voyageurs inscrits`} count={t`registre`}>
          <RegisterSection b={b} />
        </Fold>
      </div>

      <PayDialog open={dialog === "pay"} b={b} balance={balance} onClose={() => setDialog(null)} />
      <WriteDialog open={dialog === "write"} b={b} guest={guest} times={times} onClose={() => setDialog(null)} />
      <CancelDialog open={dialog === "cancel"} b={b} onClose={() => setDialog(null)} />
      <EditDialog open={dialog === "edit"} b={b} onClose={() => setDialog(null)} />
      <NotesDialog open={dialog === "notes"} b={b} onClose={() => setDialog(null)} />
      <LinkDialog open={dialog === "link"} b={b} balance={balance} onClose={() => setDialog(null)} />
    </>
  );
}

/** Section de la fiche, ouverte d'office : tout ce que l'ancien écran
 *  montrait reste visible sans clic (retour de Julien du 10/10). */
function Fold({ title, count, children }: { title: string; count: string; children: ReactNode }) {
  return (
    <details className="fold" open>
      <summary>
        <IconChevronRight size={22} />
        {title}
        <small>{count}</small>
      </summary>
      {children}
    </details>
  );
}

const METHODS: Record<string, MessageDescriptor> = { transfer: msg`virement`, cash: msg`espèces`, stripe: msg`carte bancaire`, other: msg`autre moyen` };
function payKindLabel(k: string): string {
  if (k === "deposit") return i18n._(msg`arrhes`);
  if (k === "balance") return i18n._(msg`solde`);
  if (k === "refund") return i18n._(msg`remboursement`);
  if (k === "full") return i18n._(msg`paiement complet`);
  if (k === "manual") return i18n._(msg`paiement manuel`);
  return k;
}

/** « 2026-10-10 » → « 10/10/2026 ». */
function shortIso(d: string): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

/** Qui a fait le geste : le « par » du détail s'il existe, sinon l'acteur. */
function historyWho(h: AuditEntry): string {
  try {
    const par = h.detail ? (JSON.parse(h.detail) as { par?: string }).par : null;
    if (par) return par;
  } catch {
    /* détail non JSON : l'acteur */
  }
  return h.actor === "admin" ? "" : h.actor;
}

function methodLabel(m: string): string {
  const d = METHODS[m];
  return d ? i18n._(d) : m;
}

const HISTORY: Record<string, MessageDescriptor> = {
  "booking.create_manual": msg`réservation prise par téléphone`,
  "booking.confirm_manual": msg`réservation confirmée`,
  "booking.confirm_conflict": msg`confirmation refusée : dates reprises entre-temps`,
  "booking.cancel": msg`réservation annulée`,
  "booking.modify": msg`séjour modifié`,
  "booking.modify_guest": msg`coordonnées du client modifiées`,
  "booking.modify_conflict": msg`modification refusée : dates déjà prises`,
  "payment.manual": msg`paiement noté à la main`,
  "email.balance_reminder": msg`rappel du solde envoyé`,
  "email.voucher_resent": msg`confirmation renvoyée au client`,
  "email.confirmation_resent": msg`confirmation et conditions générales renvoyées au client`,
  "message.reply": msg`message envoyé au client`,
};
function historyLabel(action: string): string {
  const d = HISTORY[action];
  if (d) return i18n._(d);
  return action.startsWith("stripe") || action.startsWith("payment") ? i18n._(msg`paiement en ligne`) : action.startsWith("email") ? i18n._(msg`mail`) : i18n._(msg`autre changement`);
}

// --- actions principales ---------------------------------------------------------

function MainActions({ b, state, balance, setDialog }: { b: Booking; state: BookingState; balance: number; setDialog: (d: Dialog) => void }) {
  const { t } = useLingui();
  const confirm = useAction();
  const remind = useAction();
  const voucher = useAction();
  const confirmationPdf = useAction();
  const err = [confirm, remind, voucher, confirmationPdf].find((a) => a.state.status === "error")?.state;
  const btn = (key: string, icon: ReactNode, label: string, onClick: () => void, pri = false, a?: ReturnType<typeof useAction>) => (
    <button
      key={key}
      type="button"
      className={`btn${pri ? " pri" : ""}${a?.state.status === "done" ? " done" : ""}`}
      onClick={onClick}
      disabled={a?.state.status === "busy"}
      aria-busy={a?.state.status === "busy"}
    >
      {a?.state.status === "done" ? <IconCheck size={22} /> : icon}
      {a?.state.status === "busy" ? t`Un instant…` : a?.state.status === "done" ? t`C'est fait` : label}
    </button>
  );
  const write = btn("write", <IconMessage size={22} />, t`Écrire`, () => setDialog("write"));
  let acts: ReactNode[];
  if (state === "option") {
    acts = [
      btn("confirm", <IconCheck size={22} />, t`Confirmer`, () => void confirm.run(() => api(`/bookings/${b.id}/confirm`, { method: "POST", body: { sendVoucher: true } }), t`C'est fait. Réservation confirmée, la confirmation part au client.`), true, confirm),
      btn("link", <IconSend size={22} />, t`Lien de paiement`, () => setDialog("link")),
      write,
    ];
  } else if (state === "solde") {
    acts = [
      btn("pay", <IconCurrencyEuro size={22} />, t`Encaisser le solde`, () => setDialog("pay"), true),
      btn("remind", <IconSend size={22} />, t`Envoyer un rappel`, () => void remind.run(() => api(`/bookings/${b.id}/balance-reminder`, { method: "POST" }), t`C'est fait. Rappel du solde (${eur(balance)}) envoyé.`), false, remind),
      write,
    ];
  } else if (state === "plat") {
    acts = [
      write,
      btn("notes", <IconPencil size={22} />, t`Ajouter une note`, () => setDialog("notes")),
    ];
  } else {
    acts = [
      write,
      btn("voucher", <IconSend size={22} />, t`Renvoyer la confirmation`, () => void voucher.run(() => api(`/bookings/${b.id}/resend-confirmation`, { method: "POST" }), t`C'est fait. Confirmation et conditions générales renvoyées au client.`), false, voucher),
      btn("confirmation-pdf", <IconFileText size={22} />, t`Confirmation PDF`, () => void confirmationPdf.run(() => openAdminPdf(`/bookings/${b.id}/confirmation.pdf`), t`Confirmation ouverte dans un nouvel onglet.`), false, confirmationPdf),
      btn("edit", <IconCalendar size={22} />, t`Modifier`, () => setDialog("edit")),
    ];
  }
  return (
    <>
      <div className="main-acts" style={acts.length === 2 || acts.length === 4 ? { gridTemplateColumns: "1fr 1fr" } : undefined}>
        {acts}
      </div>
      {state === "plat" ? <p className="muted" style={{ fontSize: 15 }}>{t`Les dates, l'annulation et le paiement de cette réservation se gèrent sur ${channelName(b)} : la grille suivra.`}</p> : null}
      {err && err.status === "error" ? <ErrorLine text={err.text} /> : null}
    </>
  );
}

function MoreMenu({ b, setDialog }: { b: Booking; setDialog: (d: Dialog) => void }) {
  const { t } = useLingui();
  const voucher = useAction();
  const confirmationPdf = useAction();
  return (
    <div className="more">
      <Menu width="target" position="bottom" shadow="md">
        <Menu.Target>
          <button type="button" className="btn wide">
            <IconDots size={22} />
            <Trans>Plus</Trans>
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          {!isChannel(b) ? (
            <Menu.Item style={{ minHeight: 44 }} onClick={() => setDialog("link")}>
              <Trans>Envoyer un lien de paiement</Trans>
            </Menu.Item>
          ) : null}
          {!isChannel(b) ? (
            <Menu.Item style={{ minHeight: 44 }} onClick={() => setDialog("pay")}>
              <Trans>Noter un paiement reçu</Trans>
            </Menu.Item>
          ) : null}
          <Menu.Item
            style={{ minHeight: 44 }}
            onClick={() => void voucher.run(() => api(`/bookings/${b.id}/resend-confirmation`, { method: "POST" }), t`C'est fait. Confirmation et conditions générales renvoyées au client.`)}
          >
            <Trans>Renvoyer la confirmation au client</Trans>
          </Menu.Item>
          <Menu.Item style={{ minHeight: 44 }} onClick={() => void confirmationPdf.run(() => openAdminPdf(`/bookings/${b.id}/confirmation.pdf`), t`Confirmation ouverte dans un nouvel onglet.`)}>
            <Trans>Confirmation et conditions générales (PDF)</Trans>
          </Menu.Item>
          {!isChannel(b) ? (
            <Menu.Item style={{ minHeight: 44 }} onClick={() => setDialog("edit")}>
              <Trans>Changer les dates ou le nombre de voyageurs</Trans>
            </Menu.Item>
          ) : null}
          <Menu.Item style={{ minHeight: 44 }} onClick={() => setDialog("notes")}>
            <Trans>Modifier la note</Trans>
          </Menu.Item>
          {!isChannel(b) ? <Menu.Divider /> : null}
          {!isChannel(b) ? (
            <Menu.Item style={{ minHeight: 44 }} color="red" onClick={() => setDialog("cancel")}>
              <Trans>Annuler la réservation</Trans>
            </Menu.Item>
          ) : null}
        </Menu.Dropdown>
      </Menu>
      {voucher.state.status === "error" ? <ErrorLine text={voucher.state.text} /> : null}
      {confirmationPdf.state.status === "error" ? <ErrorLine text={confirmationPdf.state.text} /> : null}
    </div>
  );
}

// --- boîtes de saisie (jamais fermées au clic à côté) --------------------------------

function Box({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const layout = useLayout();
  return (
    <Modal opened={open} onClose={onClose} title={<b style={{ fontSize: 20 }}>{title}</b>} closeOnClickOutside={false} closeOnEscape={false} centered fullScreen={layout === "B"} size="lg" zIndex={400}>
      {children}
    </Modal>
  );
}

function PayDialog({ open, b, balance, onClose }: { open: boolean; b: Booking; balance: number; onClose: () => void }) {
  const { t } = useLingui();
  const a = useAction();
  const [amount, setAmount] = useState<number | string>(balance / 100);
  const [method, setMethod] = useState<string | null>("transfer");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) {
      setAmount(balance / 100);
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balance]);
  const cents = Math.round(Number(amount) * 100);
  return (
    <Box open={open} onClose={onClose} title={t`Encaisser un paiement`}>
      <p className="lead">{t`Reste à payer : ${eur(balance)}. Indiquez ce que vous avez reçu.`}</p>
      <div className="grid2">
        <NumberInput label={t`Montant reçu (€)`} size="md" min={0.01} decimalScale={2} decimalSeparator="," value={amount} onChange={setAmount} />
        <Select
          label={t`Reçu par`}
          size="md"
          allowDeselect={false}
          value={method}
          onChange={setMethod}
          data={[
            { value: "transfer", label: t`Virement` },
            { value: "cash", label: t`Espèces` },
            { value: "other", label: t`Autre moyen` },
          ]}
        />
      </div>
      {cents > balance && balance > 0 ? (
        <p className="late" style={{ color: "var(--danger)", fontWeight: 600, margin: "8px 0 0" }}>{t`C'est plus que le solde (${eur(balance)}). Vérifiez le montant avant de le noter.`}</p>
      ) : null}
      <TextInput mt="sm" size="md" label={t`Note (facultatif)`} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={a.state.status === "busy" || !(cents > 0)}
          onClick={async () => {
            const ok = await a.run(
              () => api(`/bookings/${b.id}/payments`, { method: "POST", body: { amountCents: cents, method, kind: cents >= balance ? "balance" : "manual", note } }),
              t`C'est fait. ${eur(cents)} encaissés.`,
            );
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Noter ${eur(cents > 0 ? cents : 0)} reçus`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

function LinkDialog({ open, b, balance, onClose }: { open: boolean; b: Booking; balance: number; onClose: () => void }) {
  const { t } = useLingui();
  const toast = useToast();
  const a = useAction();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setUrl(null);
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pending = b.status === "pending";
  const amount = pending ? Math.max(0, b.depositCents - b.paidCents) : balance;
  return (
    <Box open={open} onClose={onClose} title={pending ? t`Lien de paiement des arrhes` : t`Lien de paiement du solde`}>
      <p className="lead">{t`Le client paie ${eur(amount)} par carte depuis ce lien. Copiez-le pour l'envoyer par SMS ou par mail.`}</p>
      {url ? (
        <div className="ok-line" style={{ overflowWrap: "anywhere" }}>
          <IconCheck size={20} />
          <span>{url}</span>
        </div>
      ) : null}
      <div className="acts" style={{ marginTop: 16 }}>
        {url ? (
          <button
            type="button"
            className="btn pri"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast(t`Lien copié.`);
                onClose();
              } catch {
                toast(t`Le lien n'a pas pu être copié : sélectionnez-le et copiez-le à la main.`, true);
              }
            }}
          >
            <IconCopy size={20} />
            <Trans>Copier le lien et fermer</Trans>
          </button>
        ) : (
          <button
            type="button"
            className="btn pri"
            disabled={a.state.status === "busy" || amount < 50}
            onClick={() =>
              void a.run(async () => {
                const r = await api<{ url: string }>(`/bookings/${b.id}/payment-link`, { method: "POST", body: { amountCents: amount, kind: pending ? "deposit" : "balance" } });
                setUrl(r.url);
                return r;
              }, t`C'est fait. Lien de paiement prêt.`)
            }
          >
            {a.state.status === "busy" ? t`Un instant…` : t`Créer le lien`}
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Fermer</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

function WriteDialog({ open, b, guest, times, onClose }: { open: boolean; b: Booking; guest: Guest | undefined; times: { checkinTime: string; checkoutTime: string } | undefined; onClose: () => void }) {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const a = useAction();
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) {
      setText("");
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const balance = b.totalCents - b.paidCents;
  const ctx = {
    firstName: guest?.firstName ?? "",
    unitName: b.unitName ?? "",
    arrival: longDate(b.checkin),
    checkinTime: hourLabel(times?.checkinTime ?? "16:00"),
    checkoutTime: hourLabel(times?.checkoutTime ?? "10:00"),
    balance: balance > 0 && !isChannel(b) ? eur(balance) : null,
    signature: properties.find((p) => p.id === b.propertyId)?.name ?? "",
  };
  const email = b.guestEmail ?? guest?.email;
  return (
    <Box open={open} onClose={onClose} title={t`Écrire à ${b.guestName ?? t`ce client`}`}>
      {open ? <TemplateChips propertyId={b.propertyId} ctx={ctx} onPick={setText} labelId="tpl-w" /> : null}
      <Textarea mt="md" label={t`Votre message`} autosize minRows={8} size="md" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      <div className="send">
        <p>{email ? t`Le message s'affiche sur la page du client et part par mail à ${email} quand l'envoi des mails est actif.` : t`Pas de mail sur cette réservation : le message s'affichera seulement sur la page du client.`}</p>
        <button
          type="button"
          className="btn pri"
          disabled={a.state.status === "busy" || text.trim().length < 2}
          onClick={async () => {
            const ok = await a.run(
              () => api<{ delivery: string }>(`/bookings/${b.id}/messages`, { method: "POST", body: { body: text } }),
              (r) => deliveryText((r as { delivery?: string }).delivery),
            );
            if (ok) onClose();
          }}
        >
          <IconSend size={20} />
          {a.state.status === "busy" ? t`Un instant…` : t`Envoyer`}
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={t`Pas envoyé. ${a.state.text} Votre texte est gardé.`} /> : null}
    </Box>
  );
}

interface CancelPlan {
  mode: "canal" | "sans_paiement" | "arrhes";
  par: "locataire" | "proprietaire";
  paidCents: number;
  keptCents: number;
  refundCents: number;
  stripeRefundCents: number;
  manualRefundCents: number;
  indemnityCents: number;
  note: string;
}

interface CancelResult {
  plan: CancelPlan;
  refunds: { status: string }[];
}

function CancelDialog({ open, b, onClose }: { open: boolean; b: Booking; onClose: () => void }) {
  const { t } = useLingui();
  const a = useAction();
  const [reason, setReason] = useState("");
  const [par, setPar] = useState<"locataire" | "proprietaire">("locataire");
  useEffect(() => {
    if (open) {
      setReason("");
      setPar("locataire");
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Le plan vient du serveur (simulation, rien n'est fait) : l'écran n'invente aucun montant.
  const planQuery = useQuery({
    queryKey: ["cancel-plan", b.id, par, b.paidCents],
    queryFn: () => api<{ plan: CancelPlan }>(`/bookings/${b.id}/cancel`, { method: "POST", body: { par, simuler: true } }).then((r) => r.plan),
    enabled: open && b.status !== "cancelled",
    staleTime: 0,
  });
  const plan = planQuery.data;
  const moves = plan != null && plan.mode === "arrhes";
  return (
    <Box open={open} onClose={onClose} title={t`Annuler la réservation ${b.reference}`}>
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
        <legend className="lead" style={{ marginBottom: 6 }}>
          <Trans>Qui annule ?</Trans>
        </legend>
        <label style={{ display: "block", marginBottom: 4 }}>
          <input type="radio" name="cancel-par" checked={par === "locataire"} onChange={() => setPar("locataire")} /> <Trans>Le client</Trans>
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="cancel-par" checked={par === "proprietaire"} onChange={() => setPar("proprietaire")} /> <Trans>L'exploitant</Trans>
        </label>
      </fieldset>
      {plan == null ? (
        <p className="lead">{planQuery.isError ? t`Le calcul du remboursement a échoué. Réessayez.` : t`Calcul du remboursement…`}</p>
      ) : moves ? (
        <div className="lead" data-testid="cancel-plan">
          {plan.par === "locataire" ? <p>{t`Arrhes conservées : ${eur(plan.keptCents)}`}</p> : null}
          <p>{t`Remboursement : ${eur(plan.refundCents)}`}</p>
          {plan.manualRefundCents > 0 ? <p>{t`Dont ${eur(plan.manualRefundCents)} à rendre à la main (hors Stripe).`}</p> : null}
          {plan.indemnityCents > 0 ? <p>{t`Indemnité : ${eur(plan.indemnityCents)} (égale aux arrhes) à virer à la main. Le mail demande son IBAN au client.`}</p> : null}
          <p>{plan.par === "locataire" ? t`Les arrhes restent acquises, le solde payé est rendu sous 14 jours sur le moyen de paiement utilisé.` : t`Tout ce qui a été payé est rendu sous 14 jours sur le moyen de paiement utilisé.`}</p>
          <p>{t`Le client en est prévenu par mail.`}</p>
        </div>
      ) : (
        <p className="lead">
          {plan.mode === "canal" ? plan.note : t`Rien n'a été payé : rien à rembourser. L'annulation libère les dates tout de suite, ici et sur Airbnb et Booking.`}
        </p>
      )}
      <Textarea label={t`Motif de l'annulation`} description={t`Il reste dans l'historique de la réservation.`} autosize minRows={3} size="md" value={reason} onChange={(e) => setReason(e.currentTarget.value)} required />
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
          disabled={a.state.status === "busy" || reason.trim().length < 3 || plan == null}
          onClick={async () => {
            const ok = await a.run(
              () => api<CancelResult>(`/bookings/${b.id}/cancel`, { method: "POST", body: { reason: reason.trim(), par, confirmer: true } }),
              (r) => {
                const res = r as CancelResult;
                return res.refunds.some((x) => x.status === "failed")
                  ? t`Réservation annulée, mais un remboursement Stripe a échoué : il est à rejouer.`
                  : t`C'est fait. Réservation annulée, les dates sont libres.`;
              },
            );
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Annuler la réservation`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Garder la réservation</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

function EditDialog({ open, b, onClose }: { open: boolean; b: Booking; onClose: () => void }) {
  const { t } = useLingui();
  const a = useAction();
  const [checkin, setCheckin] = useState(b.checkin);
  const [checkout, setCheckout] = useState(b.checkout);
  const [adults, setAdults] = useState<number | string>(b.adults);
  const [children, setChildren] = useState<number | string>(b.children);
  useEffect(() => {
    if (open) {
      setCheckin(b.checkin);
      setCheckout(b.checkout);
      setAdults(b.adults);
      setChildren(b.children);
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = checkin < checkout;
  const quote = useQuery({
    queryKey: ["quote-edit", b.id, b.unitId, checkin, checkout, adults, children],
    queryFn: () => api<QuoteResponse>("/quote", { method: "POST", body: { unitId: b.unitId, checkin, checkout, adults: Number(adults), children: Number(children), bookingId: b.id } }),
    enabled: open && valid && !isChannel(b),
  });
  const qd = quote.data;
  return (
    <Box open={open} onClose={onClose} title={t`Changer le séjour`}>
      {isChannel(b) ? (
        <p className="lead">{t`Cette réservation vient de ${channelName(b)} : changez aussi les dates là-bas, sinon elles reviendront.`}</p>
      ) : null}
      <div className="grid2">
        <TextInput type="date" size="md" label={t`Arrivée`} value={checkin} onChange={(e) => setCheckin(e.currentTarget.value)} />
        <TextInput type="date" size="md" label={t`Départ`} value={checkout} onChange={(e) => setCheckout(e.currentTarget.value)} />
        <NumberInput size="md" label={t`Adultes`} min={1} value={adults} onChange={setAdults} />
        <NumberInput size="md" label={t`Enfants`} min={0} value={children} onChange={setChildren} />
      </div>
      {!valid ? <ErrorLine text={t`Le départ doit venir après l'arrivée.`} /> : null}
      {qd && !qd.availability.available ? <ErrorLine text={t`Ces nuits sont déjà prises.`} /> : null}
      {qd && qd.quote.ok ? (
        <p className="lead" style={{ marginTop: 12 }}>
          {t`Prix des nuits sur ces dates : ${eur(qd.quote.totalCents)}, hors options déjà vendues (déjà payé : ${eur(b.paidCents)}). Le total exact s'affiche après l'enregistrement.`}
        </p>
      ) : null}
      {qd && !qd.quote.ok ? <ErrorLine text={t`Au moins ${qd.quote.minNights} nuits sur ces dates.`} /> : null}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={a.state.status === "busy" || !valid}
          onClick={async () => {
            const ok = await a.run(
              () => api(`/bookings/${b.id}`, { method: "PATCH", body: { checkin, checkout, adults: Number(adults), children: Number(children) } }),
              (r) => {
                const x = r as { booking?: Booking; balanceCents?: number; refundCents?: number };
                const total = x.booking ? eur(x.booking.totalCents) : "";
                if (x.refundCents) return t`C'est fait. Séjour modifié : nouveau total ${total}, ${eur(x.refundCents)} à rembourser à la main.`;
                return t`C'est fait. Séjour modifié : nouveau total ${total}${x.balanceCents ? t`, ${eur(x.balanceCents)} restent à payer` : ""}.`;
              },
            );
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer le changement`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

function NotesDialog({ open, b, onClose }: { open: boolean; b: Booking; onClose: () => void }) {
  const { t } = useLingui();
  const a = useAction();
  const [text, setText] = useState(b.internalNotes ?? "");
  useEffect(() => {
    if (open) {
      setText(b.internalNotes ?? "");
      a.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Box open={open} onClose={onClose} title={t`Note sur la réservation`}>
      <Textarea label={t`Note (le client ne la voit pas)`} autosize minRows={4} size="md" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={a.state.status === "busy"}
          onClick={async () => {
            const ok = await a.run(() => api(`/bookings/${b.id}`, { method: "PATCH", body: { internalNotes: text } }), t`C'est fait. Note enregistrée.`);
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer la note`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

/** Ce qui est vraiment parti : un message est toujours visible sur la page du
 *  client ; le mail ne part que si l'envoi est actif. */
export function deliveryText(delivery: string | undefined, linked = true): string {
  if (linked) {
    if (delivery === "sent") return i18n._(msg`C'est fait. Message envoyé par mail et enregistré sur la page du client.`);
    if (delivery === "stub") return i18n._(msg`C'est fait. Message enregistré sur la page du client ; le mail n'est pas parti (envoi des mails coupé ici).`);
    return i18n._(msg`C'est fait. Message enregistré sur la page du client ; pas de mail connu pour l'envoyer.`);
  }
  if (delivery === "sent") return i18n._(msg`C'est fait. Message envoyé par mail et enregistré dans la conversation.`);
  if (delivery === "stub") return i18n._(msg`C'est fait. Message enregistré dans la conversation ; le mail n'est pas parti (envoi des mails coupé ici).`);
  return i18n._(msg`C'est fait. Message enregistré dans la conversation ; pas de mail connu pour l'envoyer.`);
}
