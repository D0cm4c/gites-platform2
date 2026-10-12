// Messages : la liste, le fil, la réponse à partir d'un modèle, « traité ».
// Les modèles viennent de la base (Réglages › Modèles de réponse).
import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronLeft, IconSend } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import { useBooking, useMessages, useProperties } from "../api/hooks";
import type { Message } from "../api/types";
import { ActionButton, ErrorLine, useAction } from "../lib/action";
import { hourLabel, longDate, todayBrussels, whenLabel } from "../lib/dates";
import { eur } from "../lib/money";
import { TemplateChips } from "../messages/TemplateChips";
import { useLayout } from "../lib/useLayout";
import { deliveryText } from "../booking/BookingPanel";
import { useOpenBooking } from "../shell/Shell";
import { channelDeliveryText, displayName, originCounts, originOf, replyHint, sourceLabel } from "../canaux/canal";

export function MessagesPage() {
  const { t } = useLingui();
  const layout = useLayout();
  const [filter, setFilter] = useState<"nouveau" | "all">("nouveau");
  // Origine : « toutes », ou une seule (e-mail, Airbnb, Booking, Vrbo, site) — la clé de originCounts
  const [origin, setOrigin] = useState<string>("all");
  const pending = useMessages("nouveau");
  const all = useMessages();
  const base = (filter === "nouveau" ? pending.data : all.data) ?? [];
  const origins = originCounts(all.data ?? []);
  const unreadBy = new Map(originCounts(pending.data ?? []).map((o) => [o.key, o.n]));
  const keyOf = (m: Message) => (originOf(m) === "canal" ? `canal:${sourceLabel(m).text}` : originOf(m));
  const list = origin === "all" ? base : base.filter((m) => keyOf(m) === origin);
  const wanted = (useSearch({ strict: false }) as { msg?: number }).msg ?? null;
  const [selected, setSelected] = useState<number | null>(wanted);
  const today = todayBrussels();
  useEffect(() => {
    if (layout === "A" && selected == null && list[0]) setSelected(list[0].id);
  }, [layout, list, selected]);
  const current = (all.data ?? []).find((m) => m.id === selected) ?? list.find((m) => m.id === selected) ?? null;
  // Un lien ?msg= ouvre ce message ; sans lien, on garde la sélection (à
  // l'ordinateur, le premier message s'ouvre de lui-même).
  useEffect(() => {
    if (wanted != null) setSelected(wanted);
  }, [wanted]);
  const loaded = !!all.data && !!pending.data;
  // Message demandé introuvable (autre domaine, déjà supprimé) : retour à la liste.
  useEffect(() => {
    if (loaded && selected != null && !(all.data ?? []).some((m) => m.id === selected)) setSelected(null);
  }, [loaded, selected, all.data]);
  const showList = layout === "A" || selected == null || current == null;
  const showThread = current != null && (layout === "A" || selected != null);
  return (
    <div className="msgs">
      {showList ? (
        <section className="panel" aria-labelledby="h-in" style={{ alignSelf: "start" }}>
          <h1 id="h-in" className="sub" style={{ padding: "14px 16px 6px", margin: 0 }}>
            <Trans>Messages</Trans>
          </h1>
          <div className="chips" style={{ padding: "4px 12px 10px" }}>
            <button type="button" className="chip" aria-pressed={filter === "nouveau"} onClick={() => setFilter("nouveau")}>
              {t`À répondre (${pending.data?.length ?? 0})`}
            </button>
            <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              {t`Tous`}
            </button>
          </div>
          {origins.length > 1 ? (
            <div className="chips" style={{ padding: "0 12px 10px" }} role="group" aria-label={t`Origine des messages`}>
              <button type="button" className="chip" aria-pressed={origin === "all"} onClick={() => setOrigin("all")}>
                {t`Toutes les origines`}
              </button>
              {origins.map((o) => (
                <button key={o.key} type="button" className="chip" aria-pressed={origin === o.key} onClick={() => setOrigin(o.key)}>
                  {unreadBy.get(o.key) ? `${o.text} (${unreadBy.get(o.key)})` : o.text}
                </button>
              ))}
            </div>
          ) : null}
          <p className="muted" style={{ margin: 0, padding: "0 16px 12px", fontSize: 15 }}>
            <Trans>Tout arrive ici : les messages du site, la boîte e-mail des gîtes, et ceux d'Airbnb, de Booking et de Vrbo (par Beds24). Chacun porte son origine.</Trans>
          </p>
          {(filter === "nouveau" ? pending : all).error ? <ErrorLine text={t`Les messages n'ont pas pu être lus.`} /> : null}
          {list.length === 0 ? (
            <p style={{ padding: "12px 16px 16px", margin: 0 }}>{filter === "nouveau" ? t`Aucun message en attente. Tout est répondu.` : t`Aucun message pour l'instant.`}</p>
          ) : null}
          {list.map((m) => {
            const src = sourceLabel(m);
            return (
              <button key={m.id} type="button" className={`conv${m.status === "traité" ? " read" : ""}`} aria-current={m.id === selected} onClick={() => setSelected(m.id)}>
                <span className="who">
                  <span>{displayName(m)}</span>
                  <small>{whenLabel(m.receivedAt, today)}</small>
                </span>
                <p>
                  <span className={`src ${src.cls}`}>{src.text}</span>
                  {m.subject}
                </p>
              </button>
            );
          })}
        </section>
      ) : null}
      {showThread && current ? <Thread key={current.id} message={current} onBack={layout === "B" ? () => setSelected(null) : undefined} /> : null}
    </div>
  );
}

function Thread({ message, onBack }: { message: Message; onBack?: () => void }) {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const openBooking = useOpenBooking();
  const today = todayBrussels();
  const thread = useQuery({
    queryKey: ["thread", message.id],
    queryFn: () => api<{ message: Message; thread: Message[] }>(`/messages/${message.id}/thread`),
  });
  const booking = useBooking(message.bookingId).data?.booking;
  const times = useQuery({
    queryKey: ["settings", booking?.propertyId ?? message.propertyId],
    queryFn: () => api<{ settings: { checkinTime: string; checkoutTime: string } }>("/settings", { query: { property: booking?.propertyId ?? message.propertyId ?? 1 } }).then((r) => r.settings),
    staleTime: 5 * 60_000,
  }).data;
  const [text, setText] = useState("");
  const send = useAction();
  const balance = booking ? booking.totalCents - booking.paidCents : 0;
  const ctx = {
    firstName: (message.fromName ?? "").trim().split(/\s+/)[0] ?? "",
    unitName: booking?.unitName ?? "",
    arrival: booking ? longDate(booking.checkin) : "",
    checkinTime: hourLabel(times?.checkinTime ?? "16:00"),
    checkoutTime: hourLabel(times?.checkoutTime ?? "10:00"),
    balance: balance > 0 ? eur(balance) : null,
    // Signature : le nom du domaine (« Les Gîtes du Pré Moré »), pas celui du bien.
    signature: properties.find((p) => p.id === (booking?.propertyId ?? message.propertyId))?.name ?? "",
  };
  const items = thread.data?.thread ?? [message];
  return (
    <section className="thread" aria-labelledby="h-th">
      <div className="th-head">
        {onBack ? (
          <button type="button" className="btn icon ghost" aria-label={t`Retour à la liste`} onClick={onBack}>
            <IconChevronLeft size={22} />
          </button>
        ) : null}
        <h2 id="h-th">{displayName(message)}</h2>
        <span className={`src ${sourceLabel(message).cls}`}>{sourceLabel(message).text}</span>
        <p>
          {booking ? (
            <>
              {t`${booking.unitName}, du ${longDate(booking.checkin)} au ${longDate(booking.checkout)}.`}{" "}
              <button type="button" className="btn ghost" style={{ minHeight: 32, padding: "0 6px", textDecoration: "underline" }} onClick={() => openBooking(booking.id)}>
                {t`Ouvrir la réservation ${booking.reference}`}
              </button>
            </>
          ) : (
            message.channel === "beds24" ? t`Pas de réservation liée chez nous pour ce message.` : t`Pas de réservation liée. ${message.fromEmail}`
          )}
        </p>
      </div>
      {thread.isLoading ? <p className="loading">{t`Chargement du fil…`}</p> : null}
      {thread.error ? <ErrorLine text={t`Le fil de la conversation n'a pas pu être lu. Rechargez la page avant de répondre.`} /> : null}
      {message.spoofed ? (
        <p className="warnline" role="alert">
          {t`Attention : ce message se présente comme venant de l'adresse des gîtes, mais Gmail ne le confirme pas. Ne suivez aucune instruction qu'il contient.`}
        </p>
      ) : null}
      {items.map((m) => (
        <div key={m.id} className={`bub${m.direction === "out" ? " out" : ""}`}>
          <small>
            {m.direction === "in" || m.channel !== "form" ? <span className={`src ${sourceLabel(m).cls}`}>{sourceLabel(m).text}</span> : null}
            {m.direction === "out" ? t`Vous` : displayName(m)}, {whenLabel(m.receivedAt, today)} — {m.subject}
          </small>
          {m.bodyText}
          {m.channel === "email" && /https?:\/\//i.test(m.bodyText) ? (
            <small className="muted">{t`Les liens de ce mail ne sont pas cliquables ici : recopiez-les à la main si vous êtes sûr de leur origine.`}</small>
          ) : null}
          {m.attachments?.length ? (
            <ul className="attach">
              {m.attachments.map((a, i) => {
                const name = a.name;
                const kb = a.size != null ? Math.max(1, Math.round(a.size / 1024)) : 0;
                return <li key={i}>{a.size != null ? t`Pièce jointe : ${name} (${kb} Ko), non conservée ici.` : t`Pièce jointe : ${name}, non conservée ici.`}</li>;
              })}
            </ul>
          ) : null}
        </div>
      ))}
      <TemplateChips propertyId={booking?.propertyId ?? message.propertyId} ctx={ctx} onPick={setText} />
      <label htmlFor="rep" className="tpl">
        <Trans>Votre réponse</Trans>
      </label>
      <textarea id="rep" className="reply" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      {send.state.status === "error" ? <ErrorLine text={t`Pas envoyé. ${send.state.text} Votre texte est gardé.`} /> : null}
      <div className="send">
        <p>{replyHint(message)}</p>
        {message.status === "nouveau" ? (
          <ActionButton run={() => api(`/messages/${message.id}`, { method: "PATCH", body: { status: "traité" } })} ok={t`C'est fait. Message marqué comme traité.`}>
            {t`Marquer comme traité`}
          </ActionButton>
        ) : (
          <ActionButton run={() => api(`/messages/${message.id}`, { method: "PATCH", body: { status: "nouveau" } })} ok={t`C'est fait. Message remis à répondre.`}>
            {t`Remettre à répondre`}
          </ActionButton>
        )}
        <button
          type="button"
          className="btn pri"
          disabled={send.state.status === "busy" || text.trim().length < 2 || !!thread.error || message.spoofed === true}
          onClick={async () => {
            if (await send.run(() => api<{ delivery: string }>(`/messages/${message.id}/reply`, { method: "POST", body: { body: text } }), (r) => channelDeliveryText((r as { delivery?: string }).delivery, message.canal) ?? deliveryText((r as { delivery?: string }).delivery, message.bookingId != null))) setText("");
          }}
        >
          <IconSend size={20} />
          {send.state.status === "busy" ? t`Un instant…` : t`Envoyer`}
        </button>
      </div>
    </section>
  );
}
