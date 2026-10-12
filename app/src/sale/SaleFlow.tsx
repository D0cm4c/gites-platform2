// Vente par téléphone en trois étapes (plan v4, changement 6) : dates et bien,
// devis calculé tout seul (POST /quote), client et paiement (POST /bookings).
// Ouverte depuis la grille (dates déjà choisies) ou par « Nouvelle vente ».
import { Trans, useLingui } from "@lingui/react/macro";
import { Modal, NumberInput, Select, TextInput } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../api/client";
import { useScopedProperties } from "../api/hooks";
import type { Booking, IsoDate, QuoteResponse, Unit, UnitLink } from "../api/types";
import { ErrorLine, useAction } from "../lib/action";
import { addDays, diffDays, longDate, stayRange, todayBrussels } from "../lib/dates";
import { eur } from "../lib/money";
import { useToast } from "../lib/toasts";
import { useLayout } from "../lib/useLayout";

export interface SalePrefill {
  unitId?: number;
  checkin?: IsoDate;
  checkout?: IsoDate;
}

const Ctx = createContext<(p?: SalePrefill) => void>(() => {});
export function useSale() {
  return useContext(Ctx);
}

export function SaleProvider({ children }: { children: ReactNode }) {
  const [prefill, setPrefill] = useState<SalePrefill | null>(null);
  return (
    <Ctx.Provider value={(p) => setPrefill(p ?? {})}>
      {children}
      <SaleFlow prefill={prefill} onClose={() => setPrefill(null)} />
    </Ctx.Provider>
  );
}

function useAllUnits() {
  const { properties } = useScopedProperties();
  const qs = useQueries({
    queries: properties.map((p) => ({
      queryKey: ["units", p.id],
      queryFn: () => api<{ units: Unit[]; links: UnitLink[] }>("/units", { query: { property: p.id } }),
      staleTime: 60_000,
    })),
  });
  return properties.flatMap((p, i) => (qs[i]?.data?.units ?? []).filter((u) => u.active).map((u) => ({ ...u, propertyName: p.name })));
}

export function SaleFlow({ prefill, onClose }: { prefill: SalePrefill | null; onClose: () => void }) {
  const { t } = useLingui();
  const layout = useLayout();
  const navigate = useNavigate();
  const units = useAllUnits();
  const today = todayBrussels();
  const [step, setStep] = useState(1);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [checkin, setCheckin] = useState(today);
  const [checkout, setCheckout] = useState(addDays(today, 2));
  const [adults, setAdults] = useState<number | string>(2);
  const [children, setChildren] = useState<number | string>(0);
  const [promo, setPromo] = useState("");
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ booking: Booking; paymentUrl: string | null } | null>(null);
  const a = useAction();

  useEffect(() => {
    if (!prefill) return;
    setUnitId(prefill.unitId ? String(prefill.unitId) : null);
    setCheckin(prefill.checkin ?? today);
    setCheckout(prefill.checkout ?? addDays(prefill.checkin ?? today, 2));
    setStep(prefill.unitId && prefill.checkin && prefill.checkout ? 2 : 1);
    setAdults(2);
    setChildren(0);
    setPromo("");
    setLastName("");
    setFirstName("");
    setPhone("");
    setEmail("");
    setLinkError(null);
    setCreated(null);
    a.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const unit = units.find((u) => String(u.id) === unitId);
  const datesOk = checkin < checkout && checkin >= today;
  const quote = useQuery({
    queryKey: ["quote", unitId, checkin, checkout, adults, children, promo],
    queryFn: () =>
      api<QuoteResponse>("/quote", {
        method: "POST",
        body: { unitId: Number(unitId), checkin, checkout, adults: Number(adults) || 1, children: Number(children) || 0, promoCode: promo.trim() || null },
      }),
    enabled: prefill != null && !!unitId && datesOk,
  });
  const q = quote.data?.quote;
  const sellable = !!q?.ok && !!quote.data?.availability.available;
  const persons = (Number(adults) || 0) + (Number(children) || 0);
  const tooMany = unit ? persons > unit.capacityMax : false;

  const unitOptions = useMemo(() => {
    const groups = new Map<string, { value: string; label: string }[]>();
    for (const u of units) {
      const g = groups.get(u.propertyName) ?? [];
      g.push({ value: String(u.id), label: u.name });
      groups.set(u.propertyName, g);
    }
    return [...groups].map(([group, items]) => ({ group, items }));
  }, [units]);

  const reasons: string[] = [];
  if (!datesOk) reasons.push(checkin < today ? t`L'arrivée est dans le passé.` : t`Le départ doit venir après l'arrivée.`);
  if (q && !q.ok) {
    if (q.errors.includes("min_nights")) reasons.push(t`Au moins ${q.minNights} nuits sur ces dates.`);
    if (q.errors.includes("checkin_day")) reasons.push(t`Ce jour d'arrivée n'est pas autorisé sur ces dates.`);
    if (q.errors.includes("no_rate")) reasons.push(t`Aucun prix n'est fixé pour une partie de ces nuits.`);
  }
  if (quote.data && !quote.data.availability.available) reasons.push(t`Ces nuits sont déjà prises.`);
  if (tooMany && unit) reasons.push(t`${unit.name} accueille ${unit.capacityMax} personnes au plus.`);

  const nights = diffDays(checkin, checkout);
  const toast = useToast();
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t`Lien copié.`);
    } catch {
      toast(t`Le lien n'a pas pu être copié : sélectionnez-le et copiez-le à la main.`, true);
    }
  }
  const title = t`Nouvelle vente`;

  return (
    <Modal
      opened={prefill != null}
      onClose={onClose}
      title={<b style={{ fontSize: 20 }}>{title}</b>}
      closeOnClickOutside={false}
      size="lg"
      centered
      fullScreen={layout === "B"}
      zIndex={300}
    >
      <ol className="sale-steps" aria-label={t`Étapes`}>
        {[t`Dates et bien`, t`Prix`, t`Client et paiement`].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? "step" : undefined} className={step > i + 1 ? "ok" : ""}>
            <b>{step > i + 1 ? <IconCheck size={16} /> : i + 1}</b>
            {label}
          </li>
        ))}
      </ol>

      {created ? (
        <div>
          <div className="ok-line">
            <IconCheck size={20} />
            <span>{t`C'est fait. Réservation ${created.booking.reference} enregistrée.`}</span>
          </div>
          {linkError ? <ErrorLine text={linkError} /> : null}
          {created.paymentUrl ? (
            <p className="lead" style={{ marginTop: 12, overflowWrap: "anywhere" }}>
              {t`Lien vers la réservation du client :`} {created.paymentUrl}
            </p>
          ) : null}
          <div className="acts" style={{ marginTop: 16 }}>
            {created.paymentUrl ? (
              <button type="button" className="btn" onClick={() => void copy(created.paymentUrl ?? "")}>
                <Trans>Copier le lien</Trans>
              </button>
            ) : null}
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                const id = created.booking.id;
                onClose();
                void navigate({ to: ".", search: (s: object) => ({ ...s, resa: id }) });
              }}
            >
              <Trans>Ouvrir la fiche</Trans>
            </button>
          </div>
        </div>
      ) : step === 1 ? (
        <div>
          <Select
            size="md"
            label={t`Bien`}
            placeholder={t`Choisir le bien`}
            data={unitOptions}
            value={unitId}
            onChange={setUnitId}
            allowDeselect={false}
            comboboxProps={{ zIndex: 400 }}
          />
          <div className="grid2" style={{ marginTop: 12 }}>
            <TextInput type="date" size="md" label={t`Arrivée`} value={checkin} min={today} onChange={(e) => setCheckin(e.currentTarget.value)} />
            <TextInput type="date" size="md" label={t`Départ`} value={checkout} min={addDays(checkin, 1)} onChange={(e) => setCheckout(e.currentTarget.value)} />
            <NumberInput size="md" label={t`Adultes`} min={1} value={adults} onChange={setAdults} />
            <NumberInput size="md" label={t`Enfants`} min={0} value={children} onChange={setChildren} />
          </div>
          {unitId && reasons.length ? <ErrorLine text={reasons.join(" ")} /> : null}
          <div className="acts" style={{ marginTop: 16 }}>
            <button type="button" className="btn pri" disabled={!unitId || !datesOk} onClick={() => setStep(2)}>
              <Trans>Voir le prix</Trans>
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              <Trans>Annuler</Trans>
            </button>
          </div>
        </div>
      ) : step === 2 ? (
        <div>
          <p className="lead">
            <b>{unit?.name}</b>, {stayRange(checkin, checkout)}, {nights > 1 ? t`${nights} nuits` : t`1 nuit`}, {t`${persons} personnes`}.
          </p>
          {quote.isLoading ? <p className="loading">{t`Calcul du prix…`}</p> : null}
          {quote.error ? <ErrorLine text={t`Le prix n'a pas pu être calculé. Réessayez.`} /> : null}
          {q?.ok ? (
            <ul className="qlines" aria-label={t`Détail du prix`}>
              {q.lines.map((l, i) => (
                <li key={i}>
                  <span>{l.publicLabel ?? l.label}</span>
                  <span>{eur(l.amountCents)}</span>
                </li>
              ))}
              <li className="tot">
                <span>
                  <Trans>Total</Trans>
                </span>
                <span>{eur(q.totalCents)}</span>
              </li>
              {q.balanceDueDate ? (
                <li>
                  <span>{t`Arrhes à la réservation (${q.depositPct} %)`}</span>
                  <span>{eur(q.depositCents)}</span>
                </li>
              ) : null}
              {q.balanceDueDate ? (
                <li>
                  <span>{t`Solde, à payer avant le ${longDate(q.balanceDueDate)}`}</span>
                  <span>{eur(q.balanceCents)}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
          {reasons.length ? <ErrorLine text={reasons.join(" ")} /> : null}
          <TextInput size="md" label={t`Code de réduction (facultatif)`} value={promo} onChange={(e) => setPromo(e.currentTarget.value)} />
          <div className="acts" style={{ marginTop: 16 }}>
            <button type="button" className="btn pri" disabled={!sellable || tooMany} onClick={() => setStep(3)}>
              <Trans>Continuer</Trans>
            </button>
            <button type="button" className="btn" onClick={() => setStep(1)}>
              <Trans>Changer les dates</Trans>
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="grid2">
            <TextInput size="md" label={t`Nom`} required value={lastName} onChange={(e) => setLastName(e.currentTarget.value)} autoComplete="off" />
            <TextInput size="md" label={t`Prénom`} value={firstName} onChange={(e) => setFirstName(e.currentTarget.value)} autoComplete="off" />
            <TextInput size="md" type="tel" label={t`Téléphone`} value={phone} onChange={(e) => setPhone(e.currentTarget.value)} autoComplete="off" />
            <TextInput size="md" type="email" label={t`Mail`} value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="off" />
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            {t`Les dates sont gardées en option. Si le client a un mail, il reçoit un lien vers sa réservation : il y accepte les conditions générales, paie les arrhes (${q ? eur(q.depositCents) : ""}) et reçoit alors sa confirmation avec les conditions générales.`}
          </p>
          <div className="acts" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn pri"
              disabled={a.state.status === "busy" || lastName.trim().length < 2}
              onClick={() =>
                void a.run(
                  async () => {
                    const r = await api<{ booking: Booking; optionUrl: string | null; optionMailQueued: boolean }>("/bookings", {
                      method: "POST",
                      body: {
                        unitId: Number(unitId),
                        checkin,
                        checkout,
                        adults: Number(adults) || 1,
                        children: Number(children) || 0,
                        promoCode: promo.trim() || null,
                        guest: { lastName: lastName.trim(), firstName: firstName.trim(), phone: phone.trim(), email: email.trim() },
                        paymentMode: "deposit",
                      },
                    });
                    setLinkError(null);
                    const paymentUrl = r.optionUrl;
                    setCreated({ booking: r.booking, paymentUrl });
                    return r;
                  },
                  (r) => t`C'est fait. Réservation ${(r as { booking: Booking }).booking.reference} enregistrée.`,
                )
              }
            >
              {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer la réservation`}
            </button>
            <button type="button" className="btn" onClick={() => setStep(2)}>
              <Trans>Retour au prix</Trans>
            </button>
          </div>
          {lastName.trim().length < 2 ? <p className="muted">{t`Le nom du client est nécessaire.`}</p> : null}
          {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
        </div>
      )}
    </Modal>
  );
}
