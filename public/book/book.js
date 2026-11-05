// Page publique : sans ?property → landing des domaines ; avec ?property →
// tunnel de réservation « ~4 clics » :
//   1. dates (calendrier)            → recherche automatique, sans bouton
//   2. hébergements disponibles      → auto-sélection s'il n'y en a qu'un
//   3. coordonnées (4 champs) + devis recalculé automatiquement, récap sticky
//   4. paiement sécurisé Stripe (créneau bloqué 30 min).
// Deep-links : ?checkin=&checkout=&adults=&children=&unit= (le site vitrine
// envoie ici avec les dates déjà choisies). La sélection est conservée 30 jours
// (localStorage) pour reprendre un devis interrompu.
// La ligne « Domaine entier » n'apparaît disponible que si TOUTES ses maisons
// sont libres — garanti par le moteur de liaison côté serveur.

import { cgvHtml } from "./cgv.js";
import { checkoutTimeFor } from "./checkout-time.js";
import { dayChipsHtml } from "./option-days.js";
import { mountPayment, paymentConfig } from "./pay-element.js";
import { visionneuse } from "/galerie.js";
import { apiHeaders, CGV_NOTE_NL, eur, hour, LANG, LOCALE, mountLangSwitch, pl, t, translateStatic } from "./i18n.js";

const params = new URLSearchParams(location.search);
// Page dédiée à un domaine (/reserver/<slug>/) : le domaine est posé par la page
// elle-même (`data-property` sur <body>, une ligne dans son HTML) et prime sur
// l'adresse. Un `?property=` différent est ignoré, jamais obéi. Sans cette
// ligne (/book/), le comportement historique reste : le domaine vient de l'URL.
const FIXED_PROPERTY = document.body.dataset.property || null;
const PROPERTY = FIXED_PROPERTY ?? params.get("property");
if (FIXED_PROPERTY && params.has("property")) {
  // Adresse nettoyée : le paramètre ignoré ne doit pas survivre dans un favori.
  params.delete("property");
  const clean = new URL(location.href);
  clean.searchParams.delete("property");
  history.replaceState(null, "", clean);
}

const eurRound = (c) => (LANG === "nl" ? `€ ${Math.round(c / 100)}` : `${Math.round(c / 100)} €`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dfr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** « jeudi 4 février 2027 » : arrivée et départ se lisent avec leur jour. */
const dlong = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay(); // 0 = dimanche
const JOURS = LANG === "nl"
  ? ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"]
  : ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Règle d'arrivée en clair. Une liste VIDE n'est pas « aucune contrainte » :
 *  c'est « plus aucune arrivée possible » (règles de saison incompatibles). */
function arrivalLabel(days) {
  const label = checkinDaysLabel(days);
  return label ? t("arrivée {jours}", { jours: label }) : t("aucune arrivée possible");
}

/** « le samedi », « le vendredi ou le samedi » — dire la règle, pas la subir. */
function checkinDaysLabel(days) {
  const names = [...new Set(days ?? [])].filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => JOURS[d]);
  if (names.length === 0) return "";
  if (LANG === "nl") {
    if (names.length === 1) return `op ${names[0]}`;
    return `op ${names.slice(0, -1).join(", ")} of ${names.at(-1)}`;
  }
  if (names.length === 1) return `le ${names[0]}`;
  return `le ${names.slice(0, -1).join(", le ")} ou le ${names.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Anti-robot Turnstile (issue #6) — entièrement optionnel
//
// La clé publique arrive de /api/public/today. Sans elle, RIEN de ce bloc ne
// s'exécute : aucun script tiers n'est chargé, aucun widget n'est affiché,
// aucun jeton n'est envoyé — le tunnel est exactement celui d'avant.
// ---------------------------------------------------------------------------

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let TURNSTILE_KEY = null;
let turnstileWidget = null;
let turnstileScript = null;

/** Charge le script Cloudflare une seule fois (rendu explicite : le formulaire
 *  est construit dynamiquement, l'auto-rendu ne verrait jamais le conteneur). */
function loadTurnstile() {
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = TURNSTILE_SRC;
      el.async = true;
      el.defer = true;
      el.onload = resolve;
      el.onerror = () => {
        // Sans cette remise à zéro, la promesse rejetée resterait en cache :
        // une micro-coupure au chargement de la page condamnerait le widget
        // jusqu'au rechargement complet, alors qu'un second essai suffit.
        turnstileScript = null;
        el.remove();
        reject(new Error("script indisponible"));
      };
      document.head.appendChild(el);
    });
  }
  return turnstileScript;
}

/** Affiche le widget dans l'étape 3. Rejoué à chaque rendu du panneau : le
 *  conteneur est recréé, l'ancien widget n'existe plus. */
async function mountTurnstile() {
  const box = $("turnstileBox");
  if (!TURNSTILE_KEY || !box) return;
  try {
    await loadTurnstile();
  } catch {
    // Le contrôle est indispensable : le dire tout de suite plutôt que de
    // laisser découvrir le refus après avoir rempli tout le formulaire.
    box.innerHTML = `<div class="note bad">${t("Le contrôle anti-robot n'a pas pu se charger. Rechargez la page, ou contactez-nous : nous réservons pour vous.")}</div>`;
    return;
  }
  // Script chargé mais API absente : bloqueur de contenu, extension de vie
  // privée… Le dire tout de suite, sinon le visiteur attend un widget qui ne
  // viendra jamais et ne comprend pas le refus au moment de payer.
  if (!window.turnstile) {
    box.innerHTML = `<div class="note bad">${t("Le contrôle anti-robot est bloqué par votre navigateur (extension de blocage ?). Autorisez challenges.cloudflare.com, ou contactez-nous : nous réservons pour vous.")}</div>`;
    return;
  }
  try { if (turnstileWidget !== null) window.turnstile.remove(turnstileWidget); } catch { /* widget déjà retiré avec son conteneur */ }
  turnstileWidget = null;
  try {
    // `action` est scellée dans le jeton et revérifiée par le serveur
    // (TURNSTILE_ACTION dans src/services/turnstile.ts) : les deux chaînes
    // doivent rester identiques.
    turnstileWidget = window.turnstile.render(box, { sitekey: TURNSTILE_KEY, action: "reservation" });
  } catch { /* clé invalide : le refus viendra du serveur, avec sa phrase */ }
}

/** Jeton courant, ou "" si la vérification n'est pas encore passée. */
function turnstileToken() {
  if (!TURNSTILE_KEY) return null;
  if (!window.turnstile || turnstileWidget === null) return "";
  try { return window.turnstile.getResponse(turnstileWidget) || ""; } catch { return ""; }
}

/** Un jeton ne sert qu'une fois : après un refus, il faut en refaire un. */
function resetTurnstile() {
  if (!TURNSTILE_KEY || !window.turnstile || turnstileWidget === null) return;
  try { window.turnstile.reset(turnstileWidget); } catch { /* rien à réarmer */ }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: apiHeaders(body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || t("erreur {status}", { status: res.status })), { code: data.code });
  return data;
}

const $ = (id) => document.getElementById(id);

let PROP = null;
let TODAY = null;
let SEARCH = null;
let SELECTED = null;
let QUOTE = null;
let calMonth = null; // 'YYYY-MM'
let selIn = null;
let selOut = null;
let preferredUnit = params.get("unit"); // slug — consommé au 1er résultat
let RESUMED_HOLD = null; // réservation en cours retrouvée au chargement (#68)
const calCache = new Map();

function setStep(n) {
  document.querySelectorAll("#steps span").forEach((s) => {
    const step = Number(s.dataset.step);
    s.classList.toggle("on", step === n);
    s.classList.toggle("done", step < n);
  });
  $("mobileBar").style.display = n === 3 && QUOTE?.ok ? "flex" : "none";
}

// ---------------------------------------------------------------------------
// Sélection : deep-links + reprise 30 jours
// ---------------------------------------------------------------------------

const storeKey = () => `gites-book:${PROPERTY}`;

function persistSelection() {
  const url = new URL(location.href);
  for (const [k, v] of [
    ["checkin", selIn],
    ["checkout", selOut],
    ["adults", String(pax().adults)],
    ["children", String(pax().children) === "0" ? null : String(pax().children)],
  ]) {
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  history.replaceState(null, "", url);
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ selIn, selOut, ...pax(), savedAt: Date.now() }));
  } catch { /* navigation privée */ }
}

function restoreSelection() {
  const qIn = params.get("checkin");
  const qOut = params.get("checkout");
  if (ISO_DATE.test(qIn ?? "") && ISO_DATE.test(qOut ?? "") && qIn >= TODAY && qOut > qIn) {
    selIn = qIn;
    selOut = qOut;
    setPax(Number(params.get("adults")) || 2, Number(params.get("children")) || 0);
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) ?? "null");
    if (!saved || Date.now() - saved.savedAt > 30 * 86400000) return;
    if (ISO_DATE.test(saved.selIn ?? "") && ISO_DATE.test(saved.selOut ?? "") && saved.selIn >= TODAY) {
      selIn = saved.selIn;
      selOut = saved.selOut;
      setPax(saved.adults, saved.children);
    }
  } catch { /* stockage indisponible */ }
}

function pax() {
  return { adults: Number($("qAd").value) || 2, children: Number($("qCh").value) || 0 };
}

function setPax(adults, children) {
  if (adults >= 1 && adults <= 30) $("qAd").value = String(adults);
  if (children >= 0 && children <= 30) $("qCh").value = String(children);
}

// ---------------------------------------------------------------------------
// Landing multi-domaines
// ---------------------------------------------------------------------------

async function renderLanding() {
  const landing = $("landing");
  landing.style.display = "block";
  $("propName").textContent = t("Réservation en direct");
  $("propSub").textContent = t("Choisissez votre domaine");
  try {
    const { properties } = await api("/api/public/properties");
    landing.innerHTML = `<div class="domains">${properties
      .map(
        (p) => `<a class="domain" href="?property=${encodeURIComponent(p.slug)}">
          <div class="ph" ${p.photoUrl ? `style="background-image:url('${esc(p.photoUrl)}')"` : ""}></div>
          <div class="bd"><b>${esc(p.name)}</b>
          <p>${esc(p.address ?? "")}</p>
          <p>${pl(p.unitsCount, "hébergement", "hébergements")} · ${t("jusqu'à {n} personnes", { n: p.capacityMax })}</p>
          <p style="margin-top:8px"><span class="btn" style="padding:8px 16px">${t("Voir & réserver")}</span></p></div>
        </a>`,
      )
      .join("")}</div>`;
  } catch (e) {
    landing.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Remises actives et disponibilité factuelle (issue #35)
//
// Les remises existent en base depuis le début et ne se découvraient qu'au
// devis — trop tard pour jouer leur rôle. Elles sont désormais annoncées, et
// le prix barré n'apparaît QUE lorsque le moteur applique réellement une
// remise (`quote.discountCents > 0`) : le prix de référence est toujours
// `total + remise`, jamais un montant fabriqué.
//
// Côté disponibilité : la phrase vient du serveur, qui la recalcule sur les
// vraies réservations à chaque chargement. Elle porte toujours son
// dénominateur (« 3 week-ends libres sur 9 ») — pas de fausse rareté, pas de
// compte à rebours, rien qui ne se vérifie pas contre le calendrier ci-dessous.
// ---------------------------------------------------------------------------

/** Prix de référence barré + économie, ou chaîne vide si aucune remise. */
function strikeThrough(totalCents, discountCents) {
  if (!(discountCents > 0)) return "";
  return `<span class="was">${eur(totalCents + discountCents)}</span>`;
}

async function renderOffers() {
  const card = $("offersCard");
  const body = $("offersBody");
  if (!card || !body) return;
  let data;
  try {
    data = await api(`/api/public/offers?property=${encodeURIComponent(PROPERTY)}`);
  } catch {
    return; // l'encart est un plus : son échec ne doit pas gêner la réservation
  }
  const promos = data.promotions ?? [];
  const avail = data.availability;
  if (promos.length === 0 && !avail?.sentence) return;

  const list = promos.length
    ? `<ul>${promos.map((p) => `<li>${esc(p.label)}</li>`).join("")}</ul>` +
      (data.nonCumulNote ? `<p class="cumul">${esc(data.nonCumulNote)}</p>` : "")
    : "";
  const availability = avail?.sentence
    ? `<p class="avail">${esc(avail.sentence)}
        <span class="src">${t("Calculé à l'instant sur les réservations réelles — vérifiable dans le calendrier ci-dessous.")}</span></p>`
    : "";
  body.innerHTML = list + availability;
  card.hidden = false;
}

// ---------------------------------------------------------------------------
// Étape 1 — calendrier des disponibilités et prix
// ---------------------------------------------------------------------------

async function loadCalMonth(month) {
  if (!calCache.has(month)) {
    calCache.set(month, await api(`/api/public/calendar?property=${encodeURIComponent(PROPERTY)}&month=${month}`));
  }
  return calCache.get(month);
}

function monthShift(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

async function renderCalendar() {
  const data = await loadCalMonth(calMonth);
  const monthStart = `${calMonth}-01`;
  const label = new Date(monthStart + "T12:00:00Z").toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
  $("calLabel").textContent = label;
  $("calPrev").disabled = calMonth <= TODAY.slice(0, 7);
  $("calNext").disabled = calMonth >= monthShift(TODAY.slice(0, 7), 23);
  // Bouton « Aujourd’hui » : caché tant qu’on est sur le mois courant, il
  // n’a d’intérêt qu’après navigation (les déep-links peuvent atterrir loin).
  if ($("calToday")) {
    const away = calMonth !== TODAY.slice(0, 7);
    $("calToday").hidden = !away;
  }

  // agrégat par jour : dispo = au moins un hébergement libre ; prix = plancher
  // Minimum de nuits et jours d'arrivée sont agrégés de la même façon — au plus
  // PERMISSIF des hébergements encore libres : c'est ce qui rend une
  // réservation possible ce jour-là, donc ce que le client doit lire (#66).
  const nbDays = data.units[0]?.days.length ?? 0;
  const days = [];
  for (let i = 0; i < nbDays; i++) {
    const perUnit = data.units.map((u) => u.days[i]);
    const date = perUnit[0].date;
    const free = perUnit.filter((d) => d.available && d.priceCents != null);
    // `checkinDays` a trois états côté serveur : null = aucune contrainte,
    // liste = ces jours-là, liste VIDE = aucune arrivée possible. L'agrégat est
    // une UNION : il suffit qu'un hébergement libre accepte le jour.
    const restricted = free.filter((d) => d.checkinDays != null);
    // Règle de séjour du jour, INDÉPENDANTE de l'occupation : un jour pris
    // coupait la même règle en autant de segments qu'il y a de réservations, et
    // la ligne de règles se répétait. Calculée sur tous les hébergements tarifés.
    const priced = perUnit.filter((d) => d.priceCents != null && !d.past);
    const pricedRestricted = priced.filter((d) => d.checkinDays != null);
    days.push({
      ruleMinNights: priced.length ? Math.min(...priced.map((d) => d.minNights || 1)) : null,
      ruleArrivalDays: priced.length && pricedRestricted.length === priced.length
        ? [...new Set(pricedRestricted.flatMap((d) => d.checkinDays))].sort((a, b) => a - b)
        : null,
      date,
      past: perUnit[0].past,
      available: free.length > 0,
      minPrice: free.length ? Math.min(...free.map((d) => d.priceCents)) : null,
      minNights: free.length ? Math.min(...free.map((d) => d.minNights || 1)) : null,
      // Jour de rotation : un départ ce matin, arrivée possible à 18 h. Agrégé
      // en UNION comme la dispo — il suffit qu'un hébergement libre tourne.
      turnover: free.some((d) => d.turnover),
      // Jour d'ARRIVÉE d'un séjour : une réservation DÉBUTE ce jour-là (la nuit
      // est prise, le jour sort « complet »). Agrégé sur TOUTES les unités
      // tarifées — pas seulement libres : c'est précisément sur les jours
      // complets qu'il faut dire pourquoi.
      arrivalDay: perUnit.some((d) => !d.past && d.arrivalDay),
      // null = au moins un hébergement libre n'impose aucun jour d'arrivée
      arrivalDays: free.length && restricted.length === free.length
        ? [...new Set(restricted.flatMap((d) => d.checkinDays))].sort((a, b) => a - b)
        : null,
    });
  }

  const firstDow = (new Date(monthStart + "T12:00:00Z").getUTCDay() + 6) % 7;
  let html = (LANG === "nl" ? ["M", "D", "W", "D", "V", "Z", "Z"] : ["L", "M", "M", "J", "V", "S", "D"]).map((l) => `<div class="h">${l}</div>`).join("");
  for (let i = 0; i < firstDow; i++) html += `<div class="pday off"></div>`;
  for (const d of days) {
    const inRange = selIn && selOut && d.date > selIn && d.date < selOut;
    const isSel = d.date === selIn || d.date === selOut;
    // Le jour du départ n'est pas une nuit payée : sa case se dessine à part.
    const isOut = selOut != null && d.date === selOut;
    // Marqueurs de bout de plage : servent au CSS pour arrondir les coins
    // externes et fondre les bordures internes — la période se lit continue.
    const start = d.date === selIn ? " start" : "";
    const end = d.date === selOut ? " end" : "";
    const noArrival = !d.past && d.available && d.arrivalDays != null && !d.arrivalDays.includes(dow(d.date));
    // Le minimum de nuits se VOIT sur la case (mn2/mn3/mn4+) : le client
    // repère les périodes contraignantes avant même de lire les règles
    // en bas de calendrier. Un jour libre sans minimum ne porte rien.
    const mnCls = !d.past && d.available && d.minNights > 1 ? ` mn${Math.min(d.minNights, 4)}` : "";
    // Jour de rotation : marqué dans la classe, le prix laisse la place au
    // mot-clé « rotation » dans la case — l'info prime sur le « dès X € ».
    // Marque compacte : les cases sont petites, le texte intégral (« départ le
    // matin », « arrivée le soir ») ne tient pas. Une flèche dit le mouvement,
    // le title porte la phrase entière au survol.
    const turnCls = d.turnover && !d.past && d.available ? " turnover" : "";
    const arriveCls = d.arrivalDay && !d.past ? " arrival" : "";
    const cls = ["pday", d.past ? "past" : "", !d.past && !d.available ? "full" : "",
      noArrival ? "noarr" : "", isSel ? "sel" : "", isOut ? "dep" : "", inRange ? "range" : ""].join(" ") + start + end + mnCls + turnCls + arriveCls;
    // Case du départ : ni prix ni minimum, ce n'est pas une nuit payée.
    // Les jours coupés gardent leur prix/description d'origine : la marque
    // visuelle (case coupée en deux) suffit, pas de libellé flèché (retour de
    // Julien du 03/11 : « pas utile sur un calendrier de réservation »).
    const sub = isOut ? t("départ") : d.past ? "" : d.available ? (d.minPrice != null ? t("dès {prix}", { prix: eurRound(d.minPrice) }) : "") : t("complet");
    // Le minimum de nuits est écrit DANS la case : c'est la seule façon de le
    // voir avant d'avoir choisi ses dates (impasse n° 5 du parcours au clic).
    const mn = !isOut && !d.past && d.available && d.minNights > 1 ? `<span class="mn">${t("min {n} n", { n: d.minNights })}</span>` : "";
    // Pas de libellé « 18 h » ni de phrase au survol pour les jours coupés :
    // la marque visuelle (case coupée en deux) suffit, l'heure n'apporte rien
    // à la réservation (retour de Julien du 03/11). Le title ne garde que les
    // règles de séjour, utiles AVANT le clic.
    const hints = d.past ? [] : [
      d.minNights > 1 ? t("{n} nuits minimum", { n: d.minNights }) : "",
      d.arrivalDays != null ? arrivalLabel(d.arrivalDays) : "",
    ].filter(Boolean);
    const title = hints.length ? ` title="${esc(hints.join(" · "))}"` : "";
    const full = new Date(d.date + "T12:00:00Z").toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const role = d.date === selIn ? `, ${t("arrivée")}` : d.date === selOut ? `, ${t("départ")}` : "";
    const ariaMin = !isOut && !d.past && d.available && d.minNights > 1 ? ", " + t("{n} nuits minimum", { n: d.minNights }) : "";
    const aria = ` aria-label="${esc(full + role + (isOut ? "" : d.past ? "" : d.available ? (d.minPrice != null ? ", " + sub : "") + ariaMin : ", " + t("complet")))}" aria-pressed="${isSel ? "true" : "false"}"`;
    html += `<button type="button" class="${cls}" data-date="${d.date}"${title}${aria} ${d.past ? "disabled" : ""}>
      <span class="d">${Number(d.date.slice(8, 10))}</span><span class="p">${sub}</span>${mn}</button>`;
  }
  $("calGrid").innerHTML = html;
  $("calGrid").querySelectorAll(".pday[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => onDayClick(cell.dataset.date, cell));
    // Prévisualisation au survol : arrivée choisie, départ pas encore — les
    // jours entre l'arrivée et le curseur s'annoncent en clair. Rien quand la
    // sélection est complète ou sur un jour non cliquable.
    // Le nettoyage se fait sur TOUTE la grille à chaque événement : le curseur
    // colore la plage entière d'un coup, il faut la décolorer entière aussi,
    // sinon les cases déjà quittées gardent la marque et la prévisualisation
    // s'accumule au fil des mouvements.
    // Nettoyage complet : la plage survolée ET le compte de nuits posé sur la
    // case d'arrivée repartent ensemble — sinon l'un traîne sans l'autre.
    const clearHoverRange = () => {
      $("calGrid").querySelectorAll(".hover-range").forEach((c) => c.classList.remove("hover-range", "short"));
      $("calGrid").querySelectorAll(".p.live-nights").forEach((p) => {
        if (p.dataset.orig != null) p.textContent = p.dataset.orig;
        delete p.dataset.orig;
        p.classList.remove("live-nights");
      });
    };
    cell.addEventListener("mouseenter", () => {
      clearHoverRange();
      if (!selIn || selOut || cell.classList.contains("past") || cell.classList.contains("full") || cell.dataset.date <= selIn) return;
      // Minimum de nuits du jour d'ARRIVÉE : tant qu'il n'est pas atteint, la
      // plage survolée s'affiche en attente (ambré) ; atteint, elle prend la
      // teinte définitive. La contrainte se VOIT avant le refus du devis.
      const nights = nightsBetween(selIn, cell.dataset.date);
      const minN = days.find((x) => x.date === selIn)?.minNights || 1;
      const short = nights < minN;
      $("calGrid").querySelectorAll(".pday[data-date]").forEach((c) => {
        // Les jours pris ou passés ne font partie d'aucun séjour possible :
        // ils gardent leur gris, la prévisualisation ne les traverse pas.
        if (c.classList.contains("past") || c.classList.contains("full")) return;
        if (c.dataset.date > selIn && c.dataset.date <= cell.dataset.date) c.classList.add("hover-range", ...(short ? ["short"] : []));
      });
      // Compte de nuits dynamique sur la case d'arrivée : le prix laisse la
n      // place au séjour envisagé, et revient au nettoyage.
      const inCell = $("calGrid").querySelector(`.pday[data-date="${selIn}"]`);
      const p = inCell?.querySelector(".p");
      if (p) {
        p.dataset.orig = p.textContent;
        p.textContent = pl(nights, "nuit", "nuits");
        p.classList.add("live-nights");
      }
    });
    cell.addEventListener("mouseleave", clearHoverRange);
  });
  renderCalRules(days, data.minLeadDays);
}

/** Règles de séjour du mois affiché, en une phrase (décision du 24/10/2026 :
 *  la liste période par période était excessive). Le minimum de chaque jour
 *  reste écrit DANS sa case ; ici, on dit seulement pourquoi il change. */
function renderCalRules(days, minLeadDays = 0) {
  const zone = $("calRules");
  if (!zone) return;
  const futurs = days.filter((d) => !d.past && d.ruleMinNights != null);
  const parts = [];
  if (futurs.some((d) => d.ruleMinNights > 1)) {
    parts.push(t("Les réservations ont une durée minimum selon les saisons et les fêtes : elle est indiquée sur chaque jour."));
  }
  // Jours d'arrivée : dits une fois, s'ils sont les mêmes tout le mois.
  const arr = [...new Set(futurs.map((d) => (d.ruleArrivalDays ?? []).join(",")))];
  if (arr.length === 1 && arr[0] !== "") {
    const label = arrivalLabel(arr[0].split(",").map(Number));
    parts.push(label.charAt(0).toUpperCase() + label.slice(1) + ".");
  }
  // Délai minimum de réservation (demande n° 15) : les jours trop proches sont
  // grisés comme des jours passés — la règle doit être écrite, pas devinée.
  if (minLeadDays > 0) parts.push(t("Réservation en ligne au plus tard {jours} avant l'arrivée.", { jours: pl(minLeadDays, "jour", "jours") }));
  // Légende des minimums présents ce mois-ci : un pictogramme couleur par
  // contrainte, qui ne montre QUE les minimums qui existent dans le mois
  // affiché — pas de bruit sinon. Elle complète les phrases, pas l'inverse.
  const mins = [...new Set(futurs.filter((d) => d.ruleMinNights > 1).map((d) => Math.min(d.ruleMinNights, 4)))].sort((a, b) => a - b);
  const legend = mins.length
    ? `<span class="rule">${mins.map((n) => `<span class="mn-chip mn${n}">${t("min. {n} n", { n: n === 4 ? "4+" : String(n) })}</span>`).join(" ")}</span>`
    : "";
  zone.innerHTML = legend + parts.map((x) => `<span class="rule">${esc(x)}</span>`).join(" ");
}

function onDayClick(date, cell) {
  if (cell.classList.contains("past")) return;
  const isFull = cell.classList.contains("full");
  // Re-clic sur le jour d'arrivée (départ pas encore choisi) : on repart de
  // zéro. Sans ça, changer d'avis obligeait à cliquer un AUTRE jour d'abord —
  // l'arrivée restait coincée tant qu'aucun départ ne la libérait.
  if (date === selIn && !selOut) {
    selIn = null;
    renderCalendar();
    onSelectionChange();
    return;
  }
  const asArrival = !selIn || Boolean(selOut) || date <= selIn;
  // Un jour sans arrivée (samedi, dimanche…) reste cliquable comme DÉPART, mais
  // jamais comme arrivée : le refus tombait seulement au devis (24/10/2026).
  if (asArrival && cell.classList.contains("noarr")) {
    // Le résumé du séjour en cours reste : le refus s'écrit sur sa propre ligne.
    updateSummary();
    $("staySummary").insertAdjacentHTML("beforeend", `<p class="pcal-hint">${esc(t("Pas d'arrivée ce jour-là."))}${
      cell.title ? ` ${esc(cell.title)}` : ""}</p>`);
    return;
  }
  if (asArrival) {
    if (isFull) return; // un jour complet ne peut pas être une arrivée
    selIn = date;
    selOut = null;
  } else {
    selOut = date; // le jour de départ peut être « complet » (rotation le jour même)
  }
  renderCalendar();
  onSelectionChange();
}

function updateSummary() {
  const zone = $("staySummary");
  if (selIn && selOut) {
    const n = nightsBetween(selIn, selOut);
    zone.innerHTML = `<div class="stay-summary">
      <span>${t("Arrivée le <b>{date}</b>", { date: dlong(selIn) })}</span>
      <span>${t("Départ le <b>{date}</b>", { date: dlong(selOut) })}</span>
      <span class="stay-n">${n === 1 ? t("1 nuit payée") : t("{n} nuits payées", { n })}</span></div>`;
  } else if (selIn) {
    zone.innerHTML = `<div class="stay-summary"><span>${t("Arrivée le <b>{date}</b>", { date: dlong(selIn) })}</span>
      <span class="muted">${t("Choisissez maintenant le jour de départ.")}</span></div>`;
  } else {
    zone.innerHTML = "";
  }
}

// Recherche automatique dès que la sélection est complète (pas de bouton).
let searchTimer = null;

function onSelectionChange() {
  if (document.body.classList.contains("hold-locked")) return; // réservation en cours : dates figées
  updateSummary();
  persistSelection();
  $("bookingPanel").innerHTML = "";
  SELECTED = null;
  QUOTE = null;
  setStep(1);
  clearTimeout(searchTimer);
  if (selIn && selOut) {
    searchTimer = setTimeout(search, 200);
  } else {
    $("results").innerHTML = "";
  }
}

// ---------------------------------------------------------------------------
// Étape 2 — hébergements disponibles
//
// Issue #66 — un séjour refusé DIT pourquoi et propose une sortie. La règle
// (minimum de nuits, jour d'arrivée imposé) vit dans le moteur de devis ; le
// serveur renvoie désormais la règle ET une ou deux plages réservables les
// plus proches, calculées sur les vraies disponibilités. Un « indisponible »
// sans explication n'est plus jamais la seule réponse.
// ---------------------------------------------------------------------------

let searchSeq = 0;

/** Énumération française : « A », « A et B », « A, B et C ». */
function frList(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${t("et")} ${items[items.length - 1]}`;
}

/** Noms des unités LIÉES dont l'occupation rend celle-ci indisponible (#45). */
function blockerNames(u, units) {
  const byId = new Map(units.map((x) => [x.unitId, x.name]));
  return (u.blockedByUnitIds ?? []).map((id) => byId.get(id)).filter(Boolean);
}

/** Étiquette courte : pourquoi cet hébergement n'est pas réservable. */
function unavailableReason(u, nights, units = []) {
  if (u.available && !u.fitsCapacity) return t("Capacité maximale : {n} personnes", { n: u.capacityMax });
  const q = u.quote;
  if (q && !q.ok && q.errors.includes("min_nights")) {
    return t("Séjour trop court : {min} nuits minimum à ces dates (vous en avez demandé {n})", { min: q.minNights, n: nights });
  }
  if (q && !q.ok && q.errors.includes("checkin_day")) {
    const jours = checkinDaysLabel(q.checkinDays);
    return jours
      ? t("Arrivée possible uniquement {jours} à ces dates", { jours })
      : t("Aucun jour d'arrivée n'est autorisé à ces dates");
  }
  if (q && !q.ok && q.errors.includes("lead_time")) {
    return t("Réservation en ligne au plus tard {jours} avant l'arrivée", { jours: pl(q.minLeadDays, "jour", "jours") });
  }
  if (q && !q.ok && q.errors.includes("no_rate")) return t("Tarifs pas encore publiés pour ces dates");
  if (q && !q.ok) return t("Non réservable en ligne sur ces dates");
  // Issue #45 — la liaison A/B/Domaine, dite en clair. Le Domaine entier tombe
  // dès qu'UNE des deux maisons est prise : la carte se grisait sans un mot.
  // L'accord est volontairement porté par « ces nuits » (féminin pluriel,
  // invariable) : les noms d'hébergements viennent du back-office et leur genre
  // est inconnu du code.
  const blockers = blockerNames(u, units);
  if (blockers.length) return t("Ces nuits sont déjà prises sur {noms}", { noms: frList(blockers) });
  return t("Déjà réservé sur ces dates");
}

/** Issue #45 — la sortie : ce qui reste réservable quand une unité liée tombe.
 *  L'information est déjà dans la réponse de recherche, il ne manquait que la
 *  phrase. Vide si le blocage n'est pas dû à une liaison, ou si plus rien
 *  n'est réservable (les suggestions de dates prennent alors le relais). */
function unavailableDetail(u, units, bookable) {
  if (!blockerNames(u, units).length) return "";
  const libres = bookable.filter((b) => b.unitId !== u.unitId).map((b) => b.name);
  if (!libres.length) return "";
  return libres.length > 1 ? t("{noms} restent libres sur ces dates.", { noms: frList(libres) }) : t("{noms} reste libre sur ces dates.", { noms: frList(libres) });
}

/** Plages réservables les plus proches, en un clic. */
function suggestionsBlock(u) {
  if (!u.suggestions?.length) return "";
  const buttons = u.suggestions
    .map(
      (s) => `<button type="button" class="btn o sugg-b" data-in="${s.checkin}" data-out="${s.checkout}">
        ${t("Du {du} au {au}", { du: dfr(s.checkin), au: dfr(s.checkout) })} — ${pl(s.nights, "nuit", "nuits")} · ${eur(s.totalCents)}</button>`,
    )
    .join("");
  return `<div class="sugg"><span class="small muted">${t("Ces dates fonctionnent :")}</span>${buttons}</div>`;
}

/** Applique une suggestion : dates pré-remplies, recherche relancée. */
function applySuggestion(checkin, checkout) {
  if (!ISO_DATE.test(checkin ?? "") || !ISO_DATE.test(checkout ?? "") || checkout <= checkin) return;
  selIn = checkin;
  selOut = checkout;
  calMonth = checkin.slice(0, 7);
  renderCalendar();
  onSelectionChange();
  $("searchCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Galerie d'un hébergement, telle qu'elle est arrivée avec la fiche du domaine
 *  (issue #32). Le tunnel ne la redemande pas au serveur : `PROP` la porte déjà. */
function photosOf(unitId) {
  return PROP?.units?.find((u) => u.id === unitId)?.photos ?? [];
}

/** Bouton d'ouverture de la galerie sur une carte d'hébergement. Rien quand il
 *  n'y a qu'une photo — la vignette de la carte la montre déjà. */
function galleryButton(unitId) {
  const n = photosOf(unitId).length;
  if (n < 2) return "";
  return `<div class="gal-row"><button type="button" class="btn o sm gal" data-gal="${unitId}">${t("Voir les {n} photos", { n })}</button></div>`;
}

/** Visionneuse ouverte depuis les cartes de résultat, et l'hébergement qu'elle
 *  montre. Une seule à la fois : la liste des résultats est réécrite à CHAQUE
 *  recherche, et une visionneuse par carte empilerait des `<dialog>` invisibles
 *  dans l'arbre d'accessibilité au fil des changements de dates. */
let galVue = null;
let galUnit = 0;

/** Ouvre la galerie d'un hébergement, en remplaçant celle qui traîne. */
function openGallery(unitId) {
  if (galUnit !== unitId) {
    galVue?.detruire();
    galVue = visionneuse(
      photosOf(unitId).map((p) => ({ src: p.path, alt: p.alt, legende: p.caption })),
    );
    galUnit = unitId;
  }
  galVue?.ouvrir(0);
  return galVue !== null;
}

/** Câble les boutons de galerie présents dans `root`. La visionneuse n'est
 *  construite qu'au premier clic : en fabriquer une par carte qu'on ne
 *  regardera peut-être jamais serait du gaspillage. */
function wireGalleries(root) {
  galVue?.detruire();
  galVue = null;
  galUnit = 0;
  root.querySelectorAll("[data-gal]").forEach((btn) =>
    btn.addEventListener("click", () => {
      // Navigateur sans <dialog> modale : la galerie de la page du gîte reste
      // le chemin de repli, on n'invente pas de visionneuse dégradée ici — et
      // un bouton qui n'ouvre rien vaut moins que pas de bouton du tout.
      if (!openGallery(Number(btn.dataset.gal))) btn.remove();
    }),
  );
}

async function search() {
  const { adults, children } = pax();
  $("searchMsg").innerHTML = "";
  $("bookingPanel").innerHTML = "";
  SELECTED = null;
  const seq = ++searchSeq;
  // aria-busy était figé à "false" dans le HTML : la région annonçait
  // « Recherche… » puis la liste, deux fois pour un seul geste (issue #47-6).
  $("results").setAttribute("aria-busy", "true");
  $("results").innerHTML = `<div class="card muted">${t("Recherche…")}</div>`;
  let data;
  try {
    data = await api(
      `/api/public/availability?property=${encodeURIComponent(PROPERTY)}&checkin=${selIn}&checkout=${selOut}&adults=${adults}&children=${children}`,
    );
  } catch (e) {
    if (seq !== searchSeq) return;
    $("results").setAttribute("aria-busy", "false");
    $("results").innerHTML = "";
    $("searchMsg").innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    return;
  }
  if (seq !== searchSeq) return; // une sélection plus récente a relancé la recherche
  SEARCH = { checkin: selIn, checkout: selOut, adults, children };
  setStep(2);
  if (data.ownHold && data.ownHold.checkin === selIn && data.ownHold.checkout === selOut) {
    $("searchMsg").innerHTML =
      `<div class="note">${t("Nous avons retrouvé votre réservation en cours (réf. {ref}) : ces dates vous restent réservées, vous reprenez là où vous en étiez.", { ref: esc(data.ownHold.reference) })}</div>`;
  }

  const nights = nightsBetween(selIn, selOut);
  const bookable = data.units.filter((u) => u.available && u.fitsCapacity && u.quote?.ok);
  const cards = data.units.map((u) => {
    const capacity = `${u.capacityBase}${u.capacityMax > u.capacityBase ? "-" + u.capacityMax : ""} p.`;
    const photo = u.photoUrl ? `style="background-image:url('${esc(u.photoUrl)}')"` : "";
    if (u.available && u.fitsCapacity && u.quote?.ok) {
      return `<div class="prop" data-unit="${u.unitId}">
        <div class="ph" ${photo}>${u.photoUrl ? "" : t("photo")}</div>
        <div class="info"><b>${esc(u.name)}</b> · ${capacity}<br>
          <span class="muted small">${esc(u.description ?? "")}</span>
          ${galleryButton(u.unitId)}</div>
        <div class="price">${strikeThrough(u.quote.totalCents, u.quote.discountCents)}<b>${eur(u.quote.totalCents)}</b><br>
          <span class="per">${t("{nuits}, ménage et charges compris", { nuits: pl(nights, "nuit", "nuits") })}</span>
          ${u.quote.autoDiscountApplied ? `<br><span class="savings">${t("{remise} déduite", { remise: esc(u.quote.autoDiscountApplied) })}</span>` : ""}<br>
          <button class="btn" style="margin-top:6px" data-select="${u.unitId}" aria-pressed="false">${t("Réserver")}</button></div>
      </div>`;
    }
    const detail = unavailableDetail(u, data.units, bookable);
    return `<div class="prop off" data-unit="${u.unitId}">
      <div class="ph" ${photo}>${u.photoUrl ? "" : t("photo")}</div>
      <div class="info"><b>${esc(u.name)}</b> · ${capacity}<br><span class="tag t-bad">${esc(unavailableReason(u, nights, data.units))}</span>
        ${detail ? `<br><span class="small why">${esc(detail)}</span>` : ""}
        ${suggestionsBlock(u)}</div>
    </div>`;
  });
  $("results").innerHTML = cards.join("") || `<div class="note">${t("Aucun hébergement.")}</div>`;
  // La liste est complète : la région redevient « au repos » et c'est ce
  // basculement qui déclenche l'annonce, une seule fois (issue #47-6).
  $("results").setAttribute("aria-busy", "false");
  wireGalleries($("results"));
  document.querySelectorAll("[data-select]").forEach((b) => b.addEventListener("click", () => openBookingPanel(Number(b.dataset.select))));
  document.querySelectorAll(".sugg-b").forEach((b) =>
    b.addEventListener("click", () => applySuggestion(b.dataset.in, b.dataset.out)),
  );
  if (bookable.length === 0 && data.units.some((u) => u.suggestions?.length)) {
    $("searchMsg").innerHTML =
      `<div class="note">${t("Aucun hébergement n'est réservable du {du} au {au} — les dates proposées ci-dessous fonctionnent, en un clic.", { du: dfr(selIn), au: dfr(selOut) })}</div>`;
  }

  // Auto-sélection : l'unité demandée en deep-link, sinon la seule réservable.
  const wanted = preferredUnit ? bookable.find((u) => u.slug === preferredUnit) : null;
  preferredUnit = null; // ne s'applique qu'à la première recherche
  const auto = wanted ?? (bookable.length === 1 ? bookable[0] : null);
  if (auto) {
    openBookingPanel(auto.unitId);
    return;
  }
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Étape 3 — coordonnées (4 champs) + récap sticky, devis auto
// ---------------------------------------------------------------------------

let quoteSeq = 0;

/** Issue #46 — la carte choisie se voit. Les autres restent cliquables : c'est
 *  un groupe de boutons bascule (`aria-pressed`), pas une liste figée. Le
 *  libellé du bouton suit l'état, pour que l'information ne repose ni sur la
 *  seule couleur ni sur la seule bordure. */
function markSelected(unitId) {
  document.querySelectorAll("#results .prop").forEach((el) => {
    const on = Number(el.dataset.unit) === unitId;
    el.classList.toggle("sel", on);
    const b = el.querySelector("[data-select]");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? t("Votre choix") : t("Réserver");
  });
}

async function openBookingPanel(unitId) {
  markSelected(unitId);
  OPT_DAYS = new Map();
  OPT_AVAIL = new Map();
  SELECTED = PROP.units.find((u) => u.id === unitId);
  QUOTE = null;
  setStep(3);
  // Équipements réservables : bouton « Ajouter » (pas de case à cocher) —
  // mise à disposition d'équipement, pas un service (linge et ménage sont
  // inclus de base dans les frais généraux, jamais en option).
  const optionRows = PROP.options
    .map((o) => {
      // Option à la date : « dès 120 € / jour, 180 € le week-end » (le prix de la semaine est un plancher).
      const priceLabel = o.perDate
        ? o.weekendPriceCents != null && o.weekendPriceCents !== o.priceCents && !(o.weekendDays && o.weekendDays.length === 0)
          ? t("dès {jour} / jour, {we} le week-end", { jour: eurRound(Math.min(o.priceCents, o.weekendPriceCents)), we: eurRound(o.weekendPriceCents) })
          : t("{jour} / jour", { jour: eurRound(o.priceCents) })
        : `${eur(o.priceCents)}${o.unitLabel ? " / " + esc(o.unitLabel) : ""}`;
      const input =
        o.pricingMode === "per_unit_qty"
          ? `<input type="number" min="0" max="${o.maxQty ?? 99}" value="0" class="opt" data-oid="${o.id}">`
          : `<button type="button" class="opt-add" data-oid="${o.id}" aria-pressed="false">${t("+ Ajouter")}</button>`;
      // Option « à la date » : la rangée de jours s'ouvre sous l'option quand on l'ajoute.
      const days = o.perDate ? `<div class="opt-days" id="optDays${o.id}" hidden></div>` : "";
      return `<div class="opt-row"><span class="name">${esc(o.name)} <span class="muted small">${priceLabel}</span></span>${input}</div>${days}`;
    })
    .join("");

  // Pourcentage d'arrhes de l'hébergement réservé (issue #75). L'API a déjà
  // résolu le repli sur le domaine — le `??` n'est qu'un filet si un client
  // arrive avec une réponse mise en cache par un ancien déploiement.
  const depositPct = SELECTED.depositPct ?? PROP.settings.depositPct;

  // Le texte du choix est dans un <span> : le libellé devient une vraie ligne
  // flex (radio à taille native + texte qui s'aligne sous lui-même), au lieu
  // d'un radio étiré sur toute la largeur du bloc (issue #42).
  const payChoices = [];
  if (PROP.settings.allowDeposit)
    payChoices.push(`<label><input type="radio" name="payMode" value="deposit" checked><span>${t("<b>Arrhes de {pct} %</b> maintenant — solde {jours} jours avant l'arrivée", { pct: depositPct, jours: PROP.settings.balanceDueDays })}</span></label>`);
  if (PROP.settings.allowFullPayment)
    payChoices.push(`<label><input type="radio" name="payMode" value="full" ${!PROP.settings.allowDeposit ? "checked" : ""}><span>${t("<b>Totalité</b> maintenant")}</span></label>`);

  $("bookingPanel").innerHTML = `
    <div class="panel-grid">
      <div class="panel-main">
        ${PROP.options.length ? `<div class="card"><h3>${t("Équipements du séjour")}</h3>${optionRows}</div>` : ""}
        <div class="card" id="guestCard">
          <h3 id="step3Title" tabindex="-1">${t("Vos coordonnées")}</h3>
          <div class="formgrid">
            <div><label class="f" for="gFirst">${t("Prénom")}</label><input id="gFirst" autocomplete="given-name"></div>
            <div><label class="f" for="gLast">${t("Nom *")}</label><input id="gLast" autocomplete="family-name" aria-describedby="eLast"><div class="field-msg" id="eLast" role="alert"></div></div>
            <div><label class="f" for="gEmail">${t("Email *")}</label><input id="gEmail" type="email" inputmode="email" autocomplete="email" aria-describedby="eEmail" placeholder="${t("pour recevoir votre confirmation")}"><div class="field-msg" id="eEmail" role="alert"></div></div>
            <div><label class="f" for="gPhone">${t("Téléphone (facultatif)")}</label><input id="gPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${t("utile pour l'accueil le jour d'arrivée")}"></div>
          </div>
          <details class="fold"><summary>${t("Un message pour nous ? Un code promo ?")}</summary>
            <div class="row" style="margin-top:10px">
              <div class="n" style="width:180px"><label class="f" for="bPromo">${t("Code promo")}</label><input id="bPromo" placeholder="${t("facultatif")}"></div>
              <div><label class="f" for="gNotes">${t("Message")}</label><input id="gNotes" placeholder="${t("heure d'arrivée, question…")}"></div>
            </div>
          </details>
          <div class="paybox">
            <h4>💳 ${t("Paiement sécurisé")} <span class="badge-secure">Stripe</span></h4>
            <fieldset class="paychoices"><legend class="sr-only">${t("Montant à payer maintenant")}</legend>${payChoices.join("")}</fieldset>
            <p id="payNote" class="pay-note small" aria-live="polite"></p>
            <div class="cards">${t("Bancontact · Visa · Mastercard — aucun montant n'est débité sans confirmation.")}</div>
          </div>
          <div class="agree"><label class="small" id="cgvLabel"><input type="checkbox" id="gCgv" aria-describedby="cgvMsg"> ${t('J\'accepte les <a href="#" id="cgvLink">conditions générales</a> *')}</label>
          <div id="cgvMsg" class="field-msg" role="alert"></div>
          <div id="cgvBox" class="cgv-box" style="display:none"></div>
          <label class="small optin"><input type="checkbox" id="gOptin"> ${t('Tenez-moi au courant des disponibilités et offres par email <span class="muted">(facultatif, désinscription à tout moment)</span>')}</label></div>
          ${TURNSTILE_KEY ? `<div id="turnstileBox" class="turnstile"></div><div id="turnstileMsg" class="field-msg" role="alert"></div>` : ""}
          <div id="bookMsg" role="alert" aria-live="assertive"></div>
          <button class="btn big" id="bPay" style="margin-top:14px" disabled>${t("Payer et réserver")}</button>
          <div class="next"><h4>${t("Et ensuite ?")}</h4><ol>
            <li>${t("Vous payez en ligne, sur cette page (Bancontact, Visa, Mastercard).")}</li>
            <li>${t("Vous recevez dans quelques minutes un e-mail de confirmation, avec votre récapitulatif et les conditions générales. Son objet commence par la référence de votre réservation.")}</li>
            <li>${t("Une question ? Répondez simplement à cet e-mail : pas de chat, nous vous répondons par e-mail.")}</li></ol></div>
          <p class="reassure">${t('Votre créneau est bloqué <b id="holdMin">30</b> minutes le temps du paiement. Réservation ferme dès paiement — pas de droit de rétractation pour les hébergements datés (art. VI.53, 12° CDE) ; conditions d\'annulation dans les CGV.')}</p>
        </div>
        <!-- Étape 4 : le formulaire de paiement s'y monte SANS quitter la page
             (issue #26). Reste vide — et invisible — tant que le serveur n'a
             pas ouvert d'intention de paiement, et pour toujours en mode
             simulateur (redirection vers dev-pay.html). -->
        <div class="card" id="payCard" hidden></div>
      </div>
      <aside class="panel-side">
        <div class="card sum">
          <b class="sum-unit">${esc(SELECTED.name)}</b>
          <p class="sum-stay">${t("Arrivée le <b>{date}</b> dès {h}", { date: dlong(SEARCH.checkin), h: esc(hour(PROP.settings.checkinTime)) })}<br>
          ${t("Départ le <b>{date}</b> avant {h}", { date: dlong(SEARCH.checkout), h: esc(hour(checkoutTimeFor(PROP.settings, SEARCH.checkout))) })}</p>
          <p class="small muted">${pl(nightsBetween(SEARCH.checkin, SEARCH.checkout), "nuit", "nuits")} · ${pl(SEARCH.adults, "adulte", "adultes")}${SEARCH.children ? ` + ${pl(SEARCH.children, "enfant", "enfants")}` : ""} · <a href="#" id="editDates">${t("modifier")}</a></p>
          <div id="quoteZone" class="small muted" aria-live="polite" aria-atomic="true">${t("Calcul du devis…")}</div>
        </div>
      </aside>
    </div>`;

  $("holdMin").textContent = String(PROP.settings.holdMinutes ?? 30);
  document.querySelectorAll(".opt").forEach((el) => el.addEventListener("change", refreshQuote));
  document.querySelectorAll(".opt-add").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const on = btn.classList.toggle("on");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? t("✓ Ajouté") : t("+ Ajouter");
      const oid = Number(btn.dataset.oid);
      if (PROP.options.find((o) => o.id === oid)?.perDate) {
        if (on) await openOptionDays(oid);
        else closeOptionDays(oid);
      }
      refreshQuote();
    }),
  );
  let promoTimer = null;
  $("bPromo").addEventListener("input", () => {
    clearTimeout(promoTimer);
    promoTimer = setTimeout(refreshQuote, 450);
  });
  $("editDates").addEventListener("click", (e) => {
    e.preventDefault();
    $("searchCard").scrollIntoView({ behavior: "smooth" });
  });
  $("cgvLink").addEventListener("click", (e) => {
    e.preventDefault();
    // Le lien vit DANS le label de la case : sans cette ligne, un navigateur
    // qui remonte l'événement jusqu'au label cocherait la case en même temps
    // qu'il déplie les CGV (contre-review Gemini 2026-08-28).
    e.stopPropagation();
    const box = $("cgvBox");
    box.style.display = box.style.display === "none" ? "block" : "none";
    if (!box.innerHTML) {
      box.innerHTML = PROP.cgvText?.trim()
        ? (LANG === "nl" ? `<p class="cgv-h"><b>${CGV_NOTE_NL}</b></p>` : "") +
          cgvHtml(PROP.cgvText) +
          // L'article 4.1 renvoie au « pourcentage affiché lors de la
          // réservation » : on le lui donne, pour cet hébergement-ci.
          `<p class="cgv-h"><b>${t("Pour {nom}, le pourcentage d'arrhes de l'article 4.1 est de {pct} %.", { nom: esc(SELECTED.name), pct: depositPct })}</b></p>`
        : `<p>${t("Les conditions générales complètes sont jointes à la confirmation de réservation et consultables à tout moment sur votre voucher en ligne.")}</p>`;
    }
  });
  $("gCgv").addEventListener("change", () => {
    if ($("gCgv").checked) clearCgvError();
    payButtonRefresh();
  });
  for (const [id, zone] of [["gLast", "eLast"], ["gEmail", "eEmail"]]) {
    $(id).addEventListener("input", () => { $(id).removeAttribute("aria-invalid"); $(zone).textContent = ""; });
  }
  $("bPay").addEventListener("click", submitBooking);
  $("mbPay").onclick = submitBooking;
  // Le passage à l'étape 3 est le plus souvent AUTOMATIQUE (auto-sélection du
  // seul hébergement réservable) : sans déplacement du focus, rien n'indique à
  // un utilisateur de lecteur d'écran qu'il est arrivé sur le formulaire.
  $("step3Title").focus({ preventScroll: true });
  $("bookingPanel").scrollIntoView({ behavior: "smooth" });
  mountTurnstile(); // sans clé publique : ne fait rien, et ne charge rien
  await refreshQuote();
}

// Jours choisis par option « à la date » (id → Set de dates) et jours proposés
// par le serveur pour le séjour en cours (id → [{date, taken}]).
let OPT_DAYS = new Map();
let OPT_AVAIL = new Map();

function renderOptionDays(oid) {
  const zone = $("optDays" + oid);
  const avail = OPT_AVAIL.get(oid);
  if (!zone || !avail) return;
  const name = PROP.options.find((o) => o.id === oid)?.name ?? "";
  zone.innerHTML = dayChipsHtml({
    oid,
    days: avail,
    selected: OPT_DAYS.get(oid) ?? new Set(),
    locale: LOCALE,
    esc,
    txt: { group: t("{nom} : choisissez les jours", { nom: name }), taken: t("déjà réservé") },
  });
  zone.querySelectorAll(".day-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const set = OPT_DAYS.get(oid) ?? new Set();
      if (set.has(chip.dataset.date)) set.delete(chip.dataset.date);
      else set.add(chip.dataset.date);
      OPT_DAYS.set(oid, set);
      const on = set.has(chip.dataset.date);
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      refreshQuote();
    }),
  );
}

async function loadOptionDays() {
  const qs = new URLSearchParams({ unitId: String(SELECTED.id), checkin: SEARCH.checkin, checkout: SEARCH.checkout });
  const { options } = await api("/api/public/option-days?" + qs);
  OPT_AVAIL = new Map(options.map((o) => [o.id, o.days]));
  // Un jour devenu indisponible depuis le dernier chargement n'est plus choisi.
  let dropped = 0;
  for (const [oid, set] of OPT_DAYS) {
    const free = new Set((OPT_AVAIL.get(oid) ?? []).filter((d) => !d.taken).map((d) => d.date));
    for (const d of [...set]) if (!free.has(d)) { set.delete(d); dropped++; }
  }
  return dropped;
}

async function openOptionDays(oid) {
  const zone = $("optDays" + oid);
  zone.hidden = false;
  try {
    await loadOptionDays();
    renderOptionDays(oid);
  } catch (e) {
    zone.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
}

/** Un jour vient d'être pris par un autre client : on relit les jours libres,
 *  la rangée se met à jour (le jour pris grisé) et le message s'affiche dessous. */
async function refreshTakenDays(message) {
  let dropped = 0;
  try {
    dropped = await loadOptionDays();
  } catch {
    return 0;
  }
  for (const oid of OPT_AVAIL.keys()) {
    const zone = $("optDays" + oid);
    if (!zone || zone.hidden) continue;
    renderOptionDays(oid);
    zone.insertAdjacentHTML("afterbegin", `<div class="note bad" role="alert">${esc(message)}</div>`);
  }
  return dropped;
}

function closeOptionDays(oid) {
  OPT_DAYS.delete(oid);
  const zone = $("optDays" + oid);
  zone.hidden = true;
  zone.innerHTML = "";
}

function collectOptions() {
  const numbers = [...document.querySelectorAll("input.opt")]
    .map((el) => ({ id: Number(el.dataset.oid), qty: Number(el.value) || 0 }));
  const toggles = [...document.querySelectorAll("button.opt-add.on")].map((el) => {
    const id = Number(el.dataset.oid);
    // Option à la date : un jour au moins, sinon elle n'entre pas dans le devis.
    if (PROP.options.find((o) => o.id === id)?.perDate) {
      return { id, qty: 1, days: [...(OPT_DAYS.get(id) ?? [])].sort() };
    }
    return { id, qty: 1 };
  });
  return [...numbers, ...toggles].filter((o) => o.qty > 0 && (!("days" in o) || o.days.length > 0));
}

/** Vrai quand c'est le tunnel, pas le visiteur, qui a basculé sur « Totalité ». */
let autoFull = false;

function payButtonRefresh() {
  if (!SELECTED) return;
  const ok = QUOTE?.ok === true;
  // MÊME règle sur les deux boutons (issue #41) : le bouton mobile exigeait en
  // plus la case CGV cochée et restait grisé sans dire pourquoi, alors que le
  // bouton desktop laissait cliquer puis affichait un message. On garde la
  // version qui s'explique : cliquable, refus motivé à côté de la case.
  $("bPay").disabled = !ok;
  $("mbPay").disabled = !ok;
  if (!ok) return;
  // Arrivée à moins de `balanceDueDays` jours : l'échéance du solde est déjà
  // passée, le moteur exige la totalité (balanceDueDate = null). Le choix
  // « Arrhes » restait coché alors que le bouton annonçait la totalité : on le
  // grise, on bascule sur « Totalité » et on dit pourquoi. Si le visiteur
  // repart sur des dates lointaines, on lui rend les arrhes par défaut.
  const forcedFull = QUOTE.balanceDueDate == null;
  const depositRadio = document.querySelector('input[name="payMode"][value="deposit"]');
  const fullRadio = document.querySelector('input[name="payMode"][value="full"]');
  if (depositRadio) {
    const lock = forcedFull && !!fullRadio;
    depositRadio.disabled = lock;
    depositRadio.closest("label")?.classList.toggle("off", lock);
    if (forcedFull && depositRadio.checked && fullRadio) {
      fullRadio.checked = true;
      autoFull = true;
    } else if (!forcedFull && autoFull) {
      depositRadio.checked = true;
      autoFull = false;
    }
  }
  const mode = document.querySelector('input[name="payMode"]:checked')?.value;
  const full = mode === "full" || forcedFull;
  const amount = full ? QUOTE.totalCents : QUOTE.depositCents;
  const label = t("Payer {montant} et réserver", { montant: eur(amount) });
  $("bPay").textContent = label;
  $("mbAmount").textContent = eur(amount);
  $("mbLabel").textContent = full ? t("Totalité") : t("Arrhes");
  const note = $("payNote");
  if (note) {
    note.innerHTML = forcedFull && PROP.settings.allowDeposit
      ? t("Arrivée dans moins de {jours} jours : la totalité du séjour est à régler à la réservation.", { jours: PROP.settings.balanceDueDays })
      : !full
        ? t("Reste <b>{solde}</b> à régler au plus tard le <b>{date}</b>. Un e-mail de rappel avec un lien de paiement vous sera envoyé à l'échéance.", { solde: eur(QUOTE.balanceCents), date: dfr(QUOTE.balanceDueDate) })
        : "";
  }
  $("mobileBar").style.display = "flex";
}

/** Libellé d'une ligne de devis côté client (issue #47-2).
 *  Le moteur envoie « 3 nuits semaine · tarif de base » : l'origine du prix
 *  intéresse le back-office, pas le voyageur, qui veut savoir combien coûte
 *  UNE nuit. Repli sur le libellé technique si le moteur ne fournit pas le
 *  prix unitaire (nuits de prix différents regroupées, ancien devis stocké).
 */
function lineLabel(l) {
  return l?.publicLabel && l.unitPriceCents != null
    ? t("{ligne} à {prix} la nuit", { ligne: l.publicLabel, prix: eur(l.unitPriceCents) })
    : (l?.label ?? "");
}

async function refreshQuote() {
  if (!SELECTED) return;
  const seq = ++quoteSeq;
  const zone = $("quoteZone");
  // Le montant affiché n'est plus celui que le serveur facturerait : on ferme
  // le paiement le temps du recalcul (sinon « Payer X € » partirait avec Y €).
  QUOTE = null;
  payButtonRefresh();
  try {
    const { quote } = await api("/api/public/quote", {
      unitId: SELECTED.id,
      ...SEARCH,
      options: collectOptions(),
      promoCode: $("bPromo").value.trim() || null,
    });
    if (seq !== quoteSeq) return; // une saisie plus récente a relancé un devis
    QUOTE = quote;
    if (!quote.ok) {
      const why = quote.errors.includes("option_day_taken")
        ? t("Un des jours choisis vient d'être réservé par un autre client. Choisissez un autre jour.")
        : quote.errors.includes("lead_time")
        ? t("Réservation en ligne au plus tard {jours} avant l'arrivée. Contactez-nous : nous verrons si c'est possible.", { jours: pl(quote.minLeadDays, "jour", "jours") })
        : quote.errors.includes("min_nights")
          ? t("Minimum {n} nuits sur ces dates.", { n: quote.minNights })
          : t("Séjour impossible à ces conditions.");
      zone.innerHTML = `<div class="note bad">${esc(why)}</div>`;
      payButtonRefresh();
      if (quote.errors.includes("option_day_taken")) {
        const dropped = await refreshTakenDays(why);
        if (dropped > 0 && seq === quoteSeq) refreshQuote();
      }
      return;
    }
    const rows = quote.lines
      .map((l) => `<tr><td>${esc(lineLabel(l))}</td><td class="r ${l.amountCents < 0 ? "neg" : ""}">${eur(l.amountCents)}</td></tr>`)
      .join("");
    const depositLine =
      quote.balanceDueDate != null
        ? t("Arrhes de <b>{arrhes}</b> à la réservation, solde de {solde} pour le {date}", { arrhes: eur(quote.depositCents), solde: eur(quote.balanceCents), date: dfr(quote.balanceDueDate) })
        : t("Paiement de la totalité à la réservation");
    zone.innerHTML = `
      <table class="quote">${rows}<tr class="tot"><td>${t("Total")}</td>
        <td class="r">${strikeThrough(quote.totalCents, quote.discountCents)}${eur(quote.totalCents)}</td></tr></table>
      <p class="small muted" style="margin-top:8px">${depositLine}${quote.cautionCents > 0 ? ` · ${t("Caution : {montant} (hors total, demandée avant l'arrivée)", { montant: eur(quote.cautionCents) })}` : ""}</p>
      ${quote.warnings.includes("promo_invalid") ? `<div class="note bad">${t("Code promo invalide ou expiré — devis calculé sans le code.")}</div>` : ""}`;
    payButtonRefresh();
    document.querySelectorAll('input[name="payMode"]').forEach((r) => r.addEventListener("change", payButtonRefresh));
  } catch (e) {
    if (seq !== quoteSeq) return;
    zone.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    QUOTE = null;
    payButtonRefresh();
  }
}

/** Efface le refus posé sur la case CGV (issue #41). */
function clearCgvError() {
  const zone = $("cgvMsg");
  if (zone) zone.textContent = "";
  $("gCgv")?.removeAttribute("aria-invalid");
  $("cgvLabel")?.classList.remove("err");
}

async function submitBooking() {
  const msg = $("bookMsg");
  msg.innerHTML = "";
  clearCgvError();
  const tsMsg = $("turnstileMsg");
  if (tsMsg) tsMsg.textContent = "";
  const captcha = turnstileToken();
  if (captcha === "") {
    // Le widget est là mais la vérification n'a pas (encore) abouti : inutile
    // d'envoyer la requête, le serveur la refuserait avec la même raison.
    if (tsMsg) tsMsg.textContent = t("Le contrôle anti-robot n'est pas encore validé — patientez un instant, puis relancez la réservation.");
    $("turnstileBox")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const lastName = $("gLast").value.trim();
  const email = $("gEmail").value.trim();
  const phone = $("gPhone").value.trim();
  // Chaque refus se lit SOUS son champ, et le focus y va : jamais un bandeau
  // générique en bas de page qui ne dit pas quel champ corriger.
  const bad = [];
  if (lastName.length < 2) bad.push(["gLast", "eLast", t("Indiquez votre nom (2 lettres au moins).")]);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) bad.push(["gEmail", "eEmail", email ? t("Cette adresse e-mail ne semble pas complète (exemple : nom@exemple.be).") : t("Indiquez votre e-mail : c'est là que part votre confirmation.")]);
  for (const id of ["gLast", "gEmail"]) { $(id).removeAttribute("aria-invalid"); $(id === "gLast" ? "eLast" : "eEmail").textContent = ""; }
  if (bad.length) {
    for (const [id, zone, text] of bad) { $(id).setAttribute("aria-invalid", "true"); $(zone).textContent = text; }
    $(bad[0][0]).focus({ preventScroll: true });
    $(bad[0][0]).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  // Refus attaché à SA case : message à côté d'elle et focus posé dessus —
  // même comportement sur mobile et sur desktop (issue #41).
  if (!$("gCgv").checked) {
    $("cgvMsg").textContent = t("Cochez cette case pour continuer : c'est l'acceptation des conditions générales.");
    $("gCgv").setAttribute("aria-invalid", "true");
    $("cgvLabel").classList.add("err");
    $("gCgv").focus({ preventScroll: true });
    $("cgvLabel").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  setStep(4);
  $("bPay").disabled = true;
  $("mbPay").disabled = true;
  $("bPay").textContent = t("Blocage du créneau…");
  try {
    const res = await api("/api/public/bookings", {
      unitId: SELECTED.id,
      ...SEARCH,
      options: collectOptions(),
      promoCode: $("bPromo").value.trim() || null,
      paymentMode: document.querySelector('input[name="payMode"]:checked')?.value || "deposit",
      guest: {
        firstName: $("gFirst").value,
        lastName,
        email,
        phone,
      },
      notes: $("gNotes").value,
      lang: LANG,
      cgvAccepted: true,
      marketingOptIn: $("gOptin").checked,
      // Jeton anti-robot — absent quand la fonctionnalité n'est pas configurée
      ...(captcha ? { turnstileToken: captcha } : {}),
    });
    try { localStorage.removeItem(storeKey()); } catch { /* au pire la reprise re-proposera les dates */ }
    // Le créneau est bloqué à partir de maintenant : le décompte démarre ici et
    // reste visible si le visiteur revient sur le tunnel (issue #16).
    rememberHold(res, {
      checkin: SEARCH.checkin,
      checkout: SEARCH.checkout,
      unitName: SELECTED?.name,
      amountCents: res.amountDueCents,
      email,
    });
    // Le jeton vient d'être consommé. Depuis le paiement intégré (#26) la page
    // ne navigue plus : un retour au formulaire renverrait un jeton mort, et le
    // visiteur se verrait refuser sans comprendre. On réarme tout de suite.
    resetTurnstile();
    // Paiement intégré (issue #26) : le client ne quitte pas la page. Sans clé
    // Stripe, `payment.mode` vaut `redirect` et on repart sur le simulateur
    // local — exactement comme avant.
    if (res.payment?.mode === "element" && res.payment.clientSecret) {
      await showPaymentElement(res.payment, res.amountDueCents);
      return;
    }
    $("bPay").textContent = t("Redirection vers le paiement sécurisé…");
    location.href = res.checkoutUrl;
  } catch (e) {
    setStep(3);
    $("payCard").hidden = true;
    $("guestCard").hidden = false;
    $("bPay").disabled = false;
    payButtonRefresh();
    // Un jeton Turnstile ne vaut qu'une fois : sans réarmement, un second essai
    // serait refusé en `timeout-or-duplicate` alors que le visiteur est humain.
    resetTurnstile();
    if (/option_day_taken/.test(String(e.code ?? ""))) {
      msg.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
      if ((await refreshTakenDays(e.message)) > 0) refreshQuote();
    } else if (/réservé|geboekt/.test(String(e.message))) {
      msg.innerHTML = `<div class="note bad">😔 ${esc(e.message)} — ${t("le calendrier vient d'être mis à jour, relancez une recherche.")}</div>`;
      calCache.clear();
    } else {
      msg.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    }
    // Réservation en cours : le verrou masque le formulaire et #bookMsg avec lui.
    // L'erreur se lit alors dans le bandeau, qui reste visible.
    const holdErr = document.body.classList.contains("hold-locked") ? $("holdErr") : null;
    if (holdErr) {
      holdErr.textContent = e.message;
      $("holdBanner").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      msg.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

/** Monte le formulaire de paiement à la place du formulaire de coordonnées.
 *
 *  Les coordonnées sont déjà enregistrées à ce stade (la réservation existe,
 *  le créneau est bloqué) : les laisser modifiables laisserait croire qu'une
 *  correction est encore possible. Le récapitulatif de droite, lui, reste.
 *
 *  Un échec ici (clé retirée entre-temps, `js.stripe.com` injoignable) remonte
 *  en exception : `submitBooking` remet l'étape 3 et affiche le message, le
 *  hold restant récupérable depuis le bandeau de décompte. */
async function showPaymentElement(payment, amountCents) {
  // La clé publiable vient du serveur AVEC le paiement : un compte Stripe par
  // propriété, donc la clé du compte qui a créé ce PaymentIntent. L'ancien point
  // /payment-config reste le repli (réponses d'un serveur plus ancien).
  const publishableKey = payment.publishableKey || (await paymentConfig()).publishableKey;
  if (!publishableKey) {
    throw new Error(t("Le paiement en ligne est momentanément indisponible — nous pouvons finaliser votre réservation avec vous, écrivez-nous."));
  }
  const card = $("payCard");
  await mountPayment(card, {
    publishableKey,
    clientSecret: payment.clientSecret,
    returnUrl: payment.returnUrl,
    amountLabel: eur(amountCents ?? payment.amountCents),
    title: t("Paiement sécurisé"),
  });
  $("guestCard").hidden = true;
  $("mobileBar").style.display = "none";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Décompte du blocage de créneau
//
// Le texte était statique (« bloqué 30 minutes ») : un visiteur qui prend le
// temps de lire les conditions ne découvrait l'expiration que par un échec de
// paiement. Le décompte est calé sur l'HEURE SERVEUR (l'horloge du poste peut
// dériver de plusieurs minutes) et décompté en local, comme la page de
// simulation dev-pay.html. Il survit au retour depuis la page de paiement.
// ---------------------------------------------------------------------------

const holdKey = () => `gites-hold:${PROPERTY}`;
const sqlToMs = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
let holdTimer = null;

function clearHold() {
  try { sessionStorage.removeItem(holdKey()); } catch { /* navigation privée */ }
}

/** Mémorise l'option posée par l'API et lance le décompte. */
function rememberHold(res, info) {
  if (!res?.holdExpiresAt || !res?.now) return;
  const hold = {
    reference: res.reference,
    checkoutUrl: res.checkoutUrl,
    // dates, hébergement, montant et e-mail : le bandeau les rappelle
    info: info || null,
    // converti tout de suite en horloge locale via l'écart au temps serveur
    expiresAtLocal: Date.now() + Math.max(0, sqlToMs(res.holdExpiresAt) - sqlToMs(res.now)),
  };
  try { sessionStorage.setItem(holdKey(), JSON.stringify(hold)); } catch { /* navigation privée */ }
  startHoldCountdown(hold);
}

function startHoldCountdown(hold) {
  const bar = $("holdBanner");
  if (!bar || !hold?.expiresAtLocal) return;
  clearTimeout(holdTimer);
  bar.hidden = false;
  // Le chiffre qui défile est masqué aux lecteurs d'écran (il serait relu
  // chaque seconde) ; seuls les seuils utiles sont annoncés, dans la zone
  // vocale de la même région aria-live. La structure (texte + boutons) est
  // construite une fois : le tick ne touche que le texte, le focus reste.
  buildHoldBar(bar, hold);
  lockForHold(true);
  const count = $("holdCount");
  const say = $("holdSay");
  let lastSaid = null;

  const announce = (minutes) => {
    const step = minutes <= 0 ? "fin" : minutes <= 1 ? "1" : minutes <= 5 ? "5" : "debut";
    if (step === lastSaid) return;
    lastSaid = step;
    say.textContent =
      step === "fin"
        ? t("Le blocage de votre créneau a expiré.")
        : step === "1"
          ? t("Attention, il reste moins d'une minute avant l'expiration du blocage de votre créneau.")
          : step === "5"
            ? t("Il reste moins de cinq minutes avant l'expiration du blocage de votre créneau.")
            : t("Votre créneau est bloqué pour vous pendant {n} minutes, le temps du paiement.", { n: minutes });
  };

  const tick = () => {
    const left = hold.expiresAtLocal - Date.now();
    if (left <= 0) {
      bar.classList.add("expired");
      count.innerHTML = `⏳ ${t("Le blocage de votre créneau a <b>expiré</b>. Le délai est écoulé, les dates ont été libérées.")}`;
      announce(0);
      holdExpired(bar);
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    bar.classList.remove("expired");
    count.innerHTML = holdBarText(hold, `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    announce(m + 1);
    holdTimer = setTimeout(tick, 1000);
  };
  tick();
}

/** Reprise d'une réservation encore en cours, reconnue par le serveur (#68).
 *
 *  Le sessionStorage ne survit ni à la fermeture de l'onglet ni à un retour par
 *  l'accueil dans une autre fenêtre. Le serveur, lui, reconnaît le visiteur à
 *  son cookie signé et lui rend SES dates : elles ne lui sont plus affichées
 *  comme indisponibles, et le tunnel rouvre l'étape où il s'était arrêté. */
async function restoreOwnHold() {
  let data;
  try {
    data = await api(`/api/public/hold?property=${encodeURIComponent(PROPERTY)}`);
  } catch {
    return "erreur"; // la reprise est un plus : son échec ne bloque pas le tunnel
  }
  const hold = data.hold;
  if (!hold) {
    // Le serveur fait foi : plus de réservation en cours pour ce navigateur
    // (annulée dans un autre onglet, expirée). Une copie locale périmée ne
    // doit ni rouvrir le bandeau ni garder le tunnel verrouillé.
    clearHold();
    clearTimeout(holdTimer);
    const bar = $("holdBanner");
    if (bar) { bar.hidden = true; bar.innerHTML = ""; }
    lockForHold(false);
    return "aucun";
  }
  RESUMED_HOLD = hold;
  selIn = hold.checkin;
  selOut = hold.checkout;
  setPax(hold.adults, hold.children);
  calMonth = selIn.slice(0, 7);
  if (hold.unitSlug) preferredUnit = hold.unitSlug; // rouvre le bon hébergement
  rememberHold({ reference: hold.reference, holdExpiresAt: hold.holdExpiresAt, now: hold.now }, {
    checkin: hold.checkin,
    checkout: hold.checkout,
    unitName: hold.unitName,
    amountCents: hold.amountDueCents,
    email: hold.guestEmail,
  });
  return "hold";
}

/** Reprise après retour depuis la page de paiement (bouton « précédent »). */
function restoreHold() {
  try {
    const hold = JSON.parse(sessionStorage.getItem(holdKey()) ?? "null");
    if (!hold) return;
    if (hold.expiresAtLocal > Date.now()) startHoldCountdown(hold);
    else clearHold();
  } catch { /* stockage indisponible */ }
}

// ---------------------------------------------------------------------------
// Réservation en cours : verrou du tunnel, « Continuer le paiement », « Annuler »
//
// Tant qu'un hold existe pour ce navigateur, dates, hébergement, personnes et
// options ne bougent plus : changer de dates laissait l'ancien créneau bloqué
// sans moyen de l'annuler. Le bandeau est le seul point de sortie.
// ---------------------------------------------------------------------------

function holdBarText(hold, mmss) {
  const i = hold.info;
  const what = i?.checkin && i?.checkout
    ? [
        t("du {du} au {au}", { du: dfr(i.checkin), au: dfr(i.checkout) }),
        i.unitName ? esc(i.unitName) : "",
        Number.isFinite(i.amountCents) ? eur(i.amountCents) : "",
      ].filter(Boolean).join(", ")
    : hold.reference ? t("réservation {ref}", { ref: esc(hold.reference) }) : "";
  return `⏳ ${t("Réservation en cours")}${what ? ` : ${what}` : ""}. ${t("Temps restant :")} <b>${mmss}</b>`;
}

function buildHoldBar(bar, hold) {
  bar.classList.remove("expired");
  bar.innerHTML =
    `<span class="holdinfo"><span id="holdCount" aria-hidden="true"></span><span id="holdSay" class="sr-only"></span></span>` +
    `<span class="holdactions">` +
    `<button type="button" class="btn" id="holdResume">${t("Continuer le paiement")}</button>` +
    `<button type="button" class="btn o" id="holdCancel">${t("Annuler")}</button></span>` +
    `<span id="holdErr" class="holderr" role="alert"></span>`;
  $("holdResume").addEventListener("click", () => continueHoldPayment(hold));
  $("holdCancel").addEventListener("click", () => cancelHold());
  bar.tabIndex = -1;
  bar.focus({ preventScroll: false });
}

/** Fige (ou libère) tout ce qui permet de modifier la sélection. */
function lockForHold(on) {
  document.body.classList.toggle("hold-locked", on);
  for (const id of ["offersCard", "searchCard", "results"]) {
    const el = $(id);
    if (el) el.inert = on;
  }
}

function holdExpired(bar) {
  clearHold();
  RESUMED_HOLD = null;
  lockForHold(false);
  const actions = bar.querySelector(".holdactions");
  if (actions) actions.hidden = true;
  const left = $("bookingPanel");
  if (left) left.innerHTML = "";
  SELECTED = null;
  calCache.clear();
  setStep(1);
  renderCalendar();
  if (selIn && selOut) search();
}

async function continueHoldPayment(hold) {
  const err = $("holdErr");
  err.textContent = "";
  if (!(hold.expiresAtLocal > Date.now())) { // bandeau resté affiché après l'échéance
    err.textContent = t("Impossible de rouvrir le paiement ici. Annulez puis recommencez.");
    return;
  }
  const card = $("payCard");
  if (card && !card.hidden && card.childElementCount) {
    card.scrollIntoView({ behavior: "smooth", block: "start" }); // paiement déjà ouvert sur cette page
    return;
  }
  const btn = $("holdResume");
  btn.disabled = true;
  try {
    const email = hold.info?.email;
    if (email && hold.reference) {
      const res = await api(`/api/public/bookings/${encodeURIComponent(hold.reference)}/pay`, { email });
      // Seul le paiement initial d'un hold actif se rouvre ici : un solde
      // (kind « balance », sans échéance de blocage) relève de la page voucher.
      if ((res.kind !== "deposit" && res.kind !== "full") || !res.holdExpiresAt) {
        err.textContent = t("Impossible de rouvrir le paiement ici. Annulez puis recommencez.");
        return;
      }
      if (res.payment?.mode === "element") {
        let host = $("payCard");
        if (!host) {
          host = document.createElement("div");
          host.className = "card";
          host.id = "payCard";
          $("bookingPanel").appendChild(host);
        }
        host.hidden = false;
        await mountPayment(host, {
          publishableKey: res.payment.publishableKey || (await paymentConfig()).publishableKey,
          clientSecret: res.payment.clientSecret,
          returnUrl: res.payment.returnUrl,
          amountLabel: eur(res.amountCents ?? res.payment.amountCents),
          title: t("Paiement sécurisé"),
        });
        host.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (res.checkoutUrl && (res.kind === "deposit" || res.kind === "full")) { location.href = res.checkoutUrl; return; }
    }
    err.textContent = t("Impossible de rouvrir le paiement ici. Annulez puis recommencez.");
  } catch (e) {
    // Jamais de repli sur l'ancienne adresse de paiement : après un refus du
    // serveur (réservation expirée, annulée, réglée) elle ne vaut plus rien.
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function cancelHold() {
  const err = $("holdErr");
  err.textContent = "";
  const btn = $("holdCancel");
  btn.disabled = true;
  try {
    await api("/api/public/hold/cancel", {});
  } catch (e) {
    err.textContent = e.message; // ex. « Paiement en cours, réessayez dans une minute. »
    btn.disabled = false;
    return;
  }
  clearTimeout(holdTimer);
  clearHold();
  RESUMED_HOLD = null;
  $("holdBanner").hidden = true;
  $("holdBanner").innerHTML = "";
  lockForHold(false);
  $("bookingPanel").innerHTML = "";
  SELECTED = null;
  QUOTE = null;
  calCache.clear();
  setStep(1);
  updateSummary();
  renderCalendar();
  // dates et personnes sont conservées : on relance la recherche, le visiteur
  // peut les modifier ou reprendre
  if (selIn && selOut) search();
  // Focus sur le titre de l'étape des dates + annonce vocale : le bandeau
  // disparaît, le focus ne doit pas se perdre dans le vide.
  const title = $("paxTitle");
  if (title) {
    title.tabIndex = -1;
    title.focus({ preventScroll: false });
  }
  const live = $("holdLive");
  if (live) live.textContent = t("Votre réservation en cours est annulée, les dates sont libérées.");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fillPaxSelects() {
  $("qAd").innerHTML = Array.from({ length: 30 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  $("qCh").innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
  $("qAd").value = "2";
  $("qCh").value = "0";
}

async function initFlow() {
  $("flow").style.display = "block";
  fillPaxSelects();
  try {
    PROP = await api(`/api/public/properties/${encodeURIComponent(PROPERTY)}`);
  } catch {
    $("flow").innerHTML = `<div class="note bad">${t('Domaine introuvable. <a href="/book/">Retour à l\'accueil</a>').replace('href="/book/"', FIXED_PROPERTY ? 'href="/"' : 'href="/book/"')}</div>`;
    return;
  }
  document.title = t("Réserver — {nom}", { nom: PROP.property.name });
  $("propName").textContent = PROP.property.name;
  $("propSub").textContent = t("Réservation directe — paiement sécurisé, sans création de compte");
  $("contactLine").textContent = [PROP.property.contactEmail, PROP.property.contactPhone].filter(Boolean).join(" · ");

  const today = await api("/api/public/today");
  TODAY = today.today;
  calMonth = TODAY.slice(0, 7);
  // Anti-robot : la clé publique n'existe que si le propriétaire l'a
  // configurée. Sans elle, aucun script tiers n'est demandé (issue #6).
  TURNSTILE_KEY = today.turnstileSiteKey || null;
  if (TURNSTILE_KEY) loadTurnstile().catch(() => { /* signalé au montage du widget */ });
  if (today.demo) {
    const banner = document.createElement("div");
    banner.className = "note";
    banner.style.textAlign = "center";
    banner.textContent = t("⚠️ Version de démonstration — tarifs provisoires, paiement simulé (aucun débit réel).");
    $("flow").prepend(banner);
  }
  $("calPrev").addEventListener("click", () => { calMonth = monthShift(calMonth, -1); renderCalendar(); });
  $("calNext").addEventListener("click", () => { calMonth = monthShift(calMonth, 1); renderCalendar(); });
  // Retour au mois en cours, visible seulement quand on s'en est éloigné.
  if ($("calToday")) $("calToday").addEventListener("click", () => { calMonth = TODAY.slice(0, 7); renderCalendar(); });
  $("qAd").addEventListener("change", onSelectionChange);
  $("qCh").addEventListener("change", onSelectionChange);

  // question avant réservation → boîte Messages de la plateforme
  const where = PROP.property.contactEmail;
  $("cWhere").textContent = where
    ? t("Votre message est envoyé à l'équipe des gîtes ({adresse}). Vous recevez la réponse par e-mail, à l'adresse que vous indiquez ici.", { adresse: where })
    : t("Votre message est envoyé à l'équipe des gîtes. Vous recevez la réponse par e-mail, à l'adresse que vous indiquez ici.");
  $("cSend").addEventListener("click", async () => {
    const note = $("cNote");
    note.className = "small";
    note.textContent = "";
    for (const id of ["cName", "cEmail", "cMsg"]) $(id).removeAttribute("aria-invalid");
    const name = $("cName").value.trim(), mail = $("cEmail").value.trim(), msg = $("cMsg").value.trim();
    const miss = name.length < 2 ? "cName" : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail) ? "cEmail" : msg.length < 5 ? "cMsg" : null;
    if (miss) {
      $(miss).setAttribute("aria-invalid", "true");
      note.className = "field-msg";
      note.textContent = miss === "cName" ? t("Indiquez votre nom.") : miss === "cEmail" ? t("Indiquez une adresse e-mail complète : c'est là que nous répondons.") : t("Écrivez votre question (quelques mots suffisent).");
      $(miss).focus();
      return;
    }
    $("cSend").disabled = true;
    try {
      const r = await api("/api/public/contact", { property: PROPERTY, name, email: mail, message: msg, lang: LANG, website: $("cWebsite").value });
      $("cMsg").value = "";
      const ok = $("cOk");
      ok.hidden = false;
      // textContent : le message du client est repris à l'écran sans jamais
      // passer par innerHTML.
      ok.textContent = "";
      const h = document.createElement("b");
      h.textContent = t("✅ Message envoyé — référence {ref}", { ref: r.reference ?? "" });
      const p1 = document.createElement("p");
      p1.textContent = r.ackSent
        ? t("Vous recevez à l'instant un e-mail de confirmation à {email}. Nous vous répondons par e-mail, à la même adresse.", { email: mail })
        : t("Nous vous répondons par e-mail, à {email}.", { email: mail });
      const q = document.createElement("blockquote");
      q.textContent = msg;
      ok.append(h, p1, q);
      ok.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      note.className = "field-msg";
      note.textContent = e.message;
    } finally {
      $("cSend").disabled = false;
    }
  });

  renderOffers(); // remises actives + disponibilité factuelle (sans bloquer)
  // Une réservation encore en cours prime sur tout le reste : c'est elle qui
  // porte les dates réellement bloquées pour ce visiteur (#68).
  const own = await restoreOwnHold();
  if (own !== "hold") {
    // Serveur muet seulement : on reprend la copie locale. Si le serveur a
    // répondu « aucun hold », elle a déjà été effacée.
    if (own === "erreur") restoreHold();
    restoreSelection();
  }
  if (selIn && selOut) {
    calMonth = selIn.slice(0, 7);
    updateSummary();
    persistSelection();
    search();
  }
  await renderCalendar();
}

translateStatic();
mountLangSwitch($("langSwitch"));
if (!PROPERTY) {
  renderLanding();
} else {
  initFlow();
}
