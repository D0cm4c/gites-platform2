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
import { mountPayment, paymentConfig } from "./pay-element.js";
import { visionneuse } from "/galerie.js";
import { apiHeaders, CGV_NOTE_NL, eur, hour, LANG, LOCALE, mountLangSwitch, pl, t, translateStatic } from "./i18n.js";

const params = new URLSearchParams(location.search);
const PROPERTY = params.get("property");

const eurRound = (c) => (LANG === "nl" ? `€ ${Math.round(c / 100)}` : `${Math.round(c / 100)} €`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dfr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
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
  if (!res.ok) throw new Error(data.error || t("erreur {status}", { status: res.status }));
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
    days.push({
      date,
      past: perUnit[0].past,
      available: free.length > 0,
      minPrice: free.length ? Math.min(...free.map((d) => d.priceCents)) : null,
      minNights: free.length ? Math.min(...free.map((d) => d.minNights || 1)) : null,
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
    const noArrival = !d.past && d.available && d.arrivalDays != null && !d.arrivalDays.includes(dow(d.date));
    const cls = ["pday", d.past ? "past" : "", !d.past && !d.available ? "full" : "",
      noArrival ? "noarr" : "", isSel ? "sel" : "", inRange ? "range" : ""].join(" ");
    const sub = d.past ? "" : d.available ? (d.minPrice != null ? t("dès {prix}", { prix: eurRound(d.minPrice) }) : "") : t("complet");
    // Le minimum de nuits est écrit DANS la case : c'est la seule façon de le
    // voir avant d'avoir choisi ses dates (impasse n° 5 du parcours au clic).
    const mn = !d.past && d.available && d.minNights > 1 ? `<span class="mn">${t("min {n} n", { n: d.minNights })}</span>` : "";
    const hints = d.past || !d.available ? [] : [
      d.minNights > 1 ? t("{n} nuits minimum", { n: d.minNights }) : "",
      d.arrivalDays != null ? arrivalLabel(d.arrivalDays) : "",
    ].filter(Boolean);
    const title = hints.length ? ` title="${esc(hints.join(" · "))}"` : "";
    const full = new Date(d.date + "T12:00:00Z").toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const role = d.date === selIn ? `, ${t("arrivée")}` : d.date === selOut ? `, ${t("départ")}` : "";
    const aria = ` aria-label="${esc(full + role + (d.past ? "" : d.available ? (d.minPrice != null ? ", " + sub : "") : ", " + t("complet")))}" aria-pressed="${isSel ? "true" : "false"}"`;
    html += `<button type="button" class="${cls}" data-date="${d.date}"${title}${aria} ${d.past ? "disabled" : ""}>
      <span class="d">${Number(d.date.slice(8, 10))}</span><span class="p">${sub}</span>${mn}</button>`;
  }
  $("calGrid").innerHTML = html;
  $("calGrid").querySelectorAll(".pday[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => onDayClick(cell.dataset.date, cell));
  });
  renderCalRules(days);
}

/** Règles de séjour du mois affiché, regroupées par période contiguë (#66).
 *  « Séjour minimum : 7 nuits du 01/07 au 31/07 » — la règle existe depuis
 *  toujours côté moteur ; elle n'était écrite nulle part. */
function renderCalRules(days) {
  const zone = $("calRules");
  if (!zone) return;
  const segments = [];
  for (const d of days) {
    if (d.past || !d.available || d.minNights == null) continue;
    const key = `${d.minNights}|${(d.arrivalDays ?? []).join(",")}`;
    const last = segments.at(-1);
    if (last && last.key === key && nightsBetween(last.to, d.date) === 1) last.to = d.date;
    else segments.push({ key, minNights: d.minNights, arrivalDays: d.arrivalDays, from: d.date, to: d.date });
  }
  const notable = segments.filter((s) => s.minNights > 1 || s.arrivalDays != null);
  if (notable.length === 0) {
    zone.innerHTML = "";
    return;
  }
  const period = (s) => (s.from === s.to ? t("le {date}", { date: dfr(s.from) }) : t("du {du} au {au}", { du: dfr(s.from), au: dfr(s.to) }));
  zone.innerHTML = notable
    .map((s) => {
      const parts = [];
      if (s.minNights > 1) parts.push(`<b>${t("{n} nuits minimum", { n: s.minNights })}</b>`);
      if (s.arrivalDays != null) parts.push(esc(arrivalLabel(s.arrivalDays)));
      return `<span class="rule">${parts.join(", ")} ${esc(period(s))}</span>`;
    })
    .join(" · ");
}

function onDayClick(date, cell) {
  if (cell.classList.contains("past")) return;
  const isFull = cell.classList.contains("full");
  if (!selIn || (selIn && selOut)) {
    if (isFull) return; // un jour complet ne peut pas être une arrivée
    selIn = date;
    selOut = null;
  } else if (date > selIn) {
    selOut = date; // le jour de départ peut être « complet » (rotation le jour même)
  } else {
    if (isFull) return;
    selIn = date;
    selOut = null;
  }
  renderCalendar();
  onSelectionChange();
}

function updateSummary() {
  const zone = $("staySummary");
  if (selIn && selOut) {
    const n = nightsBetween(selIn, selOut);
    zone.innerHTML = `<div class="stay-summary">${t("Séjour du <b>{du}</b> au <b>{au}</b> — {nuits}", { du: dfr(selIn), au: dfr(selOut), nuits: pl(n, "nuit", "nuits") })}</div>`;
  } else if (selIn) {
    zone.innerHTML = `<div class="stay-summary">${t("Arrivée le <b>{date}</b> — choisissez le jour de départ.", { date: dfr(selIn) })}</div>`;
  } else {
    zone.innerHTML = "";
  }
}

// Recherche automatique dès que la sélection est complète (pas de bouton).
let searchTimer = null;

function onSelectionChange() {
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
  SELECTED = PROP.units.find((u) => u.id === unitId);
  QUOTE = null;
  setStep(3);
  // Équipements réservables : bouton « Ajouter » (pas de case à cocher) —
  // mise à disposition d'équipement, pas un service (linge et ménage sont
  // inclus de base dans les frais généraux, jamais en option).
  const optionRows = PROP.options
    .map((o) => {
      const priceLabel = `${eur(o.priceCents)}${o.unitLabel ? " / " + esc(o.unitLabel) : ""}`;
      const input =
        o.pricingMode === "per_unit_qty"
          ? `<input type="number" min="0" max="${o.maxQty ?? 99}" value="0" class="opt" data-oid="${o.id}">`
          : `<button type="button" class="opt-add" data-oid="${o.id}" aria-pressed="false">${t("+ Ajouter")}</button>`;
      return `<div class="opt-row"><span class="name">${esc(o.name)} <span class="muted small">${priceLabel}</span></span>${input}</div>`;
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
          <p class="small muted sum-stay">${t("Du {du} au {au}", { du: dfr(SEARCH.checkin), au: dfr(SEARCH.checkout) })} · ${pl(SEARCH.adults, "adulte", "adultes")}${SEARCH.children ? ` + ${pl(SEARCH.children, "enfant", "enfants")}` : ""}<br>
          ${t("Arrivée dès {arr} · départ avant {dep}", { arr: esc(hour(PROP.settings.checkinTime)), dep: esc(hour(PROP.settings.checkoutTime)) })} · <a href="#" id="editDates">${t("modifier")}</a></p>
          <div id="quoteZone" class="small muted" aria-live="polite" aria-atomic="true">${t("Calcul du devis…")}</div>
        </div>
      </aside>
    </div>`;

  $("holdMin").textContent = String(PROP.settings.holdMinutes ?? 30);
  document.querySelectorAll(".opt").forEach((el) => el.addEventListener("change", refreshQuote));
  document.querySelectorAll(".opt-add").forEach((btn) =>
    btn.addEventListener("click", () => {
      const on = btn.classList.toggle("on");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? t("✓ Ajouté") : t("+ Ajouter");
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

function collectOptions() {
  const numbers = [...document.querySelectorAll("input.opt")]
    .map((el) => ({ id: Number(el.dataset.oid), qty: Number(el.value) || 0 }));
  const toggles = [...document.querySelectorAll("button.opt-add.on")]
    .map((el) => ({ id: Number(el.dataset.oid), qty: 1 }));
  return [...numbers, ...toggles].filter((o) => o.qty > 0);
}

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
  const mode = document.querySelector('input[name="payMode"]:checked')?.value;
  const amount = mode === "full" || QUOTE.balanceDueDate == null ? QUOTE.totalCents : QUOTE.depositCents;
  const label = t("Payer {montant} et réserver", { montant: eur(amount) });
  $("bPay").textContent = label;
  $("mbAmount").textContent = eur(amount);
  $("mbLabel").textContent = mode === "full" || QUOTE.balanceDueDate == null ? t("Totalité") : t("Arrhes");
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
      zone.innerHTML = `<div class="note bad">${quote.errors.includes("min_nights") ? t("Minimum {n} nuits sur ces dates.", { n: quote.minNights }) : t("Séjour impossible à ces conditions.")}</div>`;
      payButtonRefresh();
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
    rememberHold(res);
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
    if (/réservé|geboekt/.test(String(e.message))) {
      msg.innerHTML = `<div class="note bad">😔 ${esc(e.message)} — ${t("le calendrier vient d'être mis à jour, relancez une recherche.")}</div>`;
      calCache.clear();
    } else {
      msg.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    }
    msg.scrollIntoView({ behavior: "smooth", block: "center" });
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
function rememberHold(res) {
  if (!res?.holdExpiresAt || !res?.now) return;
  const hold = {
    reference: res.reference,
    checkoutUrl: res.checkoutUrl,
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
  // vocale de la même région aria-live.
  bar.innerHTML = `<span id="holdCount" aria-hidden="true"></span><span id="holdSay" class="sr-only"></span>`;
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
      count.innerHTML = `⏳ ${t("Le blocage de votre créneau a <b>expiré</b> — ces dates sont de nouveau ouvertes à la vente. Relancez une réservation depuis le calendrier.")}`;
      announce(0);
      clearHold();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const resume = hold.checkoutUrl ? ` · <a href="${esc(hold.checkoutUrl)}">${t("reprendre le paiement")}</a>` : "";
    bar.classList.remove("expired");
    count.innerHTML =
      `⏳ ${t("Créneau bloqué pour vous encore <b>{m} min {s} s</b>", { m, s: String(s).padStart(2, "0") })}` +
      `${hold.reference ? ` · ${t("réservation {ref}", { ref: esc(hold.reference) })}` : ""}${resume}`;
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
    return false; // la reprise est un plus : son échec ne bloque pas le tunnel
  }
  const hold = data.hold;
  if (!hold) return false;
  RESUMED_HOLD = hold;
  selIn = hold.checkin;
  selOut = hold.checkout;
  setPax(hold.adults, hold.children);
  calMonth = selIn.slice(0, 7);
  if (hold.unitSlug) preferredUnit = hold.unitSlug; // rouvre le bon hébergement
  rememberHold({ reference: hold.reference, holdExpiresAt: hold.holdExpiresAt, now: hold.now });
  return true;
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
    $("flow").innerHTML = `<div class="note bad">${t('Domaine introuvable. <a href="/book/">Retour à l\'accueil</a>')}</div>`;
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
  if (!(await restoreOwnHold())) {
    restoreHold(); // une option posée juste avant ? on reprend son décompte
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
