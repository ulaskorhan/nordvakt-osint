"""Nyhetsovervåking: RSS fra norske medier og myndigheter, med norsk NER (spaCy).

Personvern: modellen gjenkjenner også personnavn, men de forkastes. Bare organisasjoner,
steder og hendelser lagres som enheter, slik at verktøyet ikke kan brukes til å samle
omtale av enkeltpersoner på tvers av saker. Vi behandler bare tittel og ingress fra
RSS, ikke hele artikler.
"""

import asyncio
import calendar
import hashlib
import html
import json
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path

import feedparser
import httpx

from . import provenance

log = logging.getLogger("nordvakt.news")

DATA = Path(__file__).resolve().parent.parent / "data"
CONFIG = json.loads((DATA / "feeds.json").read_text(encoding="utf-8"))
STEDSNAVN = "https://api.kartverket.no/stedsnavn/v1/sted"

# spaCy-etikett -> vår type. PER, DRV, PROD og MISC forkastes med vilje.
ENTITY_TYPES = {"ORG": "ORG", "GPE_LOC": "STED", "LOC": "STED", "GPE_ORG": "STED", "EVT": "HENDELSE"}

# Bare disse stedstypene godtas, i prioritert rekkefølge. Registeret er fullt av gårder,
# bruk og bruer med vanlige navn ("USA", "Finnmark"), som ellers gir feilplasseringer.
PLACE_PRIORITY = [
    "Kommune", "By", "Bydel", "Tettsted", "Tettbebyggelse", "Landskapsområde", "Øygruppe",
    "Fjord", "Havn", "Industriområde", "Fabrikk", "Sykehus", "Flyplass", "Lufthavn", "Øy i sjø",
]

# Land som har navnebrødre blant småsteder i Norge (f.eks. øya «Norge» i Gran)
COUNTRIES = {
    "Norge", "Sverige", "Danmark", "Finland", "Island", "Grønland", "Russland", "Ukraina",
    "Tyskland", "Frankrike", "Spania", "Polen", "Kina", "Japan", "Israel", "Iran", "Irland",
    "England", "Skottland", "Nederland", "Belgia", "Italia", "Hellas", "Tyrkia", "Canada",
}

# Fylkene (inndeling fra 2024) finnes ikke i stedsnavnregisteret under dagens navn.
# Omtrentlige midtpunkter.
FYLKER = {
    "Oslo": (59.91, 10.75), "Akershus": (59.95, 11.10), "Østfold": (59.30, 11.20),
    "Buskerud": (60.20, 9.30), "Innlandet": (61.30, 10.20), "Vestfold": (59.25, 10.20),
    "Telemark": (59.40, 8.50), "Agder": (58.60, 7.60), "Rogaland": (59.10, 6.20),
    "Vestland": (60.70, 6.20), "Møre og Romsdal": (62.60, 7.40), "Trøndelag": (63.60, 11.00),
    "Nordland": (67.00, 14.50), "Troms": (69.30, 19.00), "Finnmark": (70.00, 25.00),
    "Svalbard": (78.20, 15.60),
}

_lock = threading.Lock()
_db = sqlite3.connect(DATA / "nyheter.sqlite", check_same_thread=False)
_db.executescript(
    """
    CREATE TABLE IF NOT EXISTS artikler (
        id TEXT PRIMARY KEY, kilde TEXT, tittel TEXT, lenke TEXT,
        publisert REAL, sammendrag TEXT, hentet REAL
    );
    CREATE TABLE IF NOT EXISTS enheter (artikkel_id TEXT, tekst TEXT, type TEXT);
    CREATE INDEX IF NOT EXISTS enheter_tekst ON enheter (tekst);
    CREATE INDEX IF NOT EXISTS enheter_artikkel ON enheter (artikkel_id);
    CREATE TABLE IF NOT EXISTS steder (
        navn TEXT PRIMARY KEY, funnet INTEGER, lat REAL, lon REAL, type TEXT, kommune TEXT
    );
    """
)

_client = httpx.AsyncClient(timeout=15, follow_redirects=True, headers={"User-Agent": "Nordvakt/0.1 (OSINT-prosjekt)"})
_nlp = None
state = {"siste_kjoring": None, "neste_kjoring": None, "kjorer": False, "feil": {}, "nye_siste": 0}


def _load_nlp():
    global _nlp
    if _nlp is None:
        import spacy
        _nlp = spacy.load("nb_core_news_md", disable=["parser", "lemmatizer"])
    return _nlp


def _clean(text: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def _extract(articles: list[dict]) -> dict[str, set[tuple[str, str]]]:
    nlp = _load_nlp()
    texts = [f"{a['tittel']}. {a['sammendrag']}" for a in articles]
    out = {}
    for a, doc in zip(articles, nlp.pipe(texts)):
        ents = set()
        for e in doc.ents:
            t = ENTITY_TYPES.get(e.label_)
            name = e.text.strip(" «»\"'.,:;()-–")
            if t and len(name) > 1 and not name.islower():
                ents.add((name, t))
        out[a["id"]] = ents
    return out


def _keyword_hits(text: str) -> list[str]:
    low = text.lower()
    hits = []
    for kw in CONFIG["emneord"]:
        k = kw.lower()
        # Korte ord (PST) krever hele ord; lengre ord matcher også inne i sammensetninger
        if len(k) < 5:
            if re.search(rf"\b{re.escape(k)}\b", low):
                hits.append(kw)
        elif k in low:
            hits.append(kw)
    return hits


async def _lookup(name: str) -> dict | None:
    params = {"sok": name, "utkoordsys": 4258, "treffPerSide": 100, "fuzzy": "false"}
    resp = await _client.get(STEDSNAVN, params=params)
    provenance.log("Kartverket stedsnavn", str(resp.url), resp.status_code, resp.content)
    hits = resp.json().get("navn", []) if resp.status_code == 200 else []
    exact = [
        h for h in hits
        if h.get("navneobjekttype") in PLACE_PRIORITY
        and h.get("kommuner")  # treff uten kommune er utenlandske navneformer (f.eks. Skagen)
        and any(s.get("skrivemåte", "").lower() == name.lower() for s in h.get("stedsnavn", []))
    ]
    return min(exact, key=lambda h: PLACE_PRIORITY.index(h["navneobjekttype"])) if exact else None


async def _geocode(name: str) -> None:
    base = name[:-1] if name.endswith("s") and name[:-1] in FYLKER else name
    if base in FYLKER:
        lat, lon = FYLKER[base]
        with _lock:
            _db.execute("INSERT OR REPLACE INTO steder VALUES (?, 1, ?, ?, 'Fylke', NULL)", (name, lat, lon))
            _db.commit()
        return
    best = None
    if name not in COUNTRIES and name.rstrip("s") not in COUNTRIES:
        try:
            best = await _lookup(name)
            if best is None and name.endswith("s") and len(name) > 4:
                best = await _lookup(name[:-1])  # genitiv: «Bodøs» -> «Bodø»
        except Exception as exc:
            log.warning("Stedsoppslag feilet for %s: %s", name, exc)
            return  # prøves igjen ved neste kjøring
    with _lock:
        if best and best.get("representasjonspunkt"):
            p = best["representasjonspunkt"]
            kommune = (best.get("kommuner") or [{}])[0].get("kommunenavn")
            _db.execute("INSERT OR REPLACE INTO steder VALUES (?, 1, ?, ?, ?, ?)",
                        (name, p["nord"], p["øst"], best.get("navneobjekttype"), kommune))
        else:
            _db.execute("INSERT OR REPLACE INTO steder VALUES (?, 0, NULL, NULL, NULL, NULL)", (name,))
        _db.commit()


async def fetch_all() -> int:
    state["kjorer"] = True
    new: dict[str, dict] = {}
    now = time.time()
    for feed in CONFIG["kilder"]:
        try:
            resp = await _client.get(feed["url"])
            provenance.log(f"RSS: {feed['navn']}", feed["url"], resp.status_code, resp.content)
            resp.raise_for_status()
            parsed = feedparser.parse(resp.content)
            state["feil"].pop(feed["navn"], None)
        except Exception as exc:
            state["feil"][feed["navn"]] = str(exc)
            continue
        for e in parsed.entries:
            link = e.get("link")
            if not link:
                continue
            aid = hashlib.sha1(link.encode()).hexdigest()[:16]
            with _lock:
                exists = _db.execute("SELECT 1 FROM artikler WHERE id = ?", (aid,)).fetchone()
            if exists or aid in new:
                continue
            ts = e.get("published_parsed") or e.get("updated_parsed")
            new[aid] = {
                "id": aid, "kilde": feed["navn"], "tittel": _clean(e.get("title")), "lenke": link,
                "publisert": calendar.timegm(ts) if ts else now,
                "sammendrag": _clean(e.get("summary"))[:600], "hentet": now,
            }

    if new:
        articles = list(new.values())
        entities = await asyncio.to_thread(_extract, articles)
        with _lock:
            _db.executemany(
                "INSERT OR IGNORE INTO artikler VALUES (:id, :kilde, :tittel, :lenke, :publisert, :sammendrag, :hentet)",
                articles,
            )
            _db.executemany(
                "INSERT INTO enheter VALUES (?, ?, ?)",
                [(aid, name, t) for aid, ents in entities.items() for name, t in ents],
            )
            _db.commit()
            missing = [r[0] for r in _db.execute(
                "SELECT DISTINCT tekst FROM enheter WHERE type = 'STED' AND tekst NOT IN (SELECT navn FROM steder)"
            )]
        for name in missing:
            await _geocode(name)
            await asyncio.sleep(0.2)

    state.update(kjorer=False, siste_kjoring=time.time(), nye_siste=len(new))
    return len(new)


async def run() -> None:
    interval = CONFIG["intervall_min"] * 60
    while True:
        try:
            n = await fetch_all()
            log.info("Nyhetsinnhenting ferdig: %d nye saker", n)
        except Exception:
            log.exception("Nyhetsinnhenting feilet")
            state["kjorer"] = False
        state["neste_kjoring"] = time.time() + interval
        await asyncio.sleep(interval)


def _entities_for(ids: list[str]) -> dict[str, list[dict]]:
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    with _lock:
        rows = _db.execute(
            f"""SELECT e.artikkel_id, e.tekst, e.type, s.funnet FROM enheter e
                LEFT JOIN steder s ON s.navn = e.tekst AND e.type = 'STED'
                WHERE e.artikkel_id IN ({marks})""", ids
        ).fetchall()
    out: dict[str, list[dict]] = {}
    for aid, tekst, t, funnet in rows:
        out.setdefault(aid, []).append({"tekst": tekst, "type": t, "paa_kart": bool(funnet)})
    return out


def articles(hours: int = 72, q: str | None = None, enhet: str | None = None,
             kun_treff: bool = False, limit: int = 150) -> list[dict]:
    since = time.time() - hours * 3600
    sql = "SELECT id, kilde, tittel, lenke, publisert, sammendrag FROM artikler WHERE publisert > ?"
    args: list = [since]
    if enhet:
        sql += " AND id IN (SELECT artikkel_id FROM enheter WHERE tekst = ?)"
        args.append(enhet)
    sql += " ORDER BY publisert DESC LIMIT 1000"
    with _lock:
        rows = _db.execute(sql, args).fetchall()

    result = []
    ql = (q or "").strip().lower()
    for aid, kilde, tittel, lenke, pub, sammendrag in rows:
        text = f"{tittel} {sammendrag}"
        if ql and ql not in text.lower():
            continue
        treff = _keyword_hits(text)
        if kun_treff and not treff:
            continue
        result.append({"id": aid, "kilde": kilde, "tittel": tittel, "lenke": lenke,
                       "publisert": pub, "sammendrag": sammendrag, "treff": treff})
        if len(result) >= limit:
            break
    ents = _entities_for([a["id"] for a in result])
    for a in result:
        a["enheter"] = ents.get(a["id"], [])
    return result


def top_entities(hours: int = 72, limit: int = 12) -> dict[str, list[dict]]:
    since = time.time() - hours * 3600
    out = {}
    with _lock:
        for t in ("ORG", "STED", "HENDELSE"):
            rows = _db.execute(
                """SELECT e.tekst, COUNT(DISTINCT e.artikkel_id) AS n FROM enheter e
                   JOIN artikler a ON a.id = e.artikkel_id
                   WHERE e.type = ? AND a.publisert > ? GROUP BY e.tekst ORDER BY n DESC LIMIT ?""",
                (t, since, limit),
            ).fetchall()
            out[t] = [{"tekst": r[0], "antall": r[1]} for r in rows]
    return out


def places(hours: int = 72) -> list[dict]:
    since = time.time() - hours * 3600
    with _lock:
        rows = _db.execute(
            """SELECT s.navn, s.lat, s.lon, s.type, s.kommune, a.tittel, a.lenke, a.kilde, a.publisert
               FROM enheter e
               JOIN artikler a ON a.id = e.artikkel_id
               JOIN steder s ON s.navn = e.tekst AND s.funnet = 1
               WHERE e.type = 'STED' AND a.publisert > ?
               ORDER BY a.publisert DESC""",
            (since,),
        ).fetchall()
    by_place: dict[str, dict] = {}
    for navn, lat, lon, typ, kommune, tittel, lenke, kilde, pub in rows:
        p = by_place.setdefault(navn, {"navn": navn, "lat": lat, "lon": lon, "type": typ,
                                       "kommune": kommune, "antall": 0, "saker": []})
        p["antall"] += 1
        if len(p["saker"]) < 6:
            p["saker"].append({"tittel": tittel, "lenke": lenke, "kilde": kilde, "publisert": pub})
    return list(by_place.values())


# --- Oppslag for entitetsmodellen (connectors/news_conn.py) ---
# SQLite sin lower() håndterer ikke æøå, så tekstmatching gjøres i Python.

_ARTICLE_COLS = "id, kilde, tittel, lenke, publisert, sammendrag"


def _article(row) -> dict:
    return dict(zip(("id", "kilde", "tittel", "lenke", "publisert", "sammendrag"), row))


def get_article(aid: str) -> dict | None:
    with _lock:
        row = _db.execute(f"SELECT {_ARTICLE_COLS} FROM artikler WHERE id = ?", (aid,)).fetchone()
    return _article(row) if row else None


def _recent(days: int) -> list[dict]:
    with _lock:
        rows = _db.execute(
            f"SELECT {_ARTICLE_COLS} FROM artikler WHERE publisert > ? ORDER BY publisert DESC",
            (time.time() - days * 86400,),
        ).fetchall()
    return [_article(r) for r in rows]


def articles_matching(terms: list[str], limit: int = 25, days: int = 30) -> list[dict]:
    """Saker der et av ordene forekommer i tittel eller ingress (også som forledd)."""
    patterns = [re.compile(rf"(?<!\w){re.escape(t.lower())}") for t in terms if len(t) >= 3]
    if not patterns:
        return []
    out = []
    for a in _recent(days):
        text = f"{a['tittel']} {a['sammendrag']}".lower()
        if any(p.search(text) for p in patterns):
            out.append(a)
            if len(out) >= limit:
                break
    return out


def articles_by_entity(tekst: str, limit: int = 25) -> list[dict]:
    with _lock:
        rows = _db.execute(
            f"""SELECT {_ARTICLE_COLS} FROM artikler WHERE id IN
                (SELECT artikkel_id FROM enheter WHERE tekst = ?) ORDER BY publisert DESC LIMIT ?""",
            (tekst, limit),
        ).fetchall()
    return [_article(r) for r in rows]


def entities_of(aid: str) -> list[dict]:
    with _lock:
        rows = _db.execute(
            """SELECT e.tekst, e.type, s.funnet, s.lat, s.lon, s.type, s.kommune FROM enheter e
               LEFT JOIN steder s ON s.navn = e.tekst AND e.type = 'STED' WHERE e.artikkel_id = ?""",
            (aid,),
        ).fetchall()
    return [dict(zip(("tekst", "type", "funnet", "lat", "lon", "stedstype", "kommune"), r)) for r in rows]


def search_articles(q: str, limit: int = 8, days: int = 30) -> list[dict]:
    ql = q.lower()
    return [a for a in _recent(days) if ql in a["tittel"].lower()][:limit]


def search_org_mentions(q: str, limit: int = 5) -> list[tuple[str, int]]:
    ql = q.lower()
    with _lock:
        rows = _db.execute(
            "SELECT tekst, COUNT(DISTINCT artikkel_id) AS n FROM enheter WHERE type = 'ORG' GROUP BY tekst ORDER BY n DESC"
        ).fetchall()
    return [(t, n) for t, n in rows if ql in t.lower()][:limit]


def get_place(name: str) -> dict | None:
    with _lock:
        row = _db.execute("SELECT navn, lat, lon, type, kommune FROM steder WHERE navn = ? AND funnet = 1", (name,)).fetchone()
    return dict(zip(("navn", "lat", "lon", "type", "kommune"), row)) if row else None


def search_places(q: str, limit: int = 5) -> list[dict]:
    ql = q.lower()
    with _lock:
        rows = _db.execute("SELECT navn, lat, lon, type, kommune FROM steder WHERE funnet = 1").fetchall()
    hits = [dict(zip(("navn", "lat", "lon", "type", "kommune"), r)) for r in rows if r[0].lower().startswith(ql)]
    return sorted(hits, key=lambda p: (p["navn"].lower() != ql, len(p["navn"])))[:limit]


async def resolve_place(name: str) -> dict | None:
    """Slår opp et stedsnavn i Kartverket hvis vi ikke har sett det før."""
    with _lock:
        known = _db.execute("SELECT 1 FROM steder WHERE navn = ?", (name,)).fetchone()
    if not known:
        await _geocode(name)
    return get_place(name)


def status() -> dict:
    with _lock:
        total = _db.execute("SELECT COUNT(*) FROM artikler").fetchone()[0]
    return {**state, "kilder": len(CONFIG["kilder"]), "artikler": total,
            "intervall_min": CONFIG["intervall_min"], "emneord": CONFIG["emneord"]}
