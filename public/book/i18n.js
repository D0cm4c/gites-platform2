// Langue du tunnel de réservation public (lot 3, #34) : français ou
// néerlandais de Belgique. Le site vitrine reste en français.
//
// Choix de la langue, dans cet ordre : ?lang=fr|nl dans l'adresse (le
// sélecteur et les liens des mails le posent), puis le choix retenu sur
// l'appareil (localStorage), puis la langue du navigateur (la première de fr/nl
// rencontrée dans navigator.languages), sinon le français.
//
// Les textes sont écrits en français dans le code et traduits par t() à partir
// du dictionnaire nl.js. Un texte absent du dictionnaire reste en français :
// test/tunnel-nl.test.ts vérifie que chaque t("…") du tunnel y figure. Les
// textes que produit le serveur (erreurs, lignes du devis) sont traduits par le
// serveur lui-même (src/core/public-i18n.ts) : apiHeaders() le lui demande.
// Les conditions générales restent en français ; en néerlandais, elles sont
// précédées de la mention que la version française fait foi.

import { NL } from "./nl.js";

const KEY = "gites-lang";

function detect() {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "fr" || q === "nl") {
    try { localStorage.setItem(KEY, q); } catch { /* navigation privée */ }
    return q;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s === "fr" || s === "nl") return s;
  } catch { /* stockage indisponible */ }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
  for (const l of langs) {
    const base = String(l).toLowerCase().split("-")[0];
    if (base === "nl") return "nl";
    if (base === "fr") return "fr";
  }
  return "fr";
}

export const LANG = detect();
export const LOCALE = LANG === "nl" ? "nl-BE" : "fr-BE";

/** Texte dans la langue du tunnel ; {nom} remplacé par vars.nom. */
export function t(fr, vars) {
  const s = LANG === "nl" ? (NL[fr] ?? fr) : fr;
  return vars ? s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all)) : s;
}

/** « 1 nuit », « 3 nuits » — le mot passe par t(). */
export function pl(n, one, many) {
  return `${n} ${t(n > 1 ? many : one)}`;
}

/** En-têtes des appels à /api/public/* : le serveur traduit ses propres textes. */
export function apiHeaders(extra = {}) {
  return LANG === "nl" ? { ...extra, "x-gites-lang": "nl" } : extra;
}

/** Montant en euros, à la belge dans les deux langues. */
export const eur = (c) => (c / 100).toLocaleString(LOCALE, { style: "currency", currency: "EUR" });

/** Mention placée avant les conditions générales en néerlandais. */
export const CGV_NOTE_NL = "De algemene voorwaarden bestaan alleen in het Frans. De Franse versie is rechtsgeldend.";

/** Traduit la page statique : éléments [data-i18n] (contenu HTML, clé = le
 *  HTML français normalisé), attributs listés dans [data-i18n-attr], titre. */
export function translateStatic(root = document) {
  document.documentElement.lang = LANG === "nl" ? "nl-BE" : "fr-BE";
  if (LANG !== "nl") return;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const key = norm(el.innerHTML);
    if (NL[key]) el.innerHTML = NL[key];
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const a of el.dataset.i18nAttr.split(",")) {
      const v = el.getAttribute(a.trim());
      if (v && NL[v]) el.setAttribute(a.trim(), NL[v]);
    }
  }
  if (NL[document.title]) document.title = NL[document.title];
}

/** Sélecteur FR | NL : recharge la page dans l'autre langue, sans rien perdre
 *  (la sélection de dates vit dans l'adresse et sur l'appareil). */
export function mountLangSwitch(container) {
  if (!container) return;
  container.innerHTML = ["fr", "nl"]
    .map((l) => `<a href="#" data-lang="${l}" lang="${l}" ${l === LANG ? 'aria-current="true"' : ""}>${l === "fr" ? "FR" : "NL"}</a>`)
    .join(" · ");
  container.setAttribute("aria-label", LANG === "nl" ? "Taal" : "Langue");
  container.querySelectorAll("a[data-lang]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = new URL(location.href);
      url.searchParams.set("lang", a.dataset.lang);
      location.href = url.toString();
    });
  });
}

/** Heure lisible : « 18:00 » devient « 18 h » en français (« 18 h 30 » si besoin). */
export const hour = (h) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(h ?? ""));
  if (!m || LANG === "nl") return String(h ?? "");
  return `${Number(m[1])} h${m[2] === "00" ? "" : " " + m[2]}`;
};
