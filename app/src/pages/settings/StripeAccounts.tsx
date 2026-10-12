// Réglages › Comptes Stripe : un compte Stripe par propriété (décision du 11/10/2026,
// chaque entité qui encaisse a son compte bancaire). Pour chaque propriété : les trois
// clés (champs masqués, jamais relues en clair après l'enregistrement), test ou réel,
// « Tester la clé », l'adresse du webhook à coller chez Stripe et les événements à cocher.
// Poser une clé : session humaine seulement (le serveur le vérifie).
import { Trans, useLingui } from "@lingui/react/macro";
import { PasswordInput, SegmentedControl, TextInput } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { StripeKeyState, StripeProperty, StripeSettings } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Confirm, Loading, Page, Section, sqlWhen } from "../../ui/kit";

export function StripeAccountsPage() {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["stripe-settings"], queryFn: () => api<StripeSettings>("/stripe") });
  return (
    <Page
      title={t`Comptes Stripe`}
      back
      width={900}
      lead={t`Chaque propriété encaisse sur son propre compte Stripe, donc sur son propre compte bancaire. Les clés se collent ici ; elles ne sont plus jamais réaffichées après l'enregistrement.`}
    >
      {q.error ? <ErrorLine text={t`Les comptes Stripe n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data?.properties.map((p) => <PropertyStripe key={p.propertyId} p={p} settings={q.data} />)}
    </Page>
  );
}

function StateLine({ label, k }: { label: string; k: StripeKeyState }) {
  const { t } = useLingui();
  return (
    <li>
      <b>{label}</b>{" : "}
      {k.set ? (k.hint ? t`posée le ${sqlWhen(k.setAt)} (${k.hint})` : t`posée le ${sqlWhen(k.setAt)}`) : t`pas posée`}
    </li>
  );
}

function PropertyStripe({ p, settings }: { p: StripeProperty; settings: StripeSettings }) {
  const { t } = useLingui();
  const toast = useToast();
  const [mode, setMode] = useState<"test" | "live">(p.mode);
  const [label, setLabel] = useState(p.accountLabel ?? "");
  const [secret, setSecret] = useState("");
  const [publishable, setPublishable] = useState("");
  const [webhook, setWebhook] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useAction();
  const test = useAction();
  const clear = useAction();
  const [clearing, setClearing] = useState(false);
  const webhookUrl = `${settings.baseUrl}${p.webhookPath}`;
  const dirty = secret !== "" || publishable !== "" || webhook !== "" || mode !== p.mode || label !== (p.accountLabel ?? "");
  const effective =
    p.effective === "property"
      ? t`Les clés de cette propriété sont utilisées.`
      : p.effective === "env"
        ? t`Aucune clé propre : le serveur utilise les clés de repli de son environnement.`
        : t`Aucune clé : les paiements sont simulés (aucun argent réel ne bouge).`;
  return (
    <Section
      title={p.name}
      id={`h-stripe-${p.propertyId}`}
      hint={effective}
    >
      <ul className="plain">
        <StateLine label={t`Clé secrète`} k={p.secret} />
        <StateLine label={t`Clé publiable`} k={p.publishable} />
        <StateLine label={t`Secret du webhook`} k={p.webhook} />
      </ul>

      <SegmentedControl
        value={mode}
        onChange={(v) => setMode(v === "live" ? "live" : "test")}
        data={[
          { value: "test", label: t`Test (aucun argent réel)` },
          { value: "live", label: t`Réel (vrais paiements)` },
        ]}
        aria-label={t`Mode du compte Stripe`}
      />
      <TextInput label={t`Nom du compte (pour vous y retrouver)`} value={label} onChange={(e) => setLabel(e.currentTarget.value)} maxLength={120} mt="sm" />
      <PasswordInput label={t`Clé secrète (sk_test_… ou sk_live_…)`} description={p.secret.set ? t`Laissez vide pour garder la clé actuelle.` : undefined} value={secret} onChange={(e) => setSecret(e.currentTarget.value)} autoComplete="off" spellCheck={false} mt="sm" />
      <PasswordInput label={t`Clé publiable (pk_test_… ou pk_live_…)`} description={p.publishable.set ? t`Laissez vide pour garder la clé actuelle.` : undefined} value={publishable} onChange={(e) => setPublishable(e.currentTarget.value)} autoComplete="off" spellCheck={false} mt="sm" />
      <PasswordInput label={t`Secret du webhook (whsec_…)`} description={p.webhook.set ? t`Laissez vide pour garder le secret actuel.` : undefined} value={webhook} onChange={(e) => setWebhook(e.currentTarget.value)} autoComplete="off" spellCheck={false} mt="sm" />

      {save.state.status === "error" ? <ErrorLine text={save.state.text} /> : null}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={!dirty || save.state.status === "busy"}
          onClick={async () => {
            const body: Record<string, string> = { mode, accountLabel: label };
            if (secret) body.secretKey = secret;
            if (publishable) body.publishableKey = publishable;
            if (webhook) body.webhookSecret = webhook;
            const done = await save.run(() => api(`/stripe/${p.propertyId}`, { method: "PUT", body }), t`C'est fait. Clés enregistrées.`);
            if (done) {
              setSecret("");
              setPublishable("");
              setWebhook("");
            }
          }}
        >
          {save.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={test.state.status === "busy"}
          onClick={async () => {
            setResult(null);
            await test.run(async () => {
              const r = await api<{ ok: boolean; livemode?: boolean; error?: string; warning?: string }>(`/stripe/${p.propertyId}/test`, { method: "POST" });
              setResult({
                ok: r.ok,
                text: r.ok
                  ? `${r.livemode ? t`La clé fonctionne (compte réel).` : t`La clé fonctionne (compte de test).`}${r.warning ? ` ${r.warning}` : ""}`
                  : (r.error ?? t`La clé a été refusée.`),
              });
              return r;
            }, t`Test terminé.`);
          }}
        >
          {test.state.status === "busy" ? t`Un instant…` : t`Tester la clé`}
        </button>
      </div>
      {p.secret.set || p.publishable.set || p.webhook.set ? (
        <div className="acts" style={{ marginTop: 8 }}>
          <button type="button" className="btn danger" onClick={() => setClearing(true)}>
            <Trans>Retirer les clés de cette propriété</Trans>
          </button>
        </div>
      ) : null}
      <Confirm
        open={clearing}
        danger
        title={t`Retirer les clés de ${p.name} ?`}
        text={t`Les trois clés sont effacées. La propriété retombe sur les clés de repli de l'environnement, ou sur les paiements simulés s'il n'y en a pas : plus aucun vrai paiement ne sera pris.`}
        yes={t`Retirer les clés`}
        no={t`Garder`}
        busy={clear.state.status === "busy"}
        onNo={() => setClearing(false)}
        onYes={async () => {
          const done = await clear.run(() => api(`/stripe/${p.propertyId}`, { method: "PUT", body: { secretKey: "", publishableKey: "", webhookSecret: "" } }), t`C'est fait. Clés retirées.`);
          if (done) setClearing(false);
        }}
      />
      {result ? <p className={result.ok ? "note" : "note bad"} role="status">{result.text}</p> : null}

      <h3 className="sub">{t`Webhook à déclarer chez Stripe`}</h3>
      <p className="hint">
        <Trans>Tableau de bord Stripe, Développeurs, Webhooks, Ajouter un point de terminaison. Collez cette adresse, cochez ces événements, puis copiez le « secret de signature » (whsec_…) dans le champ ci-dessus.</Trans>
      </p>
      <p className="secret" data-testid={`webhook-url-${p.propertyId}`}>{webhookUrl}</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(webhookUrl);
          toast(t`C'est fait. Adresse copiée.`);
        }}
      >
        <IconCopy size={18} />
        <Trans>Copier l'adresse</Trans>
      </button>
      <ul className="plain mono-line">
        {settings.events.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </Section>
  );
}
