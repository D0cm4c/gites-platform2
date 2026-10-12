// Plateformes › Beds24 et canaux › « Compte Beds24 relié » (PR #104, repris de
// l'ancien écran) : l'état du mapping (actif, périmé, absent), puis « Créer la
// propriété sur Beds24 » quand le compte est vide ou l'identifiant périmé. La
// confirmation montre ce qui partira ; le résultat donne la liste « à
// compléter dans Beds24 », puis « Envoyer les calendriers » (Beds24 n'a encore
// ni disponibilités ni prix). Le compte Beds24 est réel, sans bac à sable.
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { Beds24Creation, Beds24Liaison, Beds24PropertyPlan, MappingEtat } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { Confirm, Loading, Section } from "../../ui/kit";

function EtatPill({ e }: { e: MappingEtat }) {
  const { t } = useLingui();
  const [cls, label] = e === "actif" ? ["soldee", t`actif`] : e === "perime" ? ["annulee", t`identifiant périmé`] : e === "absent" ? ["option", t`non relié`] : ["muted-pill", t`inconnu`];
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function Beds24PropertyCard({ propertyId }: { propertyId: number }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["beds24-liaison", propertyId], queryFn: () => api<Beds24Liaison>("/beds24/status", { query: { property: propertyId } }) });
  const [plan, setPlan] = useState<Beds24PropertyPlan | null>(null);
  const [result, setResult] = useState<Beds24Creation | null>(null);
  const preview = useAction();
  const create = useAction();
  const push = useAction();
  const s = q.data;
  const why = s && s.mappingARefaire && !s.creationPossible
    ? !s.contenuPrepare
      ? t`textes, adresse et équipements pas encore préparés pour ce domaine`
      : !s.ecritureAutorisee
        ? t`écriture Beds24 coupée sur ce serveur (elle se fait depuis le site en ligne)`
        : s.jetonRestreint
          ? t`le jeton Beds24 est restreint à une seule propriété : générer un code d'invitation sans restriction`
          : s.ecriturePropriete === false
            ? t`le jeton Beds24 n'a pas le droit d'écrire les propriétés : générer un code d'invitation avec « properties »`
            : t`liaison inactive`
    : null;
  return (
    <Section title={t`Compte Beds24 relié`} id="h-b24-compte">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorLine text={t`L'état du compte Beds24 n'a pas pu être lu.`} /> : null}
      {s && !s.connected ? (
        <p>
          <span className="pill option">{t`Liaison inactive`}</span> {s.error ?? ""}
        </p>
      ) : null}
      {s && s.connected ? (
        <div className="panel" style={{ padding: "12px 16px" }}>
          <p style={{ margin: "0 0 8px" }}>
            {t`Compte n° ${s.compte?.id ?? "?"}`}
            {s.compte?.appareil ? t`, jeton « ${s.compte.appareil} »` : ""}
            {t`, ${s.properties?.length ?? 0} propriété(s) dans le compte.`}
          </p>
          {s.mapping ? (
            <div className="tbl-wrap" style={{ boxShadow: "none" }}>
              <table className="tbl dense">
                <caption className="sr">{t`Correspondances avec Beds24`}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t`Chez nous`}</th>
                    <th scope="col">{t`Chez Beds24`}</th>
                    <th scope="col">{t`État`}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <b>{s.mapping.propertyName}</b>
                    </td>
                    <td>{s.mapping.beds24PropertyId ? t`propriété n° ${s.mapping.beds24PropertyId}` : t`aucune propriété`}</td>
                    <td>
                      <EtatPill e={s.mapping.etat} />
                    </td>
                  </tr>
                  {s.mapping.rooms.map((r) => (
                    <tr key={r.unitId}>
                      <td>{r.unitName}</td>
                      <td>{r.beds24RoomId ? t`room n° ${r.beds24RoomId}` : "—"}</td>
                      <td>
                        <EtatPill e={r.etat} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {s.mapping?.etat === "perime" ? <p className="warn">{t`L'identifiant enregistré n'existe pas dans ce compte (ancien compte résilié) : les calendriers ne partent nulle part tant que la propriété n'est pas recréée.`}</p> : null}
          {s.ecriturePropriete === false ? <p className="warn">{t`Le code d'invitation ne semble pas autoriser l'écriture des propriétés : la création risque d'être refusée.`}</p> : null}
          {why ? <p className="muted">{t`Création de la propriété indisponible ici : ${why}.`}</p> : null}
          {s.creationPossible && !result ? (
            <div className="acts" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn pri"
                disabled={preview.state.status === "busy"}
                onClick={() =>
                  void preview.run(async () => {
                    const p = await api<Beds24PropertyPlan>("/beds24/creer-propriete/apercu", { query: { property: propertyId } });
                    setPlan(p);
                    return p;
                  }, t`Aperçu prêt : relisez ce qui sera créé.`)
                }
              >
                {preview.state.status === "busy" ? t`Un instant…` : s.contenuEnAttente ? t`Terminer l'envoi des textes sur Beds24` : t`Créer la propriété sur Beds24`}
              </button>
            </div>
          ) : null}
          {preview.state.status === "error" ? <ErrorLine text={preview.state.text} /> : null}
          {result ? <CreationResultView r={result} push={push} propertyId={propertyId} /> : null}
        </div>
      ) : null}
      <Confirm
        open={plan != null}
        title={t`Créer sur Beds24 (compte réel) ?`}
        yes={t`Créer la propriété`}
        no={t`Ne rien créer`}
        busy={create.state.status === "busy"}
        onYes={async () => {
          let r: Beds24Creation | null = null;
          const ok = await create.run(async () => {
            r = await api<Beds24Creation>("/beds24/creer-propriete", { method: "POST", body: { propertyId, confirmer: true } });
            return r;
          }, t`C'est fait. Propriété en place sur Beds24.`);
          if (ok && r) {
            setResult(r);
            setPlan(null);
            await qc.invalidateQueries({ queryKey: ["beds24-liaison", propertyId] });
          }
        }}
        onNo={() => setPlan(null)}
      >
        {plan ? <PlanView plan={plan} /> : null}
        {create.state.status === "error" ? <ErrorLine text={create.state.text} /> : null}
      </Confirm>
    </Section>
  );
}

function PlanView({ plan }: { plan: Beds24PropertyPlan }) {
  const { t } = useLingui();
  const photos = plan.rooms.reduce((n, r) => n + r.photos.length, 0);
  return (
    <div className="plan">
      <p>
        <b>{t`Propriété « ${plan.name} »`}</b>
        <br />
        {[plan.address, plan.city, plan.country].filter(Boolean).join(", ")}, {plan.currency}
        {plan.checkInStart ? t`, arrivée ${plan.checkInStart}` : ""}
        {plan.checkOutEnd ? t`, départ ${plan.checkOutEnd}` : ""}
        <br />
        {t`Description et règlement intérieur.`}
      </p>
      <p className="sub3">{t`Hébergements vendus sur les plateformes`}</p>
      <ul className="plain-list">
        {plan.rooms.map((r) => (
          <li key={r.unitId}>
            <b>{r.name}</b> : {t`${r.maxPeople} pers. max`}
            {r.minStay ? t`, ${r.minStay} nuit(s) min.` : ""}
            {r.rackRate ? t`, prix de base ${r.rackRate} ${plan.currency}` : ""}
            {r.cleaningFee ? t`, ménage ${r.cleaningFee} ${plan.currency}` : ""}
            {r.description ? t`, description` : ""}
            {r.featureCodes.length ? t`, équipements ${r.featureCodes.flat().join(" ")}` : ""}
          </li>
        ))}
      </ul>
      {plan.directOnly.length ? (
        <>
          <p className="sub3">{t`Non créés`}</p>
          <ul className="plain-list">
            {plan.directOnly.map((d) => (
              <li key={d.unitId}>
                {d.name} : {d.raison}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {photos ? <p className="muted">{t`Photos (${photos}) : l'API ne les accepte pas. La liste des adresses sera affichée pour l'import dans Beds24.`}</p> : null}
      <p className="muted">{t`Le lien enregistré chez nous sera remplacé par les nouveaux identifiants. Si une propriété du même nom existe déjà dans le compte, elle est reprise (pas de doublon).`}</p>
    </div>
  );
}

function CreationResultView({ r, push, propertyId }: { r: Beds24Creation; push: ReturnType<typeof useAction>; propertyId: number }) {
  const { t } = useLingui();
  return (
    <div className="result" style={{ marginTop: 12 }}>
      <p className="ok-line">
        {r.propriete.creee ? t`Propriété n° ${r.propriete.beds24PropertyId} créée.` : t`Propriété n° ${r.propriete.beds24PropertyId} reprise.`}{" "}
        {r.rooms.map((x) => `${x.name} → room n° ${x.beds24RoomId}${x.creee ? "" : t` (existante)`}`).join(", ")}
      </p>
      <p className="muted">{t`Envoyé : ${r.envoye.propriete.join(", ")}.`}</p>
      <ul className="plain-list">
        {r.envoye.rooms.map((x) => (
          <li key={x.name}>
            {x.name} : {x.champs.join(", ")}
          </li>
        ))}
      </ul>
      {r.contenu.ok ? null : <ErrorLine text={t`Textes et équipements refusés par Beds24 : ${r.contenu.erreur ?? ""}`} />}
      {r.avertissements.length ? <p className="muted">{r.avertissements.join(" ")}</p> : null}
      <p className="sub3">{t`À compléter dans Beds24`}</p>
      <ul className="plain-list">
        {r.aCompleter.propriete.map((pt) => (
          <li key={pt}>{pt}</li>
        ))}
        {r.aCompleter.rooms.map((x) => (
          <li key={x.unitId}>
            <b>{x.name}</b>
            <ul>
              {x.points.map((pt) => (
                <li key={pt}>{pt}</li>
              ))}
            </ul>
            {x.photos.length ? (
              <ol>
                {x.photos.map((ph) => (
                  <li key={ph.url}>
                    <span className="mono-line">{ph.url}</span> {ph.legende}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="acts" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn pri"
          disabled={push.state.status === "busy" || push.state.status === "done"}
          onClick={() =>
            void push.run(
              () => api<{ pushed: { unitName: string }[] }>("/beds24/push", { method: "POST", body: { propertyId } }),
              (x) => t`C'est fait. Calendriers envoyés : ${(x as { pushed: { unitName: string }[] }).pushed.map((p) => p.unitName).join(", ")}.`,
            )
          }
        >
          {push.state.status === "busy" ? t`Un instant…` : push.state.status === "done" ? t`Calendriers envoyés` : t`Pousser les calendriers`}
        </button>
        <span className="muted">
          <Trans>Beds24 n'a encore ni disponibilités ni prix : à pousser une fois.</Trans>
        </span>
      </div>
      {push.state.status === "error" ? <ErrorLine text={push.state.text} /> : null}
    </div>
  );
}
