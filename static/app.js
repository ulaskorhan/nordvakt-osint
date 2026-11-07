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
L.control.layers({ "Kartverket gråtone": kartverket, OpenStreetMap: osm }, { Fartøy: vesselLayer, Soner: zoneLayer }).addTo(map);

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

if (location.hash) showView(location.hash.slice(1));

// ---------- Kildelogg ----------
async function loadLog() {
  const rows = await getJSON("/api/kildelogg?limit=200");
  document.getElementById("log-rows").innerHTML = rows.map((r) => `
    <tr><td>${esc(r.tidspunkt)}</td><td>${esc(r.kilde)}</td><td>${esc(r.status)}</td>
    <td class="mono">${esc(r.url)}</td><td class="mono">${esc(r.sha256)}</td></tr>`).join("");
}
