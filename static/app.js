// AIS-navn og registerdata er ukontrollert input: alt settes inn via esc() eller textContent.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Statisk modus (GitHub Pages): ingen server, bare et øyeblikksbilde av oversikten
// som GitHub Actions lager hver time. Se scripts/snapshot.py.
const STATIC = window.NORDVAKT_STATIC === true;
const STATIC_FILES = { "/api/dashboard": "data/dashboard.json", "/api/zones": "data/zones.json", "/api/trends": "data/trends.json" };
if (STATIC) document.body.classList.add("static");
const getJSON = async (url) => {
  if (STATIC && !STATIC_FILES[url]) throw new Error(`Ikke tilgjengelig i statisk versjon: ${url}`);
  const r = await fetch(STATIC ? STATIC_FILES[url] : url);
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
  if (view === "maritim") { map.invalidateSize(); refreshVessels(); refreshAlerts(); }
  if (view === "nettverk") cy.resize();
  if (view === "kildelogg") loadLog();
  if (view === "nyheter") loadNews();
  if (view === "oversikt") loadDashboard();
  if (view === "trender") loadTrends();
}
function goTo(view) {
  history.replaceState(null, "", `#${view}`);
  showView(view);
}
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  history.replaceState(null, "", `#${btn.dataset.view}`);
  showView(btn.dataset.view);
}));
window.addEventListener("hashchange", () => route());

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
      m = L.circleMarker([v.lat, v.lon], { radius: 4, weight: 1, color: "#162a30", fillColor: color, fillOpacity: 0.9 });
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

if (!STATIC) {
  refreshStatus(); refreshVessels(); refreshAlerts();
  setInterval(refreshStatus, 5000);
}
// Rundt 4 000 fartøy: hentes bare når kartet faktisk vises
const mapVisible = () => document.getElementById("view-maritim").classList.contains("active");
setInterval(() => { if (mapVisible()) refreshVessels(); }, 10000);
setInterval(() => { if (mapVisible()) refreshAlerts(); }, 10000);

// ---------- Selskapsnettverk ----------
// Hierarkisk visning: rolleinnehavere som kort til venstre, selskapet til høyre,
// morselskap lenger til høyre. Kortene er farget etter rolletype.
const ROLE_GROUPS = [
  { navn: "Ledelse", farge: "#f0c450", match: /daglig leder|styrets leder|nestleder|innehaver|forretningsfører/i },
  { navn: "Styremedlem", farge: "#4fb3d9", match: /styremedlem/i },
  { navn: "Varamedlem", farge: "#8592a3", match: /vara/i },
  { navn: "Revisor og regnskap", farge: "#b083f0", match: /revisor|regnskap/i },
  { navn: "Andre roller", farge: "#7ee0c3", match: /./ },
];
const roleGroup = (roles) => Math.min(...roles.map((r) => ROLE_GROUPS.findIndex((g) => g.match.test(r))));

// Felles kortstil for begge grafene (Selskapsnettverk og entitetssiden i Søk).
// Nodene trenger data: text (to linjer), w, h og farge.
const CARD_STYLE = [
  { selector: "node", style: {
    shape: "round-rectangle", width: "data(w)", height: "data(h)", label: "data(text)",
    "text-wrap": "wrap", "text-max-width": 300, "text-valign": "center", "text-halign": "center",
    "font-size": 10, "line-height": 1.35, color: "#ece7da",
    "background-color": "#1d343b", "border-width": 1, "border-color": "data(farge)",
  } },
  { selector: "edge", style: {
    width: 1, "line-color": "#3a5961", "curve-style": "taxi", "taxi-direction": "horizontal", "taxi-turn": "50%",
  } },
  { selector: "edge.hl", style: {
    "line-color": "#8592a3", width: 1.5, label: "data(label)", "font-size": 9, color: "#ece7da",
    "text-background-color": "#162a30", "text-background-opacity": 1, "text-background-padding": 2,
  } },
  { selector: ".faded", style: { opacity: 0.15 } },
];

function highlightOnHover(graph) {
  graph.on("mouseover", "node", (evt) => {
    const hood = evt.target.closedNeighborhood();
    graph.elements().not(hood).addClass("faded");
    hood.edges().addClass("hl");
  });
  graph.on("mouseout", "node", () => graph.elements().removeClass("faded hl"));
}

const cy = cytoscape({
  container: document.getElementById("graph"),
  style: [
    ...CARD_STYLE,
    { selector: 'node[kind="hoved"]', style: {
      "background-color": "#1e4a5a", "border-color": "#4fb3d9", "border-width": 2, "font-size": 11, "font-weight": "bold",
    } },
    { selector: 'node[kind="uutvidet"]', style: { "border-style": "dashed", "border-color": "#4fb3d9", color: "#8592a3" } },
    { selector: "node[?delt]", style: { "border-width": 3, "background-color": "#262010" } },
    { selector: "edge.felles", style: { "curve-style": "bezier", "line-color": "#5a4a2d", "line-style": "dashed" } },
    { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 2 } },
  ],
  layout: { name: "preset" },
  minZoom: 0.1,
  maxZoom: 2,
  wheelSensitivity: 0.3,
});

function decorateNodes() {
  cy.nodes().forEach((n) => {
    const asHolder = n.outgoers("edge").filter((e) => e.data("label") !== "Del av");
    const roles = [...new Set(asHolder.map((e) => e.data("label")))];
    const companies = new Set(asHolder.map((e) => e.target().id()));
    const expanded = n.data("type") === "selskap" && n.data("utvidet");
    let kind, sub;
    if (expanded) { kind = "hoved"; sub = `Org.nr. ${n.id()}`; }
    else if (roles.length) { kind = "rolle"; sub = roles.join(" · "); }
    else { kind = "uutvidet"; sub = "Klikk for å utvide"; }
    const group = roles.length && !expanded ? roleGroup(roles) : -1;
    // Fast bredde gir rette kolonner; teksten kortes ned i stedet
    n.data({
      text: [trunc(n.data("label"), 34), trunc(sub, 38)].join("\n"), kind, delt: companies.size > 1,
      w: kind === "hoved" ? 240 : 220,
      h: kind === "hoved" ? 46 : 38,
      farge: group >= 0 ? ROLE_GROUPS[group].farge : "#4a5360",
      rank: kind === "hoved" ? -1 : group >= 0 ? group : 9,
    });
  });
}

// Kjører dagre (venstre mot høyre) på et utsnitt og returnerer posisjoner og omriss
function dagreBlock(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 10, ranksep: 110 });
  g.setDefaultEdgeLabel(() => ({}));
  // Innsettingsrekkefølgen styrer rekkefølgen innenfor en kolonne: ledelse øverst, vara nederst
  nodes.sort((a, b) => a.data("rank") - b.data("rank"))
    .forEach((n) => g.setNode(n.id(), { width: n.data("w"), height: n.data("h") }));
  edges.forEach((e) => {
    if (g.hasNode(e.source().id()) && g.hasNode(e.target().id())) g.setEdge(e.source().id(), e.target().id());
  });
  dagre.layout(g);

  // dagre bytter om på rekkefølgen for å minimere kryssende linjer. Her går nesten alle
  // linjene i en kolonne til samme kort, så vi kan sortere hver kolonne etter rang
  // (ledelse før styre før vara, «+N flere» sist) uten å lage kryss.
  const order = new Map(nodes.sort((a, b) => a.data("rank") - b.data("rank")).map((n, i) => [n.id(), i]));
  const columns = new Map();
  nodes.forEach((n) => {
    const x = Math.round(g.node(n.id()).x);
    columns.set(x, [...(columns.get(x) || []), n.id()]);
  });
  columns.forEach((ids) => {
    const slots = ids.map((id) => g.node(id).y).sort((a, b) => a - b);
    ids.sort((a, b) => order.get(a) - order.get(b)).forEach((id, i) => { g.node(id).y = slots[i]; });
  });

  const pos = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach((n) => {
    const p = g.node(n.id());
    pos[n.id()] = p;
    minX = Math.min(minX, p.x - p.width / 2); maxX = Math.max(maxX, p.x + p.width / 2);
    minY = Math.min(minY, p.y - p.height / 2); maxY = Math.max(maxY, p.y + p.height / 2);
  });
  return { pos, minX, minY, w: maxX - minX, h: maxY - minY };
}

// Ett utvidet selskap: ett organisasjonskart. Flere: én blokk per selskap i et rutenett,
// og det de deler (personer, revisorer) i en egen rad øverst.
function layoutNetwork(focusId) {
  const companies = cy.nodes('[kind="hoved"]');
  cy.edges().removeClass("felles");
  if (companies.length <= 1) {
    const b = dagreBlock(cy.nodes(), cy.edges());
    cy.nodes().forEach((n) => n.position({ x: b.pos[n.id()].x, y: b.pos[n.id()].y }));
    fitReadable(cy.elements());
    return;
  }

  const owners = (n) => {
    const ids = new Set();
    n.outgoers("edge").forEach((e) => { if (e.target().data("kind") === "hoved") ids.add(e.target().id()); });
    n.incomers("edge").forEach((e) => { if (e.source().data("kind") === "hoved") ids.add(e.source().id()); });
    return ids;
  };
  const blockOf = new Map(companies.map((c) => [c.id(), [c]]));
  const shared = [];
  cy.nodes().not(companies).forEach((n) => {
    const o = [...owners(n)];
    if (o.length === 1) blockOf.get(o[0]).push(n); else shared.push(n);
  });

  const GAP_X = 90, GAP_Y = 140, ROW_MAX = 3;
  const blocks = [...blockOf.values()].map((ns) => ({ nodes: ns, ...dagreBlock(cy.collection(ns), cy.edges()) }));
  let x = 0, y = 0, rowH = 0, col = 0, totalW = 0;
  for (const b of blocks) {
    if (col === ROW_MAX) { x = 0; y += rowH + GAP_Y; rowH = 0; col = 0; }
    for (const n of b.nodes) {
      const p = b.pos[n.id()];
      n.position({ x: x + p.x - b.minX, y: y + p.y - b.minY });
    }
    x += b.w + GAP_X; totalW = Math.max(totalW, x - GAP_X); rowH = Math.max(rowH, b.h); col += 1;
  }

  // Felles koblinger: rad(er) over blokkene, sentrert
  const PER_ROW = Math.max(1, Math.floor(totalW / 250));
  shared.sort((a, b) => a.data("rank") - b.data("rank")).forEach((n, i) => {
    const row = Math.floor(i / PER_ROW), inRow = Math.min(PER_ROW, shared.length - row * PER_ROW);
    const start = (totalW - inRow * 250) / 2 + 125;
    n.position({ x: start + (i % PER_ROW) * 250, y: -160 - row * 60 });
  });
  // Kanter mellom blokker (og fra felles-raden) tegnes stiplet og buet i stedet for i trapp
  const blockKey = new Map();
  blockOf.forEach((ns, key) => ns.forEach((n) => blockKey.set(n.id(), key)));
  cy.edges().filter((e) => blockKey.get(e.source().id()) !== blockKey.get(e.target().id())).addClass("felles");

  const focus = focusId && blockOf.get(focusId);
  fitReadable(focus ? cy.collection(focus) : cy.elements());
}

// Tilpass utsnittet, men aldri så langt ut at teksten ikke kan leses ved første blikk
function fitReadable(eles) {
  cy.fit(eles, 30);
  if (cy.zoom() > 1) { cy.zoom(1); cy.center(eles); }
}

highlightOnHover(cy);

document.getElementById("graph-legend").innerHTML =
  ROLE_GROUPS.map((g) => `<span><i style="border-color:${g.farge}"></i>${g.navn}</span>`).join("")
  + '<span><i style="border-color:#4fb3d9;background:#173e4d;border-width:2px"></i>Utvidet selskap</span>'
  + '<span><i style="border-color:#4fb3d9;border-style:dashed"></i>Ikke utvidet</span>'
  + '<span><i style="border-color:#f0c450;background:#262010;border-width:3px"></i>Rolle i flere selskaper</span>';

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
  decorateNodes();
  layoutNetwork(focusId);
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

cy.on("add remove", () => {
  const hasGraph = cy.elements().nonempty();
  document.getElementById("graph-empty").hidden = hasGraph;
  document.getElementById("graph-legend").hidden = !hasGraph;
  document.getElementById("graph-fit").hidden = !hasGraph;
});
document.getElementById("graph-fit").addEventListener("click", () => { cy.stop(true); cy.fit(cy.elements(), 30); });

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

if (!STATIC) {
  loadPlaces();
  setInterval(loadPlaces, 120000);
}
setInterval(() => { if (document.getElementById("view-nyheter").classList.contains("active")) loadNews(); }, 60000);

// ---------- Søk og entiteter ----------
// Ruter: #sok, #sok=<spørring>, #e=<entitets-id>
const TYPES = {
  zone: { flertall: "Overvåkingssoner", entall: "Overvåkingssone", farge: "#ff7bd5" },
  place: { flertall: "Steder", entall: "Sted", farge: "#7ee0c3" },
  org: { flertall: "Organisasjoner", entall: "Organisasjon", farge: "#4fb3d9" },
  vessel: { flertall: "Fartøy", entall: "Fartøy", farge: "#57c785" },
  article: { flertall: "Nyhetssaker", entall: "Nyhetssak", farge: "#f0c450" },
  person: { flertall: "Personer med roller", entall: "Person", farge: "#d4a72c" },
};
const TYPE_ORDER = ["zone", "place", "org", "vessel", "article", "person"];
const PROP_LABELS = {
  orgnr: "Org.nr.", form: "Form", naering: "Næring", adresse: "Adresse", ansatte: "Ansatte", stiftet: "Stiftet",
  status: "Status", mmsi: "MMSI", flagg: "Flagg", kategori: "Kategori", kallesignal: "Kallesignal",
  destinasjon: "Destinasjon", fart: "Fart (kn)", kurs: "Kurs", radius_km: "Radius (km)", operator: "Operatør",
  stedstype: "Stedstype", kommune: "Kommune", medium: "Medium",
};
const TIME_LABEL = { vessel: "Sist hørt", org: "Stiftet", article: "Publisert" };
const entityHref = (id) => `#e=${encodeURIComponent(id)}`;
const typeDot = (t) => `<i class="type-dot" style="background:${TYPES[t]?.farge || "#888"}"></i>`;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function route() {
  if (STATIC) { showView(location.hash === "#trender" ? "trender" : "oversikt"); return; }
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("e=")) { showView("sok"); openEntity(h.slice(2)); }
  else if (h.startsWith("sok=")) { showView("sok"); runSearch(h.slice(4)); }
  else if (h.startsWith("flagg=")) {
    document.getElementById("vessel-filter").value = h.slice(6);
    showView("maritim");
    renderVessels();
  }
  else showView(h || "oversikt");
}

function resultRow(e, rel = "") {
  const inner = `${typeDot(e.type)}<span>${esc(e.label)}</span><span class="meta">${esc(e.beskrivelse || "")}</span>${rel ? `<span class="rel">${esc(rel)}</span>` : ""}`;
  // Personer kan ikke åpnes som egne sider, de vises bare som roller
  return e.type === "person"
    ? `<div class="result-row" style="cursor:default">${inner}</div>`
    : `<a class="result-row" href="${entityHref(e.id)}">${inner}</a>`;
}

function showSearchPart(part) {
  document.getElementById("sok-start").hidden = part !== "start";
  document.getElementById("sok-results").hidden = part !== "results";
  document.getElementById("entity-page").hidden = part !== "entity";
}

async function runSearch(q) {
  document.getElementById("global-q").value = q;
  showSearchPart("results");
  const out = document.getElementById("sok-results");
  out.innerHTML = '<p class="hint">Søker i alle kilder…</p>';
  try {
    const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}`);
    const errors = Object.keys(r.feil);
    out.innerHTML = (r.grupper.length ? r.grupper.map((g) => `
      <div class="result-group">
        <h3>${TYPES[g.type].flertall} <small>${g.treff.length}</small></h3>
        ${g.treff.map((e) => resultRow(e)).join("")}
      </div>`).join("") : `<p class="hint">Ingen treff på «${esc(q)}».</p>`)
      + (errors.length ? `<p class="hint">Svarte ikke: ${errors.map(esc).join(", ")}</p>` : "");
  } catch (e) {
    out.innerHTML = `<p class="hint">Søket feilet: ${esc(e.message)}</p>`;
  }
}

document.getElementById("global-search").addEventListener("submit", (evt) => {
  evt.preventDefault();
  const q = document.getElementById("global-q").value.trim();
  if (!q) return;
  const hash = `#sok=${encodeURIComponent(q)}`;
  if (location.hash === hash) runSearch(q); else location.hash = hash;
});

let entityMap, entityLayer, entityCy;
let entityRequest = 0;

async function openEntity(id) {
  const req = ++entityRequest;
  showSearchPart("entity");
  document.getElementById("entity-head").innerHTML = '<p class="hint">Henter fra alle kilder…</p>';
  let r;
  try {
    r = await getJSON(`/api/entity?id=${encodeURIComponent(id)}`);
  } catch {
    if (req === entityRequest) document.getElementById("entity-head").innerHTML = '<p class="hint">Fant ikke entiteten. Fartøy forsvinner fra strømmen etter 30 minutter uten signal.</p>';
    return;
  }
  if (req !== entityRequest) return; // brukeren har navigert videre
  document.querySelector(".sok-main").scrollTop = 0;
  renderEntityHead(r);
  renderEntityMap(r);
  renderEntityGraph(r);
  renderTimeline(r);
  renderRelated(r);
}

function renderEntityHead(r) {
  const e = r.entity;
  const props = Object.entries(e.props).filter(([k]) => PROP_LABELS[k])
    .map(([k, v]) => `<dt>${PROP_LABELS[k]}</dt><dd>${esc(v)}</dd>`).join("");
  const links = [];
  if (e.props.lenke) links.push(`<a href="${esc(safeUrl(e.props.lenke))}" target="_blank" rel="noopener">Les saken hos ${esc(e.props.medium)}</a>`);
  if (e.id.startsWith("org:")) links.push(`<a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${encodeURIComponent(e.props.orgnr)}" target="_blank" rel="noopener">Åpne i Brønnøysundregistrene</a>`);
  if (e.props.hjemmeside) links.push(`<a href="${esc(safeUrl(/^https?:/.test(e.props.hjemmeside) ? e.props.hjemmeside : `https://${e.props.hjemmeside}`))}" target="_blank" rel="noopener">Hjemmeside</a>`);
  if (e.type === "vessel") links.push(`<a href="https://www.marinetraffic.com/no/ais/details/ships/mmsi:${encodeURIComponent(e.props.mmsi)}" target="_blank" rel="noopener">MarineTraffic</a>`);
  const sources = [...new Set([e.kilde, ...r.relaterte.map((x) => x.kilde), ...r.relasjoner.map((x) => x.kilde)])];
  const errors = Object.keys(r.feil);
  document.getElementById("entity-head").innerHTML = `
    <div class="type-badge">${typeDot(e.type)}${TYPES[e.type].entall}</div>
    <h1>${esc(e.label)}</h1>
    ${e.beskrivelse ? `<p class="desc">${esc(e.beskrivelse)}</p>` : ""}
    ${e.props.uavklart ? '<p class="hint">Navnet er hentet fra nyhetene. Treff i Enhetsregisteret med samme navn vises som «Mulig samme som».</p>' : ""}
    ${props ? `<dl>${props}</dl>` : ""}
    ${links.length ? `<p class="hint" style="margin-top:10px">${links.join(" · ")}</p>` : ""}
    <div class="sources">Kilder: ${sources.map(esc).join(", ")}${errors.length ? ` · Svarte ikke: ${errors.map(esc).join(", ")}` : ""}</div>`;
}

function renderEntityMap(r) {
  if (!entityMap) {
    entityMap = L.map("entity-map", { preferCanvas: true }).setView([64.5, 11], 4);
    L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
      maxZoom: 18, className: "dark-tiles", attribution: "&copy; Kartverket",
    }).addTo(entityMap);
    entityLayer = L.layerGroup().addTo(entityMap);
  }
  entityMap.invalidateSize();
  entityLayer.clearLayers();
  const located = [r.entity, ...r.relaterte].filter((x) => x.lat != null && x.lon != null);
  document.getElementById("entity-map-empty").hidden = located.length > 0;
  for (const x of located) {
    const color = TYPES[x.type].farge;
    if (x.type === "zone") {
      L.circle([x.lat, x.lon], { radius: x.props.radius_km * 1000, color, weight: 1, fillOpacity: 0.08, dashArray: "4 4" }).addTo(entityLayer);
    }
    const center = x.id === r.entity.id;
    L.circleMarker([x.lat, x.lon], {
      radius: center ? 9 : 6, weight: center ? 2 : 1, color: center ? "#ffffff" : "#162a30", fillColor: color, fillOpacity: 0.95,
    }).bindTooltip(esc(x.label)).on("click", () => { location.hash = entityHref(x.id); }).addTo(entityLayer);
  }
  if (located.length === 1) entityMap.setView([located[0].lat, located[0].lon], located[0].type === "zone" ? 11 : 12);
  else if (located.length > 1) entityMap.fitBounds(L.latLngBounds(located.map((x) => [x.lat, x.lon])), { padding: [30, 30], maxZoom: 13 });
}

// Samme kortvisning som Selskapsnettverk: det som peker på entiteten til venstre,
// det entiteten peker på til høyre. Maks GRAPH_PER_TYPE kort per type; resten samles
// i ett «+N flere»-kort (hele listen står under Relatert).
const GRAPH_PER_TYPE = 10;
const GRAPH_PER_TYPE_PERSON = 20; // et helt styre er ofte 15 personer, og det er hele poenget

function renderEntityGraph(r) {
  if (!entityCy) {
    entityCy = cytoscape({
      container: document.getElementById("entity-graph"),
      style: [
        ...CARD_STYLE,
        { selector: 'node[kind="center"]', style: { "background-color": "#24404a", "border-width": 2, "font-size": 11, "font-weight": "bold" } },
        { selector: 'node[kind="mer"]', style: { "border-style": "dashed", color: "#8592a3" } },
        { selector: 'node[kind="rolle"]', style: { color: "#c9d1cb" } },
      ],
      minZoom: 0.2,
      maxZoom: 1.5,
      wheelSensitivity: 0.3,
    });
    entityCy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.data("kind") === "lenke") location.hash = entityHref(n.id());
    });
    highlightOnHover(entityCy);
  }
  entityCy.elements().remove();

  const center = r.entity;
  const labels = relationLabels(r);
  const card = (id, kind, title, sub, farge, rank) => ({
    group: "nodes",
    data: { id, kind, farge, rank, text: [trunc(title, 34), trunc(sub, 38)].join("\n"), w: kind === "center" ? 240 : 220, h: kind === "center" ? 46 : 38 },
  });

  const elements = [card(center.id, "center", center.label, TYPES[center.type].entall, TYPES[center.type].farge, -1)];
  const shown = new Set([center.id]);
  TYPE_ORDER.forEach((t, rank) => {
    const xs = r.relaterte.filter((x) => x.type === t);
    const max = t === "person" ? GRAPH_PER_TYPE_PERSON : GRAPH_PER_TYPE;
    xs.slice(0, max).forEach((x) => {
      const rels = [...new Set(labels.get(x.id) || [])];
      const sub = rels.join(" · ") || TYPES[t].entall;
      // Roller i Enhetsregisteret sorteres som i Selskapsnettverk: ledelse, styre, vara, revisor
      const role = rels.length ? roleGroup(rels) : -1;
      const sortRank = role >= 0 && role < ROLE_GROUPS.length - 1 ? 10 + role : rank;
      // Personer kan ikke åpnes, de vises bare som roller
      elements.push(card(x.id, t === "person" ? "rolle" : "lenke", x.label, sub, TYPES[t].farge, sortRank));
      shown.add(x.id);
    });
    const rest = xs.slice(max);
    if (rest.length) {
      const id = `mer:${t}`;
      elements.push(card(id, "mer", `+${rest.length} flere`, TYPES[t].flertall.toLowerCase(), TYPES[t].farge, rank + 0.5));
      // Samme side som resten av typen: de fleste relasjonene avgjør retningen
      const inbound = r.relasjoner.filter((rel) => rel.til === center.id && rest.some((x) => x.id === rel.fra)).length;
      const [source, target] = inbound * 2 >= rest.length ? [id, center.id] : [center.id, id];
      elements.push({ group: "edges", data: { id: `e-${id}`, source, target, label: "" } });
    }
  });
  r.relasjoner.forEach((rel, i) => {
    if (shown.has(rel.fra) && shown.has(rel.til)) {
      elements.push({ group: "edges", data: { id: `r${i}`, source: rel.fra, target: rel.til, label: rel.label } });
    }
  });
  entityCy.add(elements);

  const b = dagreBlock(entityCy.nodes(), entityCy.edges());
  entityCy.nodes().forEach((n) => n.position({ x: b.pos[n.id()].x, y: b.pos[n.id()].y }));
  // Høyden følger innholdet, slik at kortene kan leses uten å zoome
  document.getElementById("entity-graph-pane").style.height = `${Math.min(900, Math.max(260, b.h * 0.9 + 60))}px`;
  entityCy.resize();
  entityCy.fit(undefined, 24);
  if (entityCy.zoom() > 1) { entityCy.zoom(1); entityCy.center(); }
}

function relationLabels(r) {
  const labels = new Map();
  for (const rel of r.relasjoner) {
    const other = rel.fra === r.entity.id ? rel.til : rel.til === r.entity.id ? rel.fra : null;
    if (!other) continue;
    labels.set(other, [...(labels.get(other) || []), rel.label]);
  }
  return labels;
}

function renderTimeline(r) {
  const items = [r.entity, ...r.relaterte].filter((x) => x.tid).sort((a, b) => b.tid - a.tid).slice(0, 40);
  document.getElementById("entity-timeline").innerHTML = items.length ? items.map((x) => {
    const when = x.type === "org"
      ? new Date(x.tid * 1000).toLocaleDateString("no-NO", { dateStyle: "medium" })
      : new Date(x.tid * 1000).toLocaleString("no-NO", { dateStyle: "medium", timeStyle: "short" });
    const label = x.id === r.entity.id ? `<b>${esc(x.label)}</b>` : `<a href="${entityHref(x.id)}">${esc(x.label)}</a>`;
    return `<li style="--dot:${TYPES[x.type].farge}"><div class="when">${TIME_LABEL[x.type] || "Tid"} ${when} · ${TYPES[x.type].entall}</div>${label}</li>`;
  }).join("") : '<li class="hint">Ingen tidfestede hendelser.</li>';
}

function renderRelated(r) {
  const labels = relationLabels(r);
  const groups = TYPE_ORDER.map((t) => [t, r.relaterte.filter((x) => x.type === t)]).filter(([, xs]) => xs.length);
  document.getElementById("entity-related").innerHTML = groups.length ? groups.map(([t, xs]) => `
    <div class="related-group">
      <h4>${TYPES[t].flertall} (${xs.length})</h4>
      ${xs.slice(0, 50).map((x) => resultRow(x, [...new Set(labels.get(x.id) || [])].join(", "))).join("")}
    </div>`).join("") : '<p class="hint">Ingen kilder fant noe relatert.</p>';
}


// ---------- Kildelogg ----------
async function loadLog() {
  const rows = await getJSON("/api/kildelogg?limit=200");
  document.getElementById("log-rows").innerHTML = rows.map((r) => `
    <tr><td>${esc(r.tidspunkt)}</td><td>${esc(r.kilde)}</td><td>${esc(r.status)}</td>
    <td class="mono">${esc(r.url)}</td><td class="mono">${esc(r.sha256)}</td></tr>`).join("");
}

// ---------- Oversikt ----------
// Et øyeblikksbilde på tvers av kildene. Alt er klikkbart og fører videre til
// entitetssiden, søket eller riktig fane.
const nf = (n) => n.toLocaleString("no-NO");
const dashVisible = () => document.getElementById("view-oversikt").classList.contains("active");
const tip = document.getElementById("dash-tip");
let dashMap, dashLayer;

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(evt.clientX + 14, window.innerWidth - r.width - 8);
  const y = evt.clientY - r.height - 10 < 8 ? evt.clientY + 16 : evt.clientY - r.height - 10;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// Tooltip og klikk på alt som har data-tip / data-href
function wireInteractive(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
    el.addEventListener("mouseleave", hideTip);
  });
  if (STATIC) { root.querySelectorAll(".link").forEach((el) => el.classList.remove("link")); return; }
  root.querySelectorAll("[data-href]").forEach((el) => el.addEventListener("click", () => {
    hideTip();
    location.hash = el.dataset.href;
  }));
}

function tile(label, value, sub, href, tone = "") {
  const tag = STATIC ? "div" : "a";
  return `<${tag} class="dash-tile ${tone}" ${STATIC ? "" : `href="${href}"`}><span class="label">${esc(label)}</span>
    <span class="value">${esc(value)}</span><span class="sub">${sub}</span></${tag}>`;
}

// Kystverkets AIS-strøm svarer ikke fra GitHub Actions. Da vises det i stedet for nuller.
const aisMissing = (d) => STATIC && d.øyeblikksbilde && !d.øyeblikksbilde.ais_tilgjengelig;
const AIS_MISSING = "AIS-strømmen var ikke tilgjengelig da øyeblikksbildet ble laget. Kjør Nordvakt lokalt for sanntidsdata fra Kystverket.";

function renderTiles(d) {
  const a = d.ais, n = d.nyheter, r = d.sammenhenger;
  const noAis = aisMissing(d);
  const delta = n.siste_24 - n.forrige_24;
  const deltaTxt = n.forrige_24 ? `<b class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "↑" : "↓"} ${nf(Math.abs(delta))}</b> mot døgnet før` : "siste 24 timer";
  const high = a.varsler_24["høy"], mid = a.varsler_24.middels;
  // Samme rekkefølge som seksjonene: nyheter, organisasjoner, maritim
  document.getElementById("dash-tiles").innerHTML = [
    tile("Nyhetssaker, 24 t", nf(n.siste_24), deltaTxt, "#nyheter"),
    tile("Emneord-treff, 24 t", nf(n.treff_24), "saker som nevner et emneord", "#nyheter", n.treff_24 ? "warn" : ""),
    tile("Saker med kobling, 72 t", nf(r.saker_med_kobling), "organisasjon og sted i samme sak", "#nyheter"),
    tile("Fartøy nå", noAis ? "–" : nf(a.fartoy), noAis ? "AIS utilgjengelig" : `${nf(a.i_bevegelse)} i bevegelse`, "#maritim"),
    tile("Utenlandske fartøy", noAis ? "–" : nf(a.utenlandske), noAis ? "AIS utilgjengelig" : `${a.antall_flagg} flaggstater`, "#maritim"),
    tile("AIS-varsler, 24 t", noAis ? "–" : nf(high + mid), noAis ? "AIS utilgjengelig" : `${high} høy · ${mid} middels`, "#maritim", high ? "alert" : ""),
  ].join("");
}

// Liggende stolper, én farge: lengden bærer tallet, fargen betyr ingenting ekstra.
function bars(el, rows, opts = {}) {
  if (!rows.length) { el.innerHTML = `<p class="hint">${opts.empty || "Ingen data ennå."}</p>`; return; }
  const max = Math.max(...rows.map((r) => r.antall), 1);
  el.innerHTML = rows.map((r) => `
    <div class="bar-row${r.href ? " link" : ""}" ${r.href ? `data-href="${esc(r.href)}"` : ""} data-tip="${esc(r.tip || `<b>${esc(r.navn)}</b><br>${nf(r.antall)} ${opts.unit || ""}`)}">
      <span class="bar-label" title="${esc(r.navn)}">${esc(r.navn)}</span>
      <span class="bar-track"><i style="width:${r.antall ? Math.max(2, (r.antall / max) * 100) : 0}%"></i></span>
      <span class="bar-value">${nf(r.antall)}</span>
    </div>`).join("");
  wireInteractive(el);
}

const TYPE_NAMES = {
  last: "Last", tank: "Tank", passasjer: "Passasjer", fiske: "Fiske", tjeneste: "Tjeneste", slep: "Slep",
  militær: "Militær", hurtigbåt: "Hurtigbåt", fritid: "Fritid", annet: "Annet", ukjent: "Ukjent type",
};

// Smultring med samme farger som på kartet. Seks største typer, resten slått sammen.
function donut(el, allRows) {
  // Fartøy som ikke har sendt statiske data ennå (skjer hvert 6. min), telles for seg
  const unknown = allRows.find((r) => r.navn === "ukjent")?.antall || 0;
  const rows = allRows.filter((r) => r.navn !== "ukjent");
  const total = rows.reduce((s, r) => s + r.antall, 0);
  const note = unknown ? `<p class="hint donut-note">${nf(unknown)} fartøy har ikke sendt skipstype ennå</p>` : "";
  if (!total) { el.innerHTML = `<p class="hint">Ingen skipstyper mottatt ennå.</p>${note}`; return; }
  const top = rows.slice(0, 6).map((r) => ({ ...r, farge: CATEGORY_COLORS[r.navn], tekst: TYPE_NAMES[r.navn] || r.navn }));
  const rest = rows.slice(6).reduce((s, r) => s + r.antall, 0);
  if (rest) top.push({ navn: "andre", antall: rest, farge: "#3f5a62", tekst: "Andre" });
  const R = 70, r0 = 48, C = 90;
  let ang = -Math.PI / 2;
  const pt = (rad, a) => `${(C + rad * Math.cos(a)).toFixed(2)} ${(C + rad * Math.sin(a)).toFixed(2)}`;
  const segs = top.map((s) => {
    const sweep = (s.antall / total) * Math.PI * 2;
    const gap = Math.min(0.02, sweep / 4);
    const a0 = ang + gap, a1 = ang + sweep - gap;
    ang += sweep;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
    const pct = Math.round((s.antall / total) * 100);
    return `<path d="${path}" fill="${s.farge}" data-tip="<b>${esc(s.tekst)}</b><br>${nf(s.antall)} fartøy · ${pct} %"></path>`;
  }).join("");
  el.innerHTML = `
    <div class="donut">
      <svg viewBox="0 0 180 180" role="img" aria-label="Fartøy fordelt på type">${segs}
        <text x="90" y="88" class="donut-num">${nf(total)}</text><text x="90" y="106" class="donut-lbl">med kjent type</text></svg>
      <ul class="donut-legend">${top.map((s) => `<li><i style="background:${s.farge}"></i>${esc(s.tekst)}<span>${nf(s.antall)}</span></li>`).join("")}</ul>
      ${note}
    </div>`;
  wireInteractive(el);
}

// Søyler per time. Etiketter hver 12. time; tooltip viser timen og antallet.
function newsColumns(el, perHour, refEpoch) {
  const max = Math.max(...perHour, 1);
  const now = new Date(refEpoch * 1000);
  now.setMinutes(0, 0, 0);
  const hourOf = (i) => new Date(now.getTime() - (71 - i) * 3600e3);
  const fmt = (d) => d.toLocaleString("no-NO", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const cols = perHour.map((n, i) => `<div class="col" data-tip="<b>${esc(fmt(hourOf(i)))}</b><br>${n} ${n === 1 ? "sak" : "saker"}"><i style="height:${n ? Math.max(3, (n / max) * 100) : 0}%"></i></div>`).join("");
  const ticks = [0, 24, 48, 71].map((i) => `<span style="left:${((i + 0.5) / 72) * 100}%">${esc(fmt(hourOf(i)))}</span>`).join("");
  el.innerHTML = `
    <div class="cols-wrap">
      <div class="cols-y"><span>${max}</span><span>${Math.round(max / 2)}</span><span>0</span></div>
      <div class="cols-plot"><div class="cols-grid"><i></i><i></i><i></i></div><div class="cols">${cols}</div><div class="cols-x">${ticks}</div></div>
    </div>`;
  wireInteractive(el);
}

function renderDashMap(a) {
  if (!dashMap) {
    dashMap = L.map("dash-map", { preferCanvas: true, zoomControl: false, attributionControl: true }).setView([65, 13], 4);
    L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
      attribution: "© Kartverket", className: "dark-tiles", maxZoom: 18,
    }).addTo(dashMap);
    dashLayer = L.layerGroup().addTo(dashMap);
  }
  dashMap.invalidateSize();
  dashLayer.clearLayers();
  // Norske først, så utenlandske oppå
  const sorted = [...a.posisjoner].sort((p, q) => p[3] - q[3]);
  for (const [lat, lon, mmsi, foreign] of sorted) {
    L.circleMarker([lat, lon], {
      radius: foreign ? 3 : 2, stroke: false, fillOpacity: foreign ? 0.9 : 0.55,
      fillColor: foreign ? "#4fb3d9" : "#5d767d",
    }).on("click", () => { if (!STATIC) location.hash = `e=vessel:${mmsi}`; }).addTo(dashLayer);
  }
  for (const z of zonesCache) {
    L.circle([z.lat, z.lon], { radius: z.radius_km * 1000, color: "#d4a72c", weight: 1.5, fill: false })
      .bindTooltip(esc(z.navn)).on("click", () => { if (!STATIC) location.hash = `e=zone:${z.id}`; }).addTo(dashLayer);
  }
}

function listItems(el, items, empty) {
  el.innerHTML = items.length ? items.join("") : `<li class="hint">${empty}</li>`;
  wireInteractive(el);
}

// ---------- Oversikt: enkel visning, tabeller og sammenhenger ----------
// Lenker virker bare når det står en server bak. I statisk modus blir de ren tekst.
const go = (text, href) => (STATIC ? esc(text) : `<a href="#${esc(href)}">${esc(text)}</a>`);
const artLink = (s) => `<a href="${esc(safeUrl(s.lenke))}" target="_blank" rel="noopener">${esc(s.tittel)}</a>`;
const artMeta = (s) => `${esc(s.kilde)} · ${esc(timeAgo(s.publisert))}`;
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
const brregLine = (b) => [b.form, b.naering, b.kommune && `${b.kommune[0]}${b.kommune.slice(1).toLowerCase()}`,
  b.ansatte ? `${nf(b.ansatte)} ansatte` : null].filter(Boolean).map(esc).join(" · ");
const brregUrl = (orgnr) => `https://virksomhet.brreg.no/nb/oppslag/enheter/${encodeURIComponent(orgnr)}`;

// Enkel visning: én setning om situasjonen, og fire tema å velge mellom.
let briefTopic = null;
function renderBrief(d) {
  const a = d.ais, n = d.nyheter, r = d.sammenhenger;
  const noAis = aisMissing(d) || !a.fartoy;
  const orgs = r.topp_organisasjoner.slice(0, 5);
  const flags = a.flagg.filter((f) => f.navn !== "Norge").slice(0, 3);
  const zones = a.soner.filter((z) => z.naer).slice(0, 3);
  const links = r.koblinger.slice(0, 4);
  const alerts = a.varsler_24["høy"] + a.varsler_24.middels;
  const lead = [
    `De siste 24 timene har Nordvakt lest ${plural(n.siste_24, "nyhetssak", "nyhetssaker")} fra ${n.kilder.length} åpne kilder.`,
    n.treff_24 ? `${plural(n.treff_24, "av dem nevner", "av dem nevner")} et emneord som sabotasje, drone eller kritisk infrastruktur.` : "Ingen av dem nevner et av emneordene som følges.",
    orgs.length ? `Mest omtalt er ${orgs.slice(0, 2).map((o) => o.navn).join(" og ")}.` : "",
    noAis ? "" : `Langs kysten følges ${nf(a.fartoy)} fartøy, og ${nf(a.utenlandske)} av dem seiler under utenlandsk flagg.`,
  ].filter(Boolean).join(" ");

  const topics = [
    { id: "nyheter", title: "Nyheter", num: nf(n.siste_24), cap: "saker siste døgn", body: `
      <p>${n.siste_treff.length ? "Siste saker som nevner et emneord:" : "Ingen saker har nevnt et emneord de siste sju døgnene."}</p>
      <ul>${n.siste_treff.slice(0, 5).map((t) => `<li>${artLink(t)}<small>${artMeta(t)} · emneord: ${t.treff.map(esc).join(", ")}</small></li>`).join("")}</ul>` },
    { id: "selskaper", title: "Selskaper og organisasjoner", num: nf(r.topp_organisasjoner.length), cap: "gjenkjent i nyhetene, 72 t", body: `
      <p>${orgs.length ? "Mest omtalt de siste tre døgnene. Der navnet finnes entydig i Enhetsregisteret, står registeropplysningene under." : "Ingen organisasjoner er gjenkjent i nyhetene ennå."}</p>
      <ul>${orgs.map((o) => `<li><span><b>${go(o.navn, `sok=${o.navn}`)}</b> · ${plural(o.antall, "sak", "saker")}</span>
        <small>${o.brreg ? `<a href="${brregUrl(o.brreg.orgnr)}" target="_blank" rel="noopener">Org.nr. ${esc(o.brreg.orgnr)}</a> · ${brregLine(o.brreg)}` : "Ikke entydig treff i Enhetsregisteret"}${o.steder.length ? `<br>Nevnt sammen med ${o.steder.map(esc).join(", ")}` : ""}</small></li>`).join("")}</ul>` },
    { id: "maritim", title: "Maritim", num: noAis ? "–" : nf(a.fartoy), cap: noAis ? "AIS ikke tilkoblet" : "fartøy langs kysten", body: noAis
      ? `<p>${STATIC ? AIS_MISSING : "AIS-strømmen er ikke tilkoblet akkurat nå."}</p>` : `
      <p>${nf(a.fartoy)} fartøy sender posisjon langs norskekysten. ${nf(a.utenlandske)} er utenlandske, fra ${a.antall_flagg - 1} flaggstater.
        ${alerts ? `${plural(alerts, "varsel", "varsler")} er utløst nær overvåkingssonene siste døgn.` : "Ingen varsler er utløst nær overvåkingssonene siste døgn."}</p>
      <ul>
        ${flags.length ? `<li><span>Flest utenlandske fartøy</span><small>${flags.map((f) => `${esc(f.navn)} (${nf(f.antall)})`).join(", ")}</small></li>` : ""}
        ${zones.length ? `<li><span>Flest fartøy nær en sone</span><small>${zones.map((z) => `${esc(z.navn)} (${nf(z.naer)})`).join(", ")}</small></li>` : ""}
      </ul>
      ${a.uten_flagg ? `<p class="brief-note">Flaggstaten leses fra de tre første sifrene i MMSI-nummeret (MID, en landkode). ${plural(a.uten_flagg, "AIS-sender", "AIS-sendere")} uten gyldig landkode, mest bøyer på fiskeredskap, er holdt utenfor.</p>` : ""}` },
    { id: "sammenhenger", title: "Sammenhenger", num: nf(r.koblinger.length), cap: "koblinger mellom navn og steder", body: `
      <p>${links.length ? "Organisasjoner og steder som nevnes i de samme sakene. Det er en indikator, ikke en påvist forbindelse." : "Ingen koblinger mellom organisasjoner og steder de siste tre døgnene."}</p>
      <ul>${links.map((k) => `<li><span><b>${esc(k.org)}</b> og <b>${esc(k.sted)}</b> · ${plural(k.antall, "sak", "saker")}</span><small>${artLink(k.saker[0])} · ${artMeta(k.saker[0])}</small></li>`).join("")}</ul>` },
  ];
  const open = topics.find((t) => t.id === briefTopic);

  document.getElementById("brief").innerHTML = `
    <p class="brief-lead">${esc(lead)}</p>
    <div class="topics" role="tablist" aria-label="Tema">
      ${topics.map((t, i) => `
        <button class="topic${t.id === briefTopic ? " on" : ""}" role="tab" aria-selected="${t.id === briefTopic}" data-topic="${t.id}">
          <span class="topic-i">0${i + 1}</span>
          <span class="topic-t">${esc(t.title)}</span>
          <span class="topic-n">${t.num}</span>
          <span class="topic-c">${esc(t.cap)}</span>
        </button>`).join("")}
    </div>
    <div id="brief-panel" class="brief-panel${open ? "" : " empty"}" role="tabpanel">
      ${open ? `<h2>${esc(open.title)}</h2>${open.body}` : `<p class="hint">Velg et tema over for å se hva som ligger under.</p>`}
    </div>

    <p class="brief-more"><button id="brief-full">Se full oversikt →</button>
      <span>Kart, grafer, koblinger mellom kildene og kildelogg.</span></p>
    <p class="brief-foot">Kilder: NRK, E24, VG, Teknisk Ukeblad, regjeringen.no, Kystverket AIS, Enhetsregisteret og Kartverket.
      Alt er åpne data, og hvert oppslag logges med tidspunkt og fingeravtrykk.</p>`;
  document.getElementById("brief-full").addEventListener("click", () => setMode("full"));
  document.querySelectorAll(".topic").forEach((b) => b.addEventListener("click", () => {
    briefTopic = briefTopic === b.dataset.topic ? null : b.dataset.topic;
    renderBrief(d);
    const panel = document.getElementById("brief-panel");
    panel.classList.add("enter");
    if (briefTopic && panel.getBoundingClientRect().top > innerHeight * 0.75) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

// Tabell med en liten stolpe i tallkolonnen
const miniBar = (n, max) => `<span class="mini"><i style="width:${Math.max(4, (n / max) * 100)}%"></i></span><span class="num">${nf(n)}</span>`;

function renderOrgTable(el, orgs) {
  if (!orgs.length) { el.innerHTML = '<p class="hint">Ingen organisasjoner gjenkjent ennå.</p>'; return; }
  const max = Math.max(...orgs.map((o) => o.antall));
  el.innerHTML = `<table class="dtable"><thead><tr><th>Organisasjon</th><th>Saker</th><th>Enhetsregisteret</th><th>Nevnt sammen med</th></tr></thead><tbody>
    ${orgs.map((o) => `<tr>
      <td><b>${go(o.navn, `sok=${o.navn}`)}</b></td>
      <td class="barcell">${miniBar(o.antall, max)}</td>
      <td>${o.brreg ? `<a href="${brregUrl(o.brreg.orgnr)}" target="_blank" rel="noopener">${esc(o.brreg.orgnr)}</a> <span class="muted">${brregLine(o.brreg)}</span>` : '<span class="muted">Ikke entydig treff</span>'}</td>
      <td>${o.steder.map((s) => `<span class="pillet">${esc(s)}</span>`).join("") || '<span class="muted">–</span>'}</td>
    </tr>`).join("")}</tbody></table>`;
}

function renderCountries(el, land, noAis) {
  if (!land.length) { el.innerHTML = '<p class="hint">Ingen andre land er nevnt i nyhetene siste 72 timer.</p>'; return; }
  const max = Math.max(...land.map((l) => l.antall));
  el.innerHTML = `<table class="dtable"><thead><tr><th>Land</th><th>Saker</th><th>Organisasjoner i de samme sakene</th><th>Fartøy under flagget nå</th><th>Siste sak</th></tr></thead><tbody>
    ${land.map((l) => `<tr>
      <td><b>${go(l.navn, `sok=${l.navn}`)}</b>${l.overvaket ? ' <span class="sev high">Overvåket flagg</span>' : ""}</td>
      <td class="barcell">${miniBar(l.antall, max)}</td>
      <td>${l.organisasjoner.map((o) => `<span class="pillet">${esc(o)}</span>`).join("") || '<span class="muted">–</span>'}</td>
      <td class="num">${noAis ? '<span class="muted">–</span>' : l.fartoy ? go(nf(l.fartoy), `flagg=${l.navn}`) : '<span class="muted">0</span>'}</td>
      <td class="last">${l.saker[0] ? `${artLink(l.saker[0])} <span class="muted">${artMeta(l.saker[0])}</span>` : ""}</td>
    </tr>`).join("")}</tbody></table>`;
}

function renderLogTable(el, rows) {
  if (!rows.length) { el.innerHTML = '<p class="hint">Ingen oppslag logget ennå.</p>'; return; }
  const when = (iso) => new Date(iso).toLocaleString("no-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<table class="dtable"><thead><tr><th>Kilde</th><th>Oppslag</th><th>Sist hentet</th><th>Status</th><th>SHA-256</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.kilde)}</td><td class="num">${nf(r.oppslag)}</td><td>${esc(when(r.sist))}</td>
      <td><span class="${r.status === 200 ? "ok" : "bad"}">${esc(r.status)}</span></td><td><code title="${esc(r.sha256)}">${esc((r.sha256 || "").slice(0, 16))}…</code></td></tr>`).join("")}</tbody></table>`;
}

// To kolonner med linjer mellom: organisasjoner til venstre, steder til høyre.
// Linjetykkelsen er antall felles saker. Valget huskes mellom oppdateringer.
let relSel = null, relData = null;
function renderRelations(rel) {
  relData = rel;
  const el = document.getElementById("dash-rel");
  if (!rel.koblinger.length) {
    el.innerHTML = '<p class="hint">Ingen organisasjoner og steder er nevnt i samme sak siste 72 timer.</p>';
    document.getElementById("dash-rel-detail").innerHTML = "";
    return;
  }
  const col = (items, kind) => items.map((x) => `<li data-kind="${kind}" data-name="${esc(x.navn)}"><span title="${esc(x.navn)}">${esc(x.navn)}</span><small>${nf(x.antall)}</small></li>`).join("");
  el.innerHTML = `<div class="rel">
    <ul class="rel-col org"><li class="rel-h">Organisasjoner</li>${col(rel.organisasjoner, "org")}</ul>
    <svg class="rel-lines" aria-hidden="true"></svg>
    <ul class="rel-col sted"><li class="rel-h">Steder og land</li>${col(rel.steder, "sted")}</ul>
  </div>`;
  el.querySelectorAll("li[data-kind]").forEach((li) => {
    li.addEventListener("click", () => selectRelation({ [li.dataset.kind]: li.dataset.name }));
    li.addEventListener("mouseenter", () => highlightRelation({ [li.dataset.kind]: li.dataset.name }));
    li.addEventListener("mouseleave", () => highlightRelation(relSel));
  });
  const valid = relSel && rel.koblinger.some((k) => relMatch(k, relSel));
  if (!valid) relSel = { org: rel.koblinger[0].org, sted: rel.koblinger[0].sted };
  drawRelationLines();
  selectRelation(relSel);
}
const relMatch = (k, sel) => (!sel.org || k.org === sel.org) && (!sel.sted || k.sted === sel.sted);

function drawRelationLines() {
  const wrap = document.querySelector("#dash-rel .rel");
  if (!wrap || !wrap.offsetWidth) return;
  const box = wrap.getBoundingClientRect();
  const svg = wrap.querySelector("svg");
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const node = (kind, name) => [...wrap.querySelectorAll(`li[data-kind="${kind}"]`)].find((li) => li.dataset.name === name);
  svg.innerHTML = relData.koblinger.map((k, i) => {
    const l = node("org", k.org).getBoundingClientRect(), r = node("sted", k.sted).getBoundingClientRect();
    const x0 = l.right - box.left + 4, y0 = l.top + l.height / 2 - box.top;
    const x1 = r.left - box.left - 4, y1 = r.top + r.height / 2 - box.top;
    const mid = (x0 + x1) / 2;
    return `<path data-i="${i}" d="M ${x0} ${y0} C ${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1}" stroke-width="${Math.min(1.5 + (k.antall - 1) * 1.5, 7)}"></path>`;
  }).join("");
  svg.querySelectorAll("path").forEach((p) => {
    const k = relData.koblinger[p.dataset.i];
    p.addEventListener("click", () => selectRelation({ org: k.org, sted: k.sted }));
    p.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(k.org)}</b> og <b>${esc(k.sted)}</b><br>${plural(k.antall, "felles sak", "felles saker")}`));
    p.addEventListener("mouseleave", hideTip);
  });
  highlightRelation(relSel);
}

function highlightRelation(sel) {
  const wrap = document.querySelector("#dash-rel .rel");
  if (!wrap || !sel) return;
  const on = relData.koblinger.filter((k) => relMatch(k, sel));
  const orgs = new Set(on.map((k) => k.org)), steder = new Set(on.map((k) => k.sted));
  wrap.querySelectorAll("path").forEach((p) => p.classList.toggle("on", relMatch(relData.koblinger[p.dataset.i], sel)));
  wrap.querySelectorAll("li[data-kind]").forEach((li) => {
    const hit = (li.dataset.kind === "org" ? orgs : steder).has(li.dataset.name);
    li.classList.toggle("on", hit);
    li.classList.toggle("dim", !hit);
  });
}

function selectRelation(sel) {
  relSel = sel;
  highlightRelation(sel);
  const on = relData.koblinger.filter((k) => relMatch(k, sel));
  document.getElementById("dash-rel-title").textContent = sel.org && sel.sted
    ? `${sel.org} og ${sel.sted}` : `Koblinger for ${sel.org || sel.sted}`;
  document.getElementById("dash-rel-detail").innerHTML = on.map((k) => `
    <div class="rel-group">
      <h4><b>${go(k.org, `sok=${k.org}`)}</b> <span class="muted">nevnt sammen med</span> <b>${go(k.sted, `sok=${k.sted}`)}</b> <span class="muted">· ${plural(k.antall, "sak", "saker")}</span></h4>
      <ul class="dash-list">${k.saker.map((s) => `<li><div>${artLink(s)}<br><small>${artMeta(s)}</small></div></li>`).join("")}</ul>
    </div>`).join("") + '<p class="hint rel-note">En kobling betyr at navnene står i samme sak. Les sakene før du trekker en slutning.</p>';
}
new ResizeObserver(() => drawRelationLines()).observe(document.getElementById("dash-rel"));

// Kart over stedene nyhetene handler om
let dashNewsMap, dashNewsLayer;
function renderNewsMap(points) {
  if (!dashNewsMap) {
    dashNewsMap = L.map("dash-newsmap", { zoomControl: false }).setView([65, 13], 4);
    L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
      attribution: "© Kartverket", className: "dark-tiles", maxZoom: 18,
    }).addTo(dashNewsMap);
    dashNewsLayer = L.layerGroup().addTo(dashNewsMap);
  }
  dashNewsMap.invalidateSize();
  dashNewsLayer.clearLayers();
  for (const p of [...points].sort((x, y) => y.antall - x.antall)) {
    L.circleMarker([p.lat, p.lon], { radius: 4 + Math.sqrt(p.antall) * 3, color: "#162a30", weight: 1, fillColor: "#7ee0c3", fillOpacity: 0.75 })
      .bindPopup(`<b>${esc(p.navn)}</b> · ${plural(p.antall, "sak", "saker")}<br>${p.saker.map((s) => `${artLink(s)}<br><small>${artMeta(s)}</small>`).join("<br>")}`, { maxWidth: 280 })
      .addTo(dashNewsLayer);
  }
}

// ---------- Oversikt: innlasting og visningsvalg ----------
let dashMode = "enkel";
try { dashMode = localStorage.getItem("nordvakt-visning") === "full" ? "full" : "enkel"; } catch { /* privat modus */ }
let lastDash = null;

function setMode(mode) {
  dashMode = mode;
  try { localStorage.setItem("nordvakt-visning", mode); } catch { /* privat modus */ }
  if (mode === "full") window.scrollTo(0, 0);
  renderDashboard();
}
document.querySelectorAll(".mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function renderDashboard() {
  document.querySelectorAll(".mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === dashMode));
  document.getElementById("brief").hidden = dashMode !== "enkel";
  document.getElementById("full").hidden = dashMode !== "full";
  if (!lastDash) return;
  if (dashMode === "enkel") renderBrief(lastDash); else renderFull(lastDash);
}

// Stolpekort der hver stolpe kan klikkes for å se sakene bak tallet, i samme kort.
// Virker også i den statiske demoen, siden sakene ligger i dashboard.json.
const storyCardOpen = {};
function storyBars(id, { title, rows, stories, back, detailTitle, empty, sub }) {
  const el = document.getElementById(id);
  const head = el.closest(".card").querySelector(".card-head");
  const h3 = head.querySelector("h3"), hint = head.querySelector(".hint");
  const open = storyCardOpen[id];
  const redraw = () => storyBars(id, { title, rows, stories, back, detailTitle, empty, sub });
  if (open && stories[open]) {
    const list = stories[open];
    const total = rows.find((k) => k.navn === open)?.antall || list.length;
    h3.textContent = detailTitle(open);
    if (hint) hint.hidden = true;
    el.classList.remove("bars");
    el.innerHTML = `<button class="secondary kw-back">← ${esc(back)}</button>
      <p class="hint kw-sum">${plural(total, "sak", "saker")}${total > list.length ? `, de ${list.length} siste vises` : ""}.</p>
      <ul class="dash-list">${list.map((t) => `<li><div>${artLink(t)}<br><small>${artMeta(t)}</small></div></li>`).join("")}</ul>`;
    el.querySelector(".kw-back").addEventListener("click", () => { delete storyCardOpen[id]; redraw(); });
    el.scrollTop = 0;
    return;
  }
  delete storyCardOpen[id];
  h3.textContent = title;
  if (hint) hint.hidden = false;
  el.classList.add("bars");
  bars(el, rows.map((k) => ({ ...k, tip: `<b>${esc(k.navn)}</b><br>${plural(k.antall, "sak", "saker")}${sub ? ` ${sub}` : ""}<br>Klikk for å se sakene` })),
    { unit: "saker", empty });
  el.querySelectorAll(".bar-row").forEach((row, i) => {
    if (!stories[rows[i].navn]) return;
    row.classList.add("link");
    row.addEventListener("click", () => { hideTip(); storyCardOpen[id] = rows[i].navn; redraw(); });
  });
}

function renderKeywords(n) {
  storyBars("dash-keywords", {
    title: "Emneord, siste 7 døgn", rows: n.emneord.slice(0, 10), stories: n.emneord_saker || {},
    back: "Alle emneord", detailTitle: (k) => `«${k}», siste 7 døgn`, empty: "Ingen saker med emneord siste 7 døgn.",
  });
}

function renderCountries7(n) {
  storyBars("dash-places", {
    title: "Mest omtalte land i norske nyheter", rows: n.land || [], stories: n.land_saker || {},
    back: "Alle land", detailTitle: (k) => `${k} i norske nyheter, 72 t`, sub: "siste 72 timer",
    empty: "Ingen andre land er nevnt siste 72 timer.",
  });
}

function renderFull(d) {
  const a = d.ais, n = d.nyheter, r = d.sammenhenger;
  const noAis = aisMissing(d);
  renderTiles(d);

  // 1 Nyheter
  newsColumns(document.getElementById("dash-news"), n.per_time, d.tid);
  document.getElementById("dash-news-total").textContent = `${nf(n.per_time.reduce((s, x) => s + x, 0))} saker fra ${n.kilder.length} kilder`;
  renderKeywords(n);
  listItems(document.getElementById("dash-hits"), n.siste_treff.map((t) => `
    <li><div>${artLink(t)}<br><small>${artMeta(t)} · ${t.treff.map(esc).join(", ")}</small></div></li>`),
    "Ingen saker med emneord siste 7 døgn.");
  renderNewsMap(d.nyhetssteder);
  renderCountries7(n);
  bars(document.getElementById("dash-sources"), n.kilder, { unit: "saker, 72 t" });

  // 2 Selskaper og organisasjoner
  renderOrgTable(document.getElementById("dash-orgtable"), r.topp_organisasjoner);

  // 3 Maritim
  document.getElementById("dash-ais-source").textContent = STATIC
    ? `AIS via ${d.øyeblikksbilde.ais_kilde || "Kystverket"} · siste kjente posisjoner i øyeblikksbildet`
    : "Kystverket AIS · sanntid";
  renderDashMap(a);
  if (noAis) document.getElementById("dash-map").insertAdjacentHTML("beforeend", `<div class="map-note">${AIS_MISSING}</div>`);
  bars(document.getElementById("dash-flags"),
    a.flagg.filter((f) => f.navn !== "Norge").slice(0, 11).map((f) => ({ ...f, href: `flagg=${f.navn}` })), { unit: "fartøy", empty: noAis ? AIS_MISSING : undefined });
  document.getElementById("dash-flags-note").innerHTML = noAis ? "" :
    `Flaggstaten leses fra de tre første sifrene i fartøyets MMSI-nummer (MID, en landkode).${a.uten_flagg
      ? ` ${plural(a.uten_flagg, "AIS-sender", "AIS-sendere")} uten gyldig landkode er holdt utenfor; langs kysten er det mest bøyer på fiskeredskap.` : ""}`;
  if (noAis) document.getElementById("dash-types").innerHTML = `<p class="hint">${AIS_MISSING}</p>`;
  else donut(document.getElementById("dash-types"), a.kategorier);
  bars(document.getElementById("dash-zones"), (noAis ? [] : a.soner).map((z) => ({
    navn: z.navn, antall: z.naer, href: `e=zone:${z.id}`,
    tip: `<b>${esc(z.navn)}</b><br>${z.inne} i sonen, ${z.naer} innen dobbel radius<br>${z.utenlandske} utenlandske`,
  })), { unit: "fartøy", empty: noAis ? AIS_MISSING : undefined });
  listItems(document.getElementById("dash-alerts"), a.siste_varsler.map((v) => `
    <li data-href="e=vessel:${v.mmsi}"><span class="sev ${v.niva === "høy" ? "high" : "mid"}">${v.niva === "høy" ? "Høy" : "Middels"}</span>
      <div><b>${esc(v.navn || `MMSI ${v.mmsi}`)}</b> · ${esc(v.flagg)}<br><small>${esc(v.sone)} · ${esc(fmtTime(v.tid))}</small></div></li>`),
    "Ingen varsler siste døgn.");

  // 4 Sammenhenger, og kildene bak
  renderRelations(r);
  renderCountries(document.getElementById("dash-countries"), r.land, noAis || !a.fartoy);
  renderLogTable(document.getElementById("dash-log"), d.kildelogg);
}

let zonesCache = [];
async function loadDashboard() {
  try {
    if (!zonesCache.length) zonesCache = await getJSON("/api/zones");
    const d = await getJSON("/api/dashboard");
    lastDash = d;
    renderDashboard();
    const when = new Date(d.tid * 1000).toLocaleString("no-NO", { weekday: "long", hour: "2-digit", minute: "2-digit" });
    document.getElementById("dash-updated").textContent = STATIC
      ? `Øyeblikksbilde fra ${when} · nytt hver time`
      : `Oppdatert ${fmtTime(d.tid)} · oppdateres hvert minutt`;
    if (STATIC) {
      const pill = document.getElementById("ais-status");
      pill.textContent = aisMissing(d) ? "Øyeblikksbilde · uten AIS" : `Øyeblikksbilde · ${nf(d.ais.fartoy)} fartøy`;
      pill.classList.add("ok");
    }
  } catch (e) { console.error(e); }
}
setInterval(() => { if (dashVisible() && !STATIC) loadDashboard(); }, 60000);


// ---------- Trender ----------
// Ord i nyhetene over tid. Data fra /api/trends (app/trends.py).
// Farger: kategoriske plasser fra dataviz-paletten (mørk modus), gitt til ordet når det
// velges og beholdt så lenge det er valgt. Fargen følger ordet, ikke rekkefølgen.
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const TREND_DEFAULT = ["russland", "kina", "ki", "drone"];
const trendState = { data: null, range: null, measure: "andel", picked: new Map(), pair: null };
const pct = (v) => `${v.toLocaleString("no-NO", { maximumFractionDigits: 1 })} %`;
const times = (f) => `${f.toLocaleString("no-NO", { maximumFractionDigits: 1 })}×`;
const weekNo = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
};
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("no-NO", { day: "numeric", month: "short" });
const termName = (id) => trendState.data.ord.find((o) => o.id === id)?.navn || id;

function pickTerm(id) {
  const m = trendState.picked;
  if (m.has(id)) { if (m.size > 1) m.delete(id); }
  else if (m.size < SERIES_COLORS.length) {
    const used = new Set(m.values());
    m.set(id, SERIES_COLORS.find((c) => !used.has(c)));
  }
  renderTrendPicker();
  renderTrendChart();
}

function renderTrendPicker() {
  const d = trendState.data;
  const el = document.getElementById("trend-picker");
  el.innerHTML = d.grupper.map((g) => `<div class="pick-group"><span>${esc(g)}</span>${d.ord.filter((o) => o.gruppe === g).map((o) => {
    const c = trendState.picked.get(o.id);
    return `<button class="pick${c ? " on" : ""}" data-id="${o.id}" ${c ? `style="--c:${c}"` : ""} ${!c && trendState.picked.size >= SERIES_COLORS.length ? "disabled" : ""}>${c ? "<i></i>" : ""}${esc(o.navn)}</button>`;
  }).join("")}</div>`).join("") + `<p class="hint pick-hint">Velg opptil ${SERIES_COLORS.length} ord.</p>`;
  el.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => pickTerm(b.dataset.id)));
}

// Linjediagram i SVG: én akse, tynne linjer, hull der arkivet ikke dekker perioden,
// trådkors med verdiene for alle valgte ord.
function renderTrendChart() {
  const d = trendState.data, daily = trendState.range === "dager";
  const el = document.getElementById("trend-chart");
  const labels = daily ? d.daglig.dager : d.uker;
  const covered = daily ? d.daglig.dekket : d.dekket;
  const totals = daily ? d.daglig.saker : d.saker;
  const valuesOf = (id) => {
    const src = daily ? d.daglig.ord[id] : d.ord.find((o) => o.id === id);
    return trendState.measure === "andel" ? src.andel : src.antall.map((n, i) => (covered[i] ? n : null));
  };
  const series = [...trendState.picked].map(([id, color]) => ({ id, color, navn: termName(id), v: valuesOf(id) }));
  document.getElementById("trend-chart-title").textContent = trendState.measure === "andel"
    ? (daily ? "Andel av sakene som nevner ordet, tre dagers snitt" : "Andel av ukens saker som nevner ordet")
    : `Antall saker per ${daily ? "dag" : "uke"} som nevner ordet`;

  const W = Math.max(el.clientWidth, 320), H = 300, m = { t: 14, r: series.length <= 4 ? 96 : 16, b: 28, l: 40 };
  const n = labels.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(...series.flatMap((s) => s.v.filter((x) => x != null)), trendState.measure === "andel" ? 1 : 2);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + ih - (v / top) * ih;
  const fmtV = (v) => (trendState.measure === "andel" ? pct(v) : nf(v));

  let grid = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${m.l - 6}" y="${y(v) + 4}" class="ya">${trendState.measure === "andel" ? `${+v.toFixed(1)}%` : v}</text>`;
  }
  // Grå felt der arkivet ennå ikke dekker perioden
  let gaps = "", start = null;
  covered.forEach((c, i) => {
    if (!c && start === null) start = i;
    if ((c || i === n - 1) && start !== null) {
      const end = c ? i - 1 : i;
      const x0 = Math.max(m.l, x(start) - iw / (2 * (n - 1))), x1 = Math.min(W - m.r, x(end) + iw / (2 * (n - 1)));
      gaps += `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${ih}" class="gap"/>`;
      if (x1 - x0 > 110) gaps += `<text x="${(x0 + x1) / 2}" y="${m.t + ih / 2}" class="gap-t">Ikke samlet ennå</text>`;
      start = null;
    }
  });
  // Én etikett per ~80 px, talt bakfra slik at siste dag/uke alltid har etikett
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 80))));
  const xt = labels.map((l, i) => ((n - 1 - i) % every === 0 ? `<text x="${x(i)}" y="${H - 8}" class="xa">${daily ? dayLabel(l) : `Uke ${weekNo(l)}`}</text>` : "")).join("");
  const paths = series.map((s) => {
    let dPath = "", pen = false;
    s.v.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      dPath += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    const dots = s.v.map((v, i) => (v != null && (s.v[i - 1] == null && s.v[i + 1] == null) ? `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>` : "")).join("");
    return `<path d="${dPath}" stroke="${s.color}" class="ln"/>${dots}`;
  }).join("");
  // Direkte etiketter ved siste verdi (bare når det er plass, maks fire serier)
  let ends = "";
  if (series.length <= 4) {
    const placed = series.map((s) => {
      const i = s.v.map((v, k) => (v == null ? -1 : k)).filter((k) => k >= 0).pop();
      return i == null ? null : { s, yy: y(s.v[i]) };
    }).filter(Boolean).sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < placed.length; k++) placed[k].yy = Math.max(placed[k].yy, placed[k - 1].yy + 14);
    ends = placed.map((p) => `<text x="${W - m.r + 8}" y="${p.yy + 4}" class="endl"><tspan fill="${p.s.color}">●</tspan> ${esc(p.s.navn)}</text>`).join("");
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Linjediagram over ordbruk">
    ${gaps}${grid}${xt}${paths}${ends}
    <line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
    <g class="hover-dots"></g>
    <rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), hd = svg.querySelector(".hover-dots");
  svg.querySelector(".hit").addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) * (W / r.width) - m.l) / (n === 1 ? 1 : iw / (n - 1)))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    hd.innerHTML = series.map((s) => (s.v[i] == null ? "" : `<circle cx="${x(i)}" cy="${y(s.v[i])}" r="4.5" fill="${s.color}" stroke="#1d343b" stroke-width="2"/>`)).join("");
    const head = daily ? new Date(`${labels[i]}T12:00:00`).toLocaleDateString("no-NO", { weekday: "long", day: "numeric", month: "long" }) : `Uke ${weekNo(labels[i])} (fra ${dayLabel(labels[i])})`;
    const rows = covered[i]
      ? [...series].sort((a, b) => (b.v[i] ?? -1) - (a.v[i] ?? -1)).map((s) => `<div class="tt-row"><i style="background:${s.color}"></i>${esc(s.navn)}<b>${fmtV(s.v[i] ?? 0)}</b></div>`).join("") + `<div class="tt-foot">${nf(totals[i])} saker totalt</div>`
      : `<div class="tt-foot">Arkivet dekker ikke denne perioden ennå</div>`;
    showTip(e, `<b>${esc(head)}</b>${rows}`);
  });
  svg.querySelector(".hit").addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hd.innerHTML = ""; hideTip(); });
  const first = daily ? d.daglig.dager[d.daglig.dekket.indexOf(true)] : d.dekning_fra;
  document.getElementById("trend-coverage").textContent = first
    ? `Arkivet dekker fra ${new Date(`${first}T12:00:00`).toLocaleDateString("no-NO", { day: "numeric", month: "long", year: "numeric" })}. Grå felt fylles etter hvert som arkivet vokser.`
    : "Arkivet har for få saker ennå.";
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) || p * 10;
}

function renderMovers(d) {
  const rows = d.siste_7.ord.filter((o) => o.antall >= 5 && o.faktor != null).sort((a, b) => b.faktor - a.faktor).slice(0, 4);
  const el = document.getElementById("trend-movers");
  if (!rows.length) { el.innerHTML = '<p class="hint">For få saker siste sju dager til å si noe ennå.</p>'; return; }
  el.innerHTML = rows.map((o) => `
    <div class="mover">
      <div class="mv-top"><span class="mv-name">${esc(o.navn)}</span><span class="mv-f ${o.faktor >= 2 ? "hot" : ""}">${times(o.faktor)} vanlig</span></div>
      <div class="mv-n">${plural(o.antall, "sak", "saker")} <span class="muted">· ${pct(o.andel)} av alle</span></div>
      ${o.sammen_med.length ? `<div class="mv-with">Oftest sammen med ${o.sammen_med.map((k) => `<b>${esc(termName(k))}</b>`).join(", ")}</div>` : ""}
      ${o.tittel ? `<div class="mv-art">${artLink(o.tittel)}<small>${artMeta(o.tittel)}</small></div>` : ""}
    </div>`).join("");
}

// Matrise: ord med treff, gruppert. Sekvensiell blåskala etter antall felles saker.
const SEQ = ["#24404a", "#184f95", "#1c5cab", "#256abf", "#3987e5", "#5598e7", "#86b6ef"];
function renderMatrix(d) {
  const terms = d.ord.filter((o) => o.totalt > 0);
  const n = new Map(d.par.map((p) => [`${p.a}|${p.b}`, p]));
  const get = (a, b) => n.get(`${a}|${b}`) || n.get(`${b}|${a}`);
  const max = Math.max(...d.par.map((p) => p.antall), 1);
  const shade = (v) => (v ? SEQ[Math.min(SEQ.length - 1, 1 + Math.floor((Math.log(v) / Math.log(max + 1)) * (SEQ.length - 1)))] : "transparent");
  const el = document.getElementById("trend-matrix");
  el.innerHTML = `<div class="matrix" style="--n:${terms.length}">
    <span></span>${terms.map((t) => `<span class="mh col" title="${esc(t.navn)}">${esc(t.navn)}</span>`).join("")}
    ${terms.map((r, i) => `<span class="mh row">${esc(r.navn)}</span>${terms.map((c, j) => {
      if (j >= i) return '<span class="mc empty"></span>';
      const p = get(r.id, c.id);
      return `<span class="mc${p ? " has" : ""}" style="background:${shade(p?.antall)}" data-a="${r.id}" data-b="${c.id}"
        data-tip="<b>${esc(r.navn)} + ${esc(c.navn)}</b><br>${p ? `${plural(p.antall, "felles sak", "felles saker")}<br>${times(p.lift)} så ofte som tilfeldig` : "Ingen felles saker"}"></span>`;
    }).join("")}`).join("")}
  </div>
  <div class="mx-legend"><span>Færre</span>${SEQ.slice(1).map((c) => `<i style="background:${c}"></i>`).join("")}<span>Flere felles saker</span></div>`;
  el.querySelectorAll(".mc.has").forEach((c) => c.addEventListener("click", () => { hideTip(); showPair(c.dataset.a, c.dataset.b); }));
  wireInteractive(el);
}

function showPair(a, b) {
  const d = trendState.data;
  trendState.pair = a && b ? [a, b] : null;
  document.querySelectorAll("#trend-matrix .mc").forEach((c) => c.classList.toggle("sel", !!trendState.pair &&
    ((c.dataset.a === a && c.dataset.b === b) || (c.dataset.a === b && c.dataset.b === a))));
  const el = document.getElementById("trend-pairs");
  const title = document.getElementById("trend-pair-title");
  if (trendState.pair) {
    const p = d.par.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    title.textContent = `${termName(a)} + ${termName(b)}`;
    const list = (p.saker || []).map((i) => d.par_saker[i]).filter(Boolean);
    const shown = list.length ? list : (p.titler || []);
    // Når ordene har stått sammen: felles saker per uke, grå der arkivet ikke dekker uken
    const weeks = p.uker || [];
    const wmax = Math.max(...weeks, 1);
    const strip = weeks.length ? `<div class="pair-weeks" aria-label="Felles saker per uke">${weeks.map((v, i) => `<i class="${d.dekket[i] || v ? "" : "gap"}"
        style="height:${v ? Math.max(12, (v / wmax) * 100) : 0}%" data-tip="Uke ${weekNo(d.uker[i])}<br>${plural(v, "felles sak", "felles saker")}"></i>`).join("")}</div>
      <div class="pair-axis"><span>Uke ${weekNo(d.uker[0])}</span><span>Felles saker per uke</span><span>Uke ${weekNo(d.uker[d.uker.length - 1])}</span></div>` : "";
    el.innerHTML = `<button class="secondary kw-back" id="pair-back">← Alle sterke par</button>
      <p class="pair-sum">${plural(p.antall, "felles sak", "felles saker")} · ${times(p.lift)} så ofte som om ordene var uavhengige</p>
      ${strip}
      ${shown.length ? `<p class="hint kw-sum">${shown.length < p.antall ? `De ${shown.length} siste sakene der begge ordene nevnes:` : "Sakene der begge ordene nevnes:"}</p>
        <ul class="dash-list pair-list">${shown.map((t) => `<li><div>${artLink(t)}<br><small>${artMeta(t)}</small></div></li>`).join("")}</ul>`
        : `<p class="hint">Sakene er eldre enn arkivet som følger med øyeblikksbildet.</p>`}`;
    wireInteractive(el);
    if (el.getBoundingClientRect().top > innerHeight * 0.8 || el.getBoundingClientRect().top < 0) el.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("pair-back").addEventListener("click", () => showPair());
    return;
  }
  title.textContent = "Sterkeste par";
  const pairs = d.par.filter((p) => p.antall >= 3).slice(0, 10);
  el.innerHTML = pairs.length ? `<ul class="pairs">${pairs.map((p) => `<li data-a="${p.a}" data-b="${p.b}">
      <span class="pn">${esc(termName(p.a))} <span class="muted">+</span> ${esc(termName(p.b))}</span>
      <span class="pv">${plural(p.antall, "sak", "saker")}</span><span class="pl">${times(p.lift)}</span></li>`).join("")}</ul>
      <p class="hint">«×» = hvor mye oftere ordene står sammen enn om de var uavhengige. Klikk for sakene.</p>`
    : '<p class="hint">Ingen par med minst tre felles saker ennå.</p>';
  el.querySelectorAll("li[data-a]").forEach((li) => li.addEventListener("click", () => showPair(li.dataset.a, li.dataset.b)));
}

function renderSpikes(d) {
  const el = document.getElementById("trend-spikes");
  if (!d.utslag.length) {
    el.innerHTML = `<div class="card auto"><div class="card-body"><p class="hint">Ingen utslag ennå. Et utslag krever minst to tidligere uker å sammenligne med,
      og arkivet dekker ${d.dekket.filter(Boolean).length} uke(r) så langt. Til da viser «Siste sju dager» hva som nevnes mer enn vanlig.</p></div></div>`;
    return;
  }
  el.innerHTML = `<div class="spikes">${d.utslag.map((x) => `<div class="spike">
    <div class="sp-head"><b>${esc(termName(x.ord))}</b><span class="mv-f hot">${times(x.faktor)} vanlig</span></div>
    <div class="muted">Uke ${weekNo(x.uke)} · ${plural(x.antall, "sak", "saker")}${x.sammen_med.length ? ` · sammen med ${x.sammen_med.map((s) => esc(termName(s.ord))).join(", ")}` : ""}</div>
    <ul>${x.titler.map((t) => `<li>${artLink(t)}<small>${artMeta(t)}</small></li>`).join("")}</ul></div>`).join("")}</div>`;
}

function sparkline(vals, color = "#3987e5") {
  const v = vals.map((x) => x ?? null), w = 120, h = 26;
  const max = Math.max(...v.filter((x) => x != null), 0.01);
  let p = "", pen = false;
  v.forEach((x, i) => {
    if (x == null) { pen = false; return; }
    p += `${pen ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)} ${(h - 2 - (x / max) * (h - 4)).toFixed(1)} `;
    pen = true;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${p}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

function renderTrendTable(d) {
  const recent = new Map(d.siste_7.ord.map((o) => [o.id, o]));
  const rows = [...d.ord].sort((a, b) => (recent.get(b.id)?.antall || 0) - (recent.get(a.id)?.antall || 0));
  document.getElementById("trend-table").innerHTML = `<table class="dtable"><thead><tr><th>Ord</th><th>Gruppe</th><th>Siste 30 dager</th><th>Siste 7 dager</th><th>× vanlig</th><th>Hele perioden</th></tr></thead><tbody>
    ${rows.map((o) => { const r = recent.get(o.id); return `<tr class="tr-pick" data-id="${o.id}">
      <td><b>${esc(o.navn)}</b></td><td class="muted">${esc(o.gruppe)}</td>
      <td>${sparkline(d.daglig.ord[o.id].andel)}</td>
      <td class="num">${nf(r?.antall || 0)}</td>
      <td class="num">${r?.faktor != null && r.antall >= 3 ? `<span class="${r.faktor >= 2 ? "hot-t" : ""}">${times(r.faktor)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num">${nf(o.totalt)}</td></tr>`; }).join("")}</tbody></table>
    <p class="hint">Klikk et ord for å legge det til i diagrammet.</p>`;
  document.querySelectorAll("#trend-table .tr-pick").forEach((tr) => tr.addEventListener("click", () => {
    if (!trendState.picked.has(tr.dataset.id)) pickTerm(tr.dataset.id);
    document.getElementById("trend-chart").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
}

function setTrendSeg() {
  document.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("active", b.dataset.range === trendState.range));
  document.querySelectorAll("[data-measure]").forEach((b) => b.classList.toggle("active", b.dataset.measure === trendState.measure));
}
document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => { trendState.range = b.dataset.range; setTrendSeg(); renderTrendChart(); }));
document.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", () => { trendState.measure = b.dataset.measure; setTrendSeg(); renderTrendChart(); }));
new ResizeObserver(() => { if (trendState.data && document.getElementById("view-trender").classList.contains("active")) renderTrendChart(); })
  .observe(document.getElementById("trend-chart"));

async function loadTrends() {
  try {
    const d = await getJSON("/api/trends");
    trendState.data = d;
    // Kort arkiv: start i dagsvisning, som har form allerede
    if (!trendState.range) trendState.range = d.dekket.filter(Boolean).length >= 8 ? "uker" : "dager";
    if (!trendState.picked.size) TREND_DEFAULT.filter((id) => d.ord.some((o) => o.id === id)).forEach((id, i) => trendState.picked.set(id, SERIES_COLORS[i]));
    document.getElementById("trend-n").textContent = d.ord.length;
    document.getElementById("trend-updated").textContent = `${plural(d.saker.reduce((s, x) => s + x, 0), "sak", "saker")} fra ${d.kilder} kilder · oppdatert ${new Date(d.tid * 1000).toLocaleString("no-NO", { weekday: "long", hour: "2-digit", minute: "2-digit" })}`;
    if (STATIC) {
      const pill = document.getElementById("ais-status");
      if (!pill.classList.contains("ok")) { pill.textContent = "Øyeblikksbilde · nytt hver time"; pill.classList.add("ok"); }
    }
    setTrendSeg();
    renderMovers(d);
    renderTrendPicker();
    renderTrendChart();
    renderMatrix(d);
    showPair(...(trendState.pair || []));
    renderSpikes(d);
    renderTrendTable(d);
  } catch (e) { console.error(e); }
}

route();
