// Site vitrine — intégration live avec la plateforme de réservation :
//  · prix « à partir de » par gîte (tirés du calendrier tarifaire réel)
//  · calendrier de disponibilités (le même moteur que la réservation)
//  · formulaire de contact → boîte Messages du back-office.

import "/arrhes.js";

const PROPERTY = "pre-more";
const eurRound = (c) => `${Math.round(c / 100)} €`;
const $ = (id) => document.getElementById(id);

let TODAY = null;
let calMonth = null;
const calCache = new Map();

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `erreur ${res.status}`);
  return data;
}

function monthShift(month, delta) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

async function loadMonth(month) {
  if (!calCache.has(month)) {
    calCache.set(month, await api(`/api/public/calendar?property=${PROPERTY}&month=${month}`));
  }
  return calCache.get(month);
}

// --- prix « à partir de » par unité (min sur ~60 jours) ----------------------

async function fillFromPrices() {
  try {
    const months = [TODAY.slice(0, 7), monthShift(TODAY.slice(0, 7), 1)];
    const data = await Promise.all(months.map(loadMonth));
    const mins = new Map(); // unitId → min price
    for (const monthData of data) {
      for (const u of monthData.units) {
        for (const d of u.days) {
          if (d.past || d.priceCents == null) continue;
          const cur = mins.get(u.unitId);
          if (cur == null || d.priceCents < cur) mins.set(u.unitId, d.priceCents);
        }
      }
    }
    document.querySelectorAll("[data-price-unit]").forEach((el) => {
      const min = mins.get(Number(el.dataset.priceUnit));
      el.textContent = min != null ? eurRound(min) : "sur demande";
    });
  } catch {
    document.querySelectorAll("[data-price-unit]").forEach((el) => (el.textContent = "sur demande"));
  }
}

// --- calendrier de disponibilités — sélectionnable ---------------------------
// Choisir arrivée + départ ici envoie directement dans le tunnel de réservation
// avec les dates pré-remplies (deep-link ?checkin=&checkout=).

let selIn = null;
let selOut = null;
const dfr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function updateCta() {
  const cta = $("calCta");
  if (!cta) return;
  if (selIn && selOut) {
    cta.textContent = `Réserver du ${dfr(selIn)} au ${dfr(selOut)} →`;
    cta.href = `/book/?property=${PROPERTY}&checkin=${selIn}&checkout=${selOut}`;
    cta.classList.add("pulse");
  } else if (selIn) {
    cta.textContent = `Arrivée le ${dfr(selIn)} — choisissez le départ`;
    cta.href = `/book/?property=${PROPERTY}`;
    cta.classList.remove("pulse");
  } else {
    cta.textContent = "Vérifier mes dates & réserver";
    cta.href = `/book/?property=${PROPERTY}`;
    cta.classList.remove("pulse");
  }
}

function onDayClick(date, cell) {
  if (cell.classList.contains("past")) return;
  const isFull = cell.classList.contains("full");
  if (!selIn || (selIn && selOut)) {
    if (isFull) return; // un jour complet ne peut pas être une arrivée
    selIn = date;
    selOut = null;
  } else if (date > selIn) {
    selOut = date; // le départ peut tomber un jour « complet » (rotation le jour même)
  } else {
    if (isFull) return;
    selIn = date;
    selOut = null;
  }
  renderCalendar();
  updateCta();
}

async function renderCalendar() {
  const data = await loadMonth(calMonth);
  const monthStart = `${calMonth}-01`;
  $("calLabel").textContent = new Date(monthStart + "T12:00:00Z").toLocaleDateString("fr-BE", { month: "long", year: "numeric" });
  $("calPrev").disabled = calMonth <= TODAY.slice(0, 7);
  $("calNext").disabled = calMonth >= monthShift(TODAY.slice(0, 7), 17);

  const nbDays = data.units[0]?.days.length ?? 0;
  const firstDow = (new Date(monthStart + "T12:00:00Z").getUTCDay() + 6) % 7;
  let html = ["L", "M", "M", "J", "V", "S", "D"].map((l) => `<div class="h">${l}</div>`).join("");
  for (let i = 0; i < firstDow; i++) html += `<div class="sday off"></div>`;
  for (let i = 0; i < nbDays; i++) {
    const perUnit = data.units.map((u) => u.days[i]);
    const date = perUnit[0].date;
    const free = perUnit.filter((d) => d.available && d.priceCents != null);
    const past = perUnit[0].past;
    const inRange = selIn && selOut && date > selIn && date < selOut;
    const isSel = date === selIn || date === selOut;
    const cls = ["sday", past ? "past" : "", !past && free.length === 0 ? "full" : "", isSel ? "sel" : "", inRange ? "range" : ""].join(" ");
    const sub = past ? "" : free.length ? `dès ${eurRound(Math.min(...free.map((d) => d.priceCents)))}` : "complet";
    html += `<button type="button" class="${cls}" data-date="${date}" ${past ? "disabled" : ""}><span class="d">${Number(date.slice(8, 10))}</span><span class="p">${sub}</span></button>`;
  }
  $("calGrid").innerHTML = html;
  $("calGrid").querySelectorAll(".sday[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => onDayClick(cell.dataset.date, cell));
  });
}

// --- contact ------------------------------------------------------------------

function wireContact() {
  $("contactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = $("cNote");
    try {
      const r = await api("/api/public/contact", {
        property: PROPERTY,
        name: $("cName").value,
        email: $("cEmail").value,
        message: $("cMsg").value,
        website: $("cWebsite").value, // pot de miel anti-bot
      });
      note.style.display = "block";
      note.style.background = "";
      note.style.color = "";
      // textContent : le message du client est repris à l'écran tel quel, sans HTML.
      const mail = $("cEmail").value.trim();
      note.textContent =
        `✅ Message envoyé à l'équipe des gîtes${r.deliveredTo ? ` (${r.deliveredTo})` : ""}` +
        `${r.reference ? ` — référence ${r.reference}` : ""}.\n` +
        `${r.ackSent ? `Un e-mail de confirmation, qui reprend votre message, vous est envoyé à l'instant à ${mail}. ` : ""}` +
        `Nous vous répondons par e-mail, à la même adresse.\n\nVotre message : « ${$("cMsg").value.trim()} »`;
      $("cMsg").value = "";
    } catch (err) {
      note.style.display = "block";
      note.style.background = "#F8E7E7";
      note.style.color = "#991B1B";
      note.textContent = err.message;
    }
  });
}

(async function init() {
  wireContact();
  try {
    const t = await api("/api/public/today");
    TODAY = t.today;
    calMonth = TODAY.slice(0, 7);
    $("calPrev").addEventListener("click", () => { calMonth = monthShift(calMonth, -1); renderCalendar(); });
    $("calNext").addEventListener("click", () => { calMonth = monthShift(calMonth, 1); renderCalendar(); });
    await Promise.all([renderCalendar(), fillFromPrices()]);
  } catch {
    $("calGrid").innerHTML = '<p style="grid-column:span 7;color:#6B7280;font-size:13px">Calendrier momentanément indisponible — utilisez le bouton « Réserver ».</p>';
  }
})();
