// Bouton flottant « Amélioration ? », présent sur toutes les pages de l'écran
// (la coque l'affiche une fois). Un clic ouvre une petite fenêtre : la remarque,
// et le rappel de la page où l'on se trouvait, retenue automatiquement. Les
// remarques sont suivies dans Réglages › Améliorations.
import { Trans, useLingui } from "@lingui/react/macro";
import { Modal, Textarea } from "@mantine/core";
import { IconCheck, IconMessageDots } from "@tabler/icons-react";
import { useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, errorText } from "../api/client";
import { useLayout } from "../lib/useLayout";
import { sectionOf, useNav } from "../shell/nav";
import { TEXT_MAX, TEXT_MIN } from "./types";

/** Titre de la page affichée : son titre à l'écran, sinon l'entrée de menu, sinon le titre du document. */
function pageTitleNow(nav: ReturnType<typeof useNav>, path: string): string {
  const h1 = document.querySelector("h1.title")?.textContent?.trim();
  if (h1) return h1;
  return sectionOf(nav, path)?.entry.label ?? document.title ?? "";
}

export function SuggestionButton() {
  const { t } = useLingui();
  const layout = useLayout();
  const nav = useNav();
  const qc = useQueryClient();
  const location = useRouterState({ select: (s) => s.location });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [page, setPage] = useState({ path: "/", title: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  const show = () => {
    // La page est retenue à l'ouverture : c'est celle que la personne regarde.
    const path = `${location.pathname}${location.searchStr ?? ""}`.slice(0, 300);
    setPage({ path, title: pageTitleNow(nav, location.pathname) });
    setState("idle");
    setError("");
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    if (state === "done") setText("");
  };
  const trimmed = text.trim();
  const send = async () => {
    if (state === "busy" || trimmed.length < TEXT_MIN) return;
    setState("busy");
    setError("");
    try {
      await api("/improvements", { method: "POST", body: { text: trimmed, pagePath: page.path, pageTitle: page.title, viewportWidth: window.innerWidth } });
      setState("done");
      setText("");
      void qc.invalidateQueries({ queryKey: ["improvements"] });
    } catch (e) {
      setState("idle");
      setError(errorText(e));
    }
  };
  const where = page.title ? t`Page : ${page.title} (${page.path})` : t`Page : ${page.path}`;
  return (
    <>
      <button type="button" className={`amel-fab amel-${layout}`} onClick={show} aria-haspopup="dialog" aria-label={t`Amélioration souhaitée : écrire une remarque sur cette page`}>
        <IconMessageDots size={22} aria-hidden />
        <span>
          <Trans>Amélioration ?</Trans>
        </span>
      </button>
      <Modal
        opened={open}
        onClose={close}
        title={<b style={{ fontSize: 20 }}>{t`Amélioration souhaitée`}</b>}
        closeButtonProps={{ "aria-label": t`Fermer`, size: "lg" }}
        centered
        fullScreen={layout === "B"}
        size="md"
        zIndex={400}
        trapFocus
        returnFocus
      >
        {state === "done" ? (
          <div>
            <p className="ok-line" role="status">
              <IconCheck size={20} aria-hidden />
              <Trans>Merci, c'est noté.</Trans>
            </p>
            <button type="button" className="btn wide" style={{ marginTop: 16 }} onClick={close}>
              <Trans>Fermer</Trans>
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              data-autofocus
              size="md"
              autosize
              minRows={4}
              maxRows={10}
              label={t`Qu'est-ce qui pourrait être mieux ?`}
              description={t`Écrivez comme vous parlez : ce qui gêne, ce qui manque, une idée.`}
              maxLength={TEXT_MAX}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              error={error || undefined}
            />
            <p className="hint" data-testid="amel-page" style={{ margin: "10px 0 0" }}>
              {where}
            </p>
            <button type="submit" className="btn pri wide" style={{ marginTop: 16 }} disabled={state === "busy" || trimmed.length < TEXT_MIN} aria-busy={state === "busy"}>
              {state === "busy" ? t`Un instant…` : t`Envoyer`}
            </button>
          </form>
        )}
      </Modal>
    </>
  );
}
