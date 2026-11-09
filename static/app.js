// AIS-navn og registerdata er ukontrollert input: alt settes inn via esc() eller textContent.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Statisk modus (GitHub Pages): ingen server, bare et øyeblikksbilde av oversikten
// som GitHub Actions lager hver time. Se scripts/snapshot.py.
const STATIC = window.NORDVAKT_STATIC === true;
const STATIC_FILES = { "/api/dashboard": "data/dashboard.json", "/api/zones": "data/zones.json" };
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
    "font-size": 10, "line-height": 1.35, color: "#d8dee6",
    "background-color": "#151b23", "border-width": 1, "border-color": "data(farge)",
  } },
  { selector: "edge", style: {
    width: 1, "line-color": "#2f3843", "curve-style": "taxi", "taxi-direction": "horizontal", "taxi-turn": "50%",
  } },
  { selector: "edge.hl", style: {
    "line-color": "#8592a3", width: 1.5, label: "data(label)", "font-size": 9, color: "#d8dee6",
    "text-background-color": "#0d1117", "text-background-opacity": 1, "text-background-padding": 2,
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
      "background-color": "#173e4d", "border-color": "#4fb3d9", "border-width": 2, "font-size": 11, "font-weight": "bold",
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
  if (STATIC) { showView("oversikt"); return; }
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
      radius: center ? 9 : 6, weight: center ? 2 : 1, color: center ? "#ffffff" : "#0d1117", fillColor: color, fillOpacity: 0.95,
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
        { selector: 'node[kind="center"]', style: { "background-color": "#1f2a36", "border-width": 2, "font-size": 11, "font-weight": "bold" } },
        { selector: 'node[kind="mer"]', style: { "border-style": "dashed", color: "#8592a3" } },
        { selector: 'node[kind="rolle"]', style: { color: "#b4bfcc" } },
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
  const a = d.ais, n = d.nyheter;
  const noAis = aisMissing(d);
  const delta = n.siste_24 - n.forrige_24;
  const deltaTxt = n.forrige_24 ? `<b class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "↑" : "↓"} ${nf(Math.abs(delta))}</b> mot døgnet før` : "siste 24 timer";
  const ents = Object.values(d.lager.entiteter).reduce((s, x) => s + x, 0);
  const high = a.varsler_24["høy"], mid = a.varsler_24.middels;
  document.getElementById("dash-tiles").innerHTML = [
    tile("Fartøy nå", noAis ? "–" : nf(a.fartoy), noAis ? "AIS utilgjengelig" : `${nf(a.i_bevegelse)} i bevegelse`, "#maritim"),
    tile("Utenlandske fartøy", noAis ? "–" : nf(a.utenlandske), noAis ? "AIS utilgjengelig" : `${a.antall_flagg} flaggstater`, "#maritim"),
    tile("AIS-varsler, 24 t", noAis ? "–" : nf(high + mid), noAis ? "AIS utilgjengelig" : `${high} høy · ${mid} middels`, "#maritim", high ? "alert" : ""),
    tile("Nyhetssaker, 24 t", nf(n.siste_24), deltaTxt, "#nyheter"),
    tile("Emneord-treff, 24 t", nf(n.treff_24), "saker som nevner et emneord", "#nyheter", n.treff_24 ? "warn" : ""),
    STATIC && noAis
      ? tile("Nyhetskilder", nf(n.kilder.length), "RSS, analysert med spaCy", "#")
      : STATIC
      ? tile("AIS-kilde", d.øyeblikksbilde.ais_kilde || "Kystverket", "siste kjente posisjoner", "#")
      : tile("Entiteter i lageret", nf(ents), `${nf(d.lager.relasjoner)} relasjoner`, "#sok"),
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
  if (rest) top.push({ navn: "andre", antall: rest, farge: "#3a434f", tekst: "Andre" });
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
  const ticks = [0, 12, 24, 36, 48, 60, 71].map((i) => `<span style="left:${((i + 0.5) / 72) * 100}%">${esc(fmt(hourOf(i)))}</span>`).join("");
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
      fillColor: foreign ? "#4fb3d9" : "#5b6675",
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

let zonesCache = [];
async function loadDashboard() {
  try {
    if (!zonesCache.length) zonesCache = await getJSON("/api/zones");
    const d = await getJSON("/api/dashboard");
    const a = d.ais, n = d.nyheter;
    renderTiles(d);
    renderDashMap(a);
    if (aisMissing(d)) {
      document.getElementById("dash-map").insertAdjacentHTML("beforeend", `<div class="map-note">${AIS_MISSING}</div>`);
    }
    bars(document.getElementById("dash-flags"),
      a.flagg.filter((f) => f.navn !== "Norge").slice(0, 11).map((f) => ({ ...f, href: `flagg=${f.navn}` })), { unit: "fartøy", empty: aisMissing(d) ? AIS_MISSING : undefined });
    if (aisMissing(d)) document.getElementById("dash-types").innerHTML = `<p class="hint">${AIS_MISSING}</p>`;
    else donut(document.getElementById("dash-types"), a.kategorier);
    newsColumns(document.getElementById("dash-news"), n.per_time, d.tid);
    document.getElementById("dash-news-total").textContent = `${nf(n.per_time.reduce((s, x) => s + x, 0))} saker fra ${n.kilder.length} kilder`;
    bars(document.getElementById("dash-zones"), (aisMissing(d) ? [] : a.soner).map((z) => ({
      navn: z.navn, antall: z.naer, href: `e=zone:${z.id}`,
      tip: `<b>${esc(z.navn)}</b><br>${z.inne} i sonen, ${z.naer} innen dobbel radius<br>${z.utenlandske} utenlandske`,
    })), { unit: "fartøy", empty: aisMissing(d) ? AIS_MISSING : undefined });
    bars(document.getElementById("dash-keywords"), n.emneord.slice(0, 10).map((k) => ({ ...k, href: `sok=${k.navn}` })),
      { unit: "saker", empty: "Ingen saker med emneord siste 7 døgn." });
    bars(document.getElementById("dash-orgs"), n.topp.ORG.map((o) => ({ navn: o.tekst, antall: o.antall, href: `sok=${o.tekst}` })), { unit: "saker, 72 t" });
    bars(document.getElementById("dash-places"), n.topp.STED.map((o) => ({ navn: o.tekst, antall: o.antall, href: `sok=${o.tekst}` })), { unit: "saker, 72 t" });
    listItems(document.getElementById("dash-alerts"), a.siste_varsler.map((v) => `
      <li data-href="e=vessel:${v.mmsi}"><span class="sev ${v.niva === "høy" ? "high" : "mid"}">${v.niva === "høy" ? "Høy" : "Middels"}</span>
        <div><b>${esc(v.navn || `MMSI ${v.mmsi}`)}</b> · ${esc(v.flagg)}<br><small>${esc(v.sone)} · ${esc(fmtTime(v.tid))}</small></div></li>`),
      "Ingen varsler siste døgn.");
    listItems(document.getElementById("dash-hits"), n.siste_treff.map((t) => `
      <li><div><a href="${esc(safeUrl(t.lenke))}" target="_blank" rel="noopener">${esc(t.tittel)}</a><br>
        <small>${esc(t.kilde)} · ${esc(timeAgo(t.publisert))} · ${t.treff.map(esc).join(", ")}</small></div></li>`),
      "Ingen saker med emneord siste 7 døgn.");
    const when = new Date(d.tid * 1000).toLocaleString("no-NO", { weekday: "long", hour: "2-digit", minute: "2-digit" });
    document.getElementById("dash-updated").textContent = STATIC
      ? `Øyeblikksbilde fra ${when} · nytt hver time`
      : `Oppdatert ${fmtTime(d.tid)} · oppdateres hvert 30. sekund`;
    if (STATIC) {
      const pill = document.getElementById("ais-status");
      pill.textContent = aisMissing(d) ? "Øyeblikksbilde · uten AIS" : `Øyeblikksbilde · ${nf(a.fartoy)} fartøy`;
      pill.classList.add("ok");
    }
  } catch (e) { console.error(e); }
}
setInterval(() => { if (dashVisible() && !STATIC) loadDashboard(); }, 30000);

route();
