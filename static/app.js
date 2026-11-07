// AIS-navn og registerdata er ukontrollert input: alt settes inn via esc() eller textContent.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const fmtTime = (epoch) => new Date(epoch * 1000).toLocaleTimeString("no-NO");

// ---------- Faner (#maritim, #nettverk, #kildelogg) ----------
function showView(view) {
  const btn = document.querySelector(`.tab[data-view="${view}"]`);
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "maritim") map.invalidateSize();
  if (view === "nettverk") cy.resize();
  if (view === "kildelogg") loadLog();
  if (view === "nyheter") loadNews();
}
function goTo(view) {
  history.replaceState(null, "", `#${view}`);
  showView(view);
}
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  history.replaceState(null, "", `#${btn.dataset.view}`);
  showView(btn.dataset.view);
}));
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

// ---------- Maritim ----------
const CATEGORY_COLORS = {
  last: "#4fb3d9", tank: "#e5534b", passasjer: "#57c785", fiske: "#d4a72c",
  tjeneste: "#b083f0", slep: "#c9875a", militær: "#ff7bd5", hurtigbåt: "#7ee0c3",
  fritid: "#8fa0b3", annet: "#6b7785", ukjent: "#4a5360",
};

const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([64.5, 11], 5);
const kartverket = L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
  maxZoom: 18, className: "dark-tiles", attribution: '&copy; <a href="https://www.kartverket.no/">Kartverket</a> · AIS: Kystverket (NLOD)',
}).addTo(map);
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, attribution: "&copy; OpenStreetMap · AIS: Kystverket (NLOD)",
});
const zoneLayer = L.layerGroup().addTo(map);
const vesselLayer = L.layerGroup().addTo(map);
const layerControl = L.control.layers({ "Kartverket gråtone": kartverket, OpenStreetMap: osm }, { Fartøy: vesselLayer, Soner: zoneLayer }).addTo(map);

const markers = new Map();
let vessels = [];
let trackLine = null;
let selectedMmsi = null;

getJSON("/api/zones").then((zones) => zones.forEach((z) => {
  L.circle([z.lat, z.lon], {
    radius: z.radius_km * 1000, color: z.kategori === "forsvar" ? "#ff7bd5" : "#d4a72c",
    weight: 1, fillOpacity: 0.08, dashArray: "4 4",
  }).bindTooltip(z.navn, { permanent: true, direction: "top", className: "zone-label" }).addTo(zoneLayer);
}));

function passesFilter(v) {
  const q = document.getElementById("vessel-filter").value.trim().toLowerCase();
  if (document.getElementById("only-foreign").checked && v.flagg === "Norge") return false;
  if (!q) return true;
  return String(v.mmsi).includes(q) || (v.navn || "").toLowerCase().includes(q) || v.flagg.toLowerCase().includes(q);
}

function renderVessels() {
  const seen = new Set();
  const counts = {};
  for (const v of vessels) {
    if (!passesFilter(v)) continue;
    seen.add(v.mmsi);
    counts[v.kategori] = (counts[v.kategori] || 0) + 1;
    let m = markers.get(v.mmsi);
    const color = CATEGORY_COLORS[v.kategori] || CATEGORY_COLORS.ukjent;
    if (!m) {
      m = L.circleMarker([v.lat, v.lon], { radius: 4, weight: 1, color: "#0d1117", fillColor: color, fillOpacity: 0.9 });
      m.on("click", () => selectVessel(v.mmsi));
      m.addTo(vesselLayer);
      markers.set(v.mmsi, m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      m.setStyle({ fillColor: color });
    }
    m.unbindTooltip();
    m.bindTooltip(`${esc(v.navn || "Ukjent")} · ${esc(v.flagg)}`);
  }
  for (const [mmsi, m] of markers) {
    if (!seen.has(mmsi)) { vesselLayer.removeLayer(m); markers.delete(mmsi); }
  }
  document.getElementById("legend").innerHTML = Object.entries(CATEGORY_COLORS)
    .filter(([k]) => counts[k])
    .map(([k, c]) => `<span><i class="dot" style="background:${c}"></i>${k} ${counts[k]}</span>`)
    .join("");
}

async function refreshVessels() {
  try {
    vessels = await getJSON("/api/ais/vessels");
    renderVessels();
    if (selectedMmsi) selectVessel(selectedMmsi, false);
  } catch (e) { console.error(e); }
}

async function selectVessel(mmsi, fly = false) {
  selectedMmsi = mmsi;
  const box = document.getElementById("vessel-detail");
  let v;
  try { v = await getJSON(`/api/ais/vessel/${mmsi}`); } catch {
    box.hidden = false;
    box.innerHTML = `<p class="hint">MMSI ${esc(mmsi)} er ikke lenger i strømmen.</p>`;
    return;
  }
  if (trackLine) map.removeLayer(trackLine);
  if (v.spor.length > 1) {
    trackLine = L.polyline(v.spor.map((p) => [p[0], p[1]]), { color: "#4fb3d9", weight: 2, opacity: 0.8 }).addTo(map);
  }
  if (fly && v.lat) map.flyTo([v.lat, v.lon], Math.max(map.getZoom(), 11));
  box.hidden = false;
  box.innerHTML = `
    <div class="detail-title">${esc(v.navn || "Ukjent navn")}</div>
    <dl>
      <dt>MMSI</dt><dd>${esc(v.mmsi)}</dd>
      <dt>Flagg</dt><dd>${esc(v.flagg)}</dd>
      <dt>Kallesignal</dt><dd>${esc(v.kallesignal || "–")}</dd>
      <dt>Type</dt><dd>${esc(v.kategori)}${v.skipstype != null ? ` (${esc(v.skipstype)})` : ""}</dd>
      <dt>Destinasjon</dt><dd>${esc(v.destinasjon || "–")}</dd>
      <dt>Fart / kurs</dt><dd>${v.fart ?? "–"} kn / ${v.kurs ?? "–"}°</dd>
      <dt>Posisjon</dt><dd>${v.lat}, ${v.lon}</dd>
      <dt>Sist hørt</dt><dd>${v.sist ? fmtTime(v.sist) : "–"}</dd>
      <dt>I sone</dt><dd>${v.i_soner.length ? v.i_soner.map(esc).join(", ") : "–"}</dd>
    </dl>
    <p class="hint" style="margin-top:8px">Søk videre:
      <a href="https://www.marinetraffic.com/no/ais/details/ships/mmsi:${encodeURIComponent(v.mmsi)}" target="_blank" rel="noopener">MarineTraffic</a> ·
      <a href="https://www.vesselfinder.com/vessels/details/${encodeURIComponent(v.mmsi)}" target="_blank" rel="noopener">VesselFinder</a>
    </p>`;
}

async function refreshAlerts() {
  try {
    const alerts = await getJSON("/api/ais/alerts");
    document.getElementById("alert-count").textContent = alerts.length ? `(${alerts.length})` : "";
    const ul = document.getElementById("alerts");
    ul.innerHTML = alerts.length ? alerts.map((a, i) => `
      <li class="alert-${a.niva === "høy" ? "hoy" : "middels"}" data-i="${i}">
        <div><b>${esc(a.navn || a.mmsi)}</b> · ${esc(a.flagg)}</div>
        <div>${esc(a.tekst)}: ${esc(a.sone)}</div>
        <div class="meta">${fmtTime(a.tid)} · regel: ${esc(a.regel)}</div>
      </li>`).join("") : '<li class="meta" style="cursor:default">Ingen varsler ennå.</li>';
    ul.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => {
      selectVessel(alerts[li.dataset.i].mmsi, true);
    }));
  } catch (e) { console.error(e); }
}

async function refreshStatus() {
  const el = document.getElementById("ais-status");
  try {
    const s = await getJSON("/api/ais/status");
    el.textContent = s.tilkoblet ? `AIS: ${s.fartoy} fartøy · ${s.meldinger.toLocaleString("no-NO")} meldinger` : "AIS: frakoblet";
    el.classList.toggle("ok", s.tilkoblet);
  } catch { el.textContent = "AIS: server utilgjengelig"; el.classList.remove("ok"); }
}

document.getElementById("vessel-filter").addEventListener("input", renderVessels);
document.getElementById("only-foreign").addEventListener("change", renderVessels);

refreshStatus(); refreshVessels(); refreshAlerts();
setInterval(refreshStatus, 5000);
setInterval(refreshVessels, 10000);
setInterval(refreshAlerts, 10000);

// ---------- Selskapsnettverk ----------
const cy = cytoscape({
  container: document.getElementById("graph"),
  style: [
    { selector: "node", style: {
      label: "data(label)", color: "#d8dee6", "font-size": 10, "text-valign": "bottom", "text-margin-y": 4,
      "text-wrap": "ellipsis", "text-max-width": 140, width: 18, height: 18,
    } },
    { selector: 'node[type="selskap"]', style: { shape: "round-rectangle", "background-color": "#4fb3d9" } },
    { selector: 'node[type="selskap"][!utvidet]', style: { "background-color": "#2a5a6e", "border-width": 1, "border-color": "#4fb3d9" } },
    { selector: 'node[type="person"]', style: { shape: "ellipse", "background-color": "#d4a72c" } },
    { selector: "node[?flagg]", style: { "border-width": 3, "border-color": "#e5534b" } },
    { selector: "node[degree > 1][type=\"person\"]", style: { width: 26, height: 26, "background-color": "#f0c450" } },
    { selector: "edge", style: {
      width: 1, "line-color": "#3a4552", "curve-style": "bezier", "target-arrow-shape": "triangle",
      "target-arrow-color": "#3a4552", "arrow-scale": 0.7, label: "data(label)", "font-size": 8,
      color: "#8592a3", "text-rotation": "autorotate", "text-background-color": "#0d1117", "text-background-opacity": 1,
    } },
    { selector: ":selected", style: { "border-width": 3, "border-color": "#ffffff" } },
  ],
  layout: { name: "preset" },
  wheelSensitivity: 0.3,
});

function mergeNetwork(net, focusId) {
  const added = [];
  for (const n of net.nodes) {
    const existing = cy.getElementById(n.id);
    if (existing.nonempty()) {
      if (n.utvidet) existing.data({ utvidet: true, info: n.data, label: n.label });
      continue;
    }
    added.push({ group: "nodes", data: { id: n.id, label: n.label, type: n.type, utvidet: !!n.utvidet, info: n.data } });
  }
  for (const e of net.edges) {
    const id = `${e.source}->${e.target}:${e.label}`;
    if (cy.getElementById(id).empty()) added.push({ group: "edges", data: { id, ...e } });
  }
  cy.add(added);
  cy.nodes().forEach((n) => n.data("degree", n.connectedEdges().length));
  cy.layout({ name: "cose", animate: false, nodeRepulsion: 9000, idealEdgeLength: 90, randomize: false }).run();
  if (focusId) cy.getElementById(focusId).select();
}

async function expandCompany(orgnr) {
  const detail = document.getElementById("node-detail");
  detail.innerHTML = '<p class="hint">Henter fra Enhetsregisteret…</p>';
  try {
    const former = document.getElementById("include-former").checked;
    const net = await getJSON(`/api/brreg/network/${encodeURIComponent(orgnr)}?tidligere=${former}`);
    if (!net.nodes.length) { detail.innerHTML = '<p class="hint">Fant ikke enheten.</p>'; return; }
    mergeNetwork(net, orgnr);
    showNode(cy.getElementById(orgnr));
  } catch (e) {
    detail.innerHTML = `<p class="hint">Feil ved oppslag: ${esc(e.message)}</p>`;
  }
}

function showNode(node) {
  const d = node.data();
  const detail = document.getElementById("node-detail");
  const links = node.connectedEdges().map((e) => {
    const other = e.source().id() === d.id ? e.target() : e.source();
    return `<li data-id="${esc(other.id())}"><b>${esc(other.data("label"))}</b><div class="meta">${esc(e.data("label"))}</div></li>`;
  }).join("");
  let body;
  if (d.type === "person") {
    body = `
      <div class="detail-title">${esc(d.label)}</div>
      <dl>
        <dt>Fødselsår</dt><dd>${esc(d.info.fodselsaar || "–")}</dd>
        <dt>Roller i grafen</dt><dd>${node.connectedEdges().length}</dd>
      </dl>
      <p class="hint" style="margin-top:8px">Enhetsregisterets åpne API har ikke søk på person. Utvid flere selskaper for å finne felles personer.</p>`;
  } else {
    const i = d.info || {};
    const flags = [i.konkurs && "Konkurs", i.underAvvikling && "Under avvikling", i.slettet && "Slettet"].filter(Boolean);
    body = `
      <div class="detail-title">${esc(d.label)}${flags.map((f) => `<span class="tag">${esc(f)}</span>`).join("")}</div>
      <dl>
        <dt>Org.nr.</dt><dd>${esc(d.id)}</dd>
        ${i.form ? `<dt>Form</dt><dd>${esc(i.form)}</dd>` : ""}
        ${i.naering ? `<dt>Næring</dt><dd>${esc(i.naering)}</dd>` : ""}
        ${i.adresse ? `<dt>Adresse</dt><dd>${esc(i.adresse)}</dd>` : ""}
        ${i.stiftet ? `<dt>Stiftet</dt><dd>${esc(i.stiftet)}</dd>` : ""}
        ${i.ansatte != null ? `<dt>Ansatte</dt><dd>${esc(i.ansatte)}</dd>` : ""}
      </dl>
      ${d.utvidet ? "" : '<button id="expand-btn" style="margin-top:10px">Utvid med roller</button>'}
      <p class="hint" style="margin-top:8px">
        <a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${encodeURIComponent(d.id)}" target="_blank" rel="noopener">Åpne i Brønnøysundregistrene</a>
      </p>`;
  }
  detail.innerHTML = `${body}<h3 style="margin-top:14px">Koblinger</h3><ul class="list">${links}</ul>`;
  const btn = document.getElementById("expand-btn");
  if (btn) btn.addEventListener("click", () => expandCompany(d.id));
  detail.querySelectorAll("li[data-id]").forEach((li) => li.addEventListener("click", () => {
    const n = cy.getElementById(li.dataset.id);
    cy.$(":selected").unselect(); n.select();
    cy.animate({ center: { eles: n }, duration: 300 });
    showNode(n);
  }));
}

cy.on("tap", "node", (evt) => {
  const n = evt.target;
  if (n.data("type") === "selskap" && !n.data("utvidet")) expandCompany(n.id());
  else showNode(n);
});

document.getElementById("org-search").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const q = document.getElementById("org-q").value.trim();
  const ul = document.getElementById("org-results");
  if (!q) return;
  ul.innerHTML = '<li class="meta">Søker…</li>';
  try {
    const results = await getJSON(`/api/brreg/search?q=${encodeURIComponent(q)}`);
    ul.innerHTML = results.length ? results.map((r) => `
      <li data-orgnr="${esc(r.orgnr)}">
        <b>${esc(r.navn)}</b>${r.konkurs ? '<span class="tag">Konkurs</span>' : ""}
        <div class="meta">${esc(r.orgnr)} · ${esc(r.form || "")} · ${esc(r.kommune || "")}</div>
      </li>`).join("") : '<li class="meta">Ingen treff.</li>';
    ul.querySelectorAll("li[data-orgnr]").forEach((li) => li.addEventListener("click", () => expandCompany(li.dataset.orgnr)));
  } catch (e) {
    ul.innerHTML = `<li class="meta">Feil: ${esc(e.message)}</li>`;
  }
});

document.getElementById("graph-reset").addEventListener("click", () => {
  cy.elements().remove();
  document.getElementById("node-detail").innerHTML = '<p class="hint">Grafen er tømt.</p>';
});

// Startvisning: vises så lenge grafen er tom
const EXAMPLES = [
  { orgnr: "923609016", navn: "Equinor", sektor: "Olje og gass" },
  { orgnr: "987059699", navn: "Statkraft", sektor: "Vannkraft" },
  { orgnr: "962986633", navn: "Statnett", sektor: "Strømnett" },
  { orgnr: "983452841", navn: "Gassco", sektor: "Gassrør til Europa" },
  { orgnr: "989795848", navn: "Aker BP", sektor: "Olje og gass" },
  { orgnr: "984851006", navn: "DNB Bank", sektor: "Finans" },
  { orgnr: "982463718", navn: "Telenor", sektor: "Telekom" },
  { orgnr: "943753709", navn: "Kongsberg Gruppen", sektor: "Forsvar og teknologi" },
  { orgnr: "914778271", navn: "Norsk Hydro", sektor: "Aluminium og energi" },
  { orgnr: "986228608", navn: "Yara International", sektor: "Gjødsel og industri" },
];

const examplesEl = document.getElementById("examples");
examplesEl.innerHTML = EXAMPLES.map((e) => `
  <button class="example" data-orgnr="${e.orgnr}">${esc(e.navn)}<small>${esc(e.sektor)}</small></button>`).join("");
examplesEl.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => expandCompany(b.dataset.orgnr)));

document.getElementById("load-all").addEventListener("click", async () => {
  for (const e of EXAMPLES) await expandCompany(e.orgnr);
});

cy.on("add remove", () => { document.getElementById("graph-empty").hidden = cy.elements().nonempty(); });

// ---------- Nyheter ----------
const newsLayer = L.layerGroup();
layerControl.addOverlay(newsLayer, "Nyheter (steder)");
const placeMarkers = new Map();
const newsFilter = { enhet: null, type: null };
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const timeAgo = (epoch) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - epoch) / 60));
  if (m < 60) return `${m} min siden`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} t siden` : `${Math.round(h / 24)} d siden`;
};
const CHIP_CLASS = { ORG: "org", STED: "sted", HENDELSE: "hendelse" };
const entityChip = (e, count) =>
  `<button class="chip ${CHIP_CLASS[e.type]}" data-enhet="${esc(e.tekst)}" data-type="${esc(e.type)}">${esc(e.tekst)}${count ? `<small>${count}</small>` : ""}</button>`;

function newsParams() {
  const p = new URLSearchParams({ timer: document.getElementById("news-hours").value });
  const q = document.getElementById("news-q").value.trim();
  if (q) p.set("q", q);
  if (newsFilter.enhet) p.set("enhet", newsFilter.enhet);
  if (document.getElementById("news-hits").checked) p.set("kun_treff", "true");
  return p;
}

function renderFilterbar() {
  const bar = document.getElementById("news-filterbar");
  if (!newsFilter.enhet) { bar.hidden = true; return; }
  const actions = [];
  if (newsFilter.type === "ORG") actions.push('<button data-act="nettverk">Søk i selskapsnettverk</button>');
  if (newsFilter.type === "STED" && placeMarkers.has(newsFilter.enhet)) actions.push('<button data-act="kart">Vis på kart</button>');
  actions.push('<button data-act="fjern" class="secondary" style="margin:0">Fjern filter</button>');
  bar.innerHTML = `<span>Saker som nevner <b>${esc(newsFilter.enhet)}</b></span>${actions.join("")}`;
  bar.hidden = false;
}

async function loadNews() {
  const hours = document.getElementById("news-hours").value;
  try {
    const [articles, top, status] = await Promise.all([
      getJSON(`/api/news?${newsParams()}`),
      getJSON(`/api/news/entities?timer=${hours}`),
      getJSON("/api/news/status"),
    ]);
    renderFilterbar();
    document.getElementById("news-list").innerHTML = articles.length ? articles.map((a) => `
      <li>
        <div class="meta">${esc(a.kilde)} · ${timeAgo(a.publisert)}</div>
        <a class="title" href="${esc(safeUrl(a.lenke))}" target="_blank" rel="noopener">${esc(a.tittel)}</a>
        ${a.sammendrag ? `<p>${esc(a.sammendrag)}</p>` : ""}
        <div class="chips">
          ${a.treff.map((t) => `<span class="chip treff">${esc(t)}</span>`).join("")}
          ${a.enheter.map((e) => entityChip(e)).join("")}
        </div>
      </li>`).join("") : `<li class="meta">${status.siste_kjoring ? "Ingen saker matcher filteret." : "Henter nyheter for første gang. Det tar et minutt eller to…"}</li>`;
    document.getElementById("top-org").innerHTML = top.ORG.map((e) => entityChip({ ...e, type: "ORG" }, e.antall)).join("");
    document.getElementById("top-sted").innerHTML = top.STED.map((e) => entityChip({ ...e, type: "STED" }, e.antall)).join("");
    document.getElementById("keywords").innerHTML = status.emneord.map((k) => `<span class="chip static">${esc(k)}</span>`).join("");
    const errors = Object.keys(status.feil).length;
    document.getElementById("news-status").textContent =
      `${status.artikler} saker fra ${status.kilder} kilder · ` +
      (status.kjorer ? "henter nå…" : status.siste_kjoring ? `sist hentet ${fmtTime(status.siste_kjoring)}` : "venter på første innhenting") +
      ` · hvert ${status.intervall_min}. min` + (errors ? ` · ${errors} kilde(r) feilet` : "");
  } catch (e) { console.error(e); }
}

async function loadPlaces() {
  try {
    const places = await getJSON("/api/news/places?timer=72");
    newsLayer.clearLayers();
    placeMarkers.clear();
    for (const p of places) {
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 5 + Math.sqrt(p.antall) * 2, color: "#f0c450", weight: 1.5, fillColor: "#f0c450", fillOpacity: 0.25,
      }).bindPopup(`<div class="news-popup"><b>${esc(p.navn)} · ${p.antall} sak${p.antall === 1 ? "" : "er"}</b>${
        p.saker.map((s) => `<a href="${esc(safeUrl(s.lenke))}" target="_blank" rel="noopener">${esc(s.tittel)}</a>`).join("")
      }<span style="color:#8592a3">Omtrentlig plassering (${esc(p.type || "")})</span></div>`);
      m.addTo(newsLayer);
      placeMarkers.set(p.navn, m);
    }
  } catch (e) { console.error(e); }
}

function setNewsFilter(enhet, type) {
  newsFilter.enhet = enhet;
  newsFilter.type = type;
  document.querySelector(".news-main").scrollTop = 0;
  loadNews();
}

document.getElementById("view-nyheter").addEventListener("click", (evt) => {
  const c = evt.target.closest(".chip[data-enhet]");
  if (c) { setNewsFilter(c.dataset.enhet, c.dataset.type); return; }
  const act = evt.target.closest("button[data-act]")?.dataset.act;
  if (act === "fjern") setNewsFilter(null, null);
  if (act === "nettverk") {
    goTo("nettverk");
    document.getElementById("org-q").value = newsFilter.enhet;
    document.getElementById("org-search").requestSubmit();
  }
  if (act === "kart") {
    const m = placeMarkers.get(newsFilter.enhet);
    goTo("maritim");
    map.addLayer(newsLayer);
    map.flyTo(m.getLatLng(), 9);
    map.once("moveend", () => m.openPopup());
  }
});

let newsDebounce;
document.getElementById("news-q").addEventListener("input", () => {
  clearTimeout(newsDebounce);
  newsDebounce = setTimeout(loadNews, 300);
});
document.getElementById("news-hits").addEventListener("change", loadNews);
document.getElementById("news-hours").addEventListener("change", loadNews);

loadPlaces();
setInterval(loadPlaces, 120000);
setInterval(() => { if (document.getElementById("view-nyheter").classList.contains("active")) loadNews(); }, 60000);

if (location.hash) showView(location.hash.slice(1));

// ---------- Kildelogg ----------
async function loadLog() {
  const rows = await getJSON("/api/kildelogg?limit=200");
  document.getElementById("log-rows").innerHTML = rows.map((r) => `
    <tr><td>${esc(r.tidspunkt)}</td><td>${esc(r.kilde)}</td><td>${esc(r.status)}</td>
    <td class="mono">${esc(r.url)}</td><td class="mono">${esc(r.sha256)}</td></tr>`).join("");
}
