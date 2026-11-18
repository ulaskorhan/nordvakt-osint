"""Ordtrender: hvordan utvalgte ord brukes i nyhetene over et halvt år.

Grunnlaget er Nordvakts eget nyhetsarkiv (tittel og ingress fra RSS). For hver uke
telles hvor mange saker som nevner hvert ord, og hvilke ord som står i de samme
sakene. Ukene lagres som rådata, slik at historikken kan flettes inn igjen fra forrige
publiserte øyeblikksbilde hvis arkivet på serveren skulle bli borte.

Tre ting kommer ut av dette:
- tidsserier: andelen av ukens saker som nevner ordet
- par: ord som nevnes i de samme sakene oftere enn tilfeldig
- utslag: uker der et ord brått nevnes mye oftere enn vanlig, med sakene bak
"""

import json
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import news

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "data" / "trends.json").read_text(encoding="utf-8"))
OSLO = ZoneInfo("Europe/Oslo")
WEEKS = CONFIG["uker"]
TITLES_PER_WEEK = 3

TERMS = [
    {"id": o["id"], "navn": o["navn"], "gruppe": g["navn"],
     "re": re.compile(o["mønster"], 0 if o.get("store") else re.IGNORECASE)}
    for g in CONFIG["grupper"] for o in g["ord"]
]
NAMES = {t["id"]: t["navn"] for t in TERMS}


def _monday(ts: float) -> str:
    d = datetime.fromtimestamp(ts, OSLO).date()
    return (d - timedelta(days=d.weekday())).isoformat()


def _hits(text: str) -> list[str]:
    return [t["id"] for t in TERMS if t["re"].search(text)]


_cache: dict = {"tid": 0.0, "since": None, "data": []}


def _articles(since: float) -> list[dict]:
    """Saker etter `since`, med ordtreff. Mellomlagres et halvt minutt, siden én
    beregning trenger de samme sakene flere ganger."""
    c = _cache
    if c["since"] is not None and since >= c["since"] and time.time() - c["tid"] < 30:
        return [a for a in c["data"] if a["publisert"] > since]
    data = _load(since)
    _cache.update(tid=time.time(), since=since, data=data)
    return data


def _load(since: float) -> list[dict]:
    with news._lock:
        rows = news._db.execute(
            "SELECT tittel, lenke, kilde, publisert, sammendrag FROM artikler WHERE publisert > ? ORDER BY publisert DESC",
            (since,),
        ).fetchall()
    # Samme sak ligger ofte i flere feeder (NRK toppsaker og NRK siste) med ulik lenke
    seen, out = set(), []
    for tittel, lenke, kilde, pub, sammendrag in rows:
        key = tittel.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"tittel": tittel, "lenke": lenke, "kilde": kilde, "publisert": pub,
                    "ord": _hits(f"{tittel} {sammendrag}")})
    return out


def _title(a: dict) -> dict:
    return {"tittel": a["tittel"], "lenke": a["lenke"], "kilde": a["kilde"], "publisert": a["publisert"]}


def _week_starts(now: float) -> list[str]:
    this = datetime.fromisoformat(_monday(now)).date()
    return [(this - timedelta(weeks=i)).isoformat() for i in range(WEEKS - 1, -1, -1)]


def weekly(now: float | None = None) -> dict[str, dict]:
    """Rådata per uke fra arkivet: antall saker, treff per ord, par og eksempeltitler."""
    now = now or time.time()
    starts = _week_starts(now)
    weeks = {s: {"start": s, "saker": 0, "ord": {}, "par": {}, "titler": {}} for s in starts}
    since = datetime.fromisoformat(starts[0]).replace(tzinfo=OSLO).timestamp()
    for a in _articles(since):  # nyeste først, så titlene blir de siste i uken
        w = weeks.get(_monday(a["publisert"]))
        if w is None:
            continue
        w["saker"] += 1
        hits = a["ord"]
        for i, t in enumerate(hits):
            w["ord"][t] = w["ord"].get(t, 0) + 1
            titles = w["titler"].setdefault(t, [])
            if len(titles) < TITLES_PER_WEEK:
                titles.append(_title(a))
            for u in hits[i + 1:]:
                key = f"{t}|{u}"
                w["par"][key] = w["par"].get(key, 0) + 1
    return weeks


def merge(current: dict[str, dict], previous: list[dict] | None) -> list[dict]:
    """Uker arkivet ikke lenger dekker like godt som før, hentes fra forrige øyeblikksbilde."""
    for old in previous or []:
        cur = current.get(old.get("start"))
        if cur is not None and old.get("saker", 0) > cur["saker"]:
            current[old["start"]] = old
    return [current[s] for s in sorted(current)]


def _pair_titles(since: float, a: str, b: str, limit: int = 3) -> list[dict]:
    out = []
    for art in _articles(since):
        if a in art["ord"] and b in art["ord"]:
            out.append(_title(art))
            if len(out) == limit:
                break
    return out


def analyse(weeks: list[dict], now: float | None = None) -> dict:
    now = now or time.time()
    # «Vanlig uke» = medianen av de fire største ukene. En uke regnes som dekket når
    # arkivet har minst en tredel av det; ellers er tallene for tynne til å si noe.
    top = sorted((w["saker"] for w in weeks), reverse=True)[:4]
    median = max(top[len(top) // 2], 1)
    covered = [w["saker"] >= max(20, median / 3) for w in weeks]
    first = next((w["start"] for w, c in zip(weeks, covered) if c), None)

    series = []
    for t in TERMS:
        counts = [w["ord"].get(t["id"], 0) for w in weeks]
        shares = [round(100 * n / w["saker"], 2) if c else None for n, w, c in zip(counts, weeks, covered)]
        series.append({"id": t["id"], "navn": t["navn"], "gruppe": t["gruppe"],
                       "antall": counts, "andel": shares, "totalt": sum(counts)})

    # Par over hele perioden, med «lift»: hvor mye oftere enn om ordene var uavhengige
    total = sum(w["saker"] for w in weeks) or 1
    n_term = {s["id"]: s["totalt"] for s in series}
    pair_n: dict[str, int] = {}
    for w in weeks:
        for k, n in w["par"].items():
            pair_n[k] = pair_n.get(k, 0) + n
    pairs = []
    for k, n in pair_n.items():
        a, b = k.split("|")
        lift = n * total / (n_term[a] * n_term[b]) if n_term[a] and n_term[b] else 0
        pairs.append({"a": a, "b": b, "antall": n, "lift": round(lift, 1)})
    pairs.sort(key=lambda p: (-p["antall"], -p["lift"]))
    since = datetime.fromisoformat(weeks[0]["start"]).replace(tzinfo=OSLO).timestamp()
    for p in pairs[:12]:
        p["titler"] = _pair_titles(since, p["a"], p["b"])

    # Utslag: ordets andel minst dobbelt så høy som snittet for de fire foregående dekkede ukene
    spikes = []
    for s in series:
        for i, w in enumerate(weeks):
            if not covered[i] or s["antall"][i] < 4:
                continue
            prev = [s["andel"][j] for j in range(max(0, i - 4), i) if covered[j]]
            if len(prev) < 2:
                continue
            base = max(sum(prev) / len(prev), 100 / median)  # minst «én sak i en vanlig uke»
            factor = s["andel"][i] / base
            if factor < 2:
                continue
            partners = sorted(((k, n) for k, n in w["par"].items() if s["id"] in k.split("|")), key=lambda kv: -kv[1])
            spikes.append({
                "uke": w["start"], "ord": s["id"], "antall": s["antall"][i], "faktor": round(factor, 1),
                "sammen_med": [{"ord": next(x for x in k.split("|") if x != s["id"]), "antall": n} for k, n in partners[:3]],
                "titler": w["titler"].get(s["id"], []),
            })
    spikes.sort(key=lambda x: (x["uke"], x["faktor"]), reverse=True)

    return {
        "tid": now, "uker": [w["start"] for w in weeks], "saker": [w["saker"] for w in weeks],
        "dekket": covered, "dekning_fra": first, "grupper": [g["navn"] for g in CONFIG["grupper"]],
        "ord": series, "par": pairs, "utslag": spikes[:12], "siste_7": last_days(now), "daglig": daily(now),
        "kilder": len(news.CONFIG["kilder"]),
    }


def daily(now: float, days: int = 30) -> dict:
    """Samme tall per dag for den siste måneden. Gir form på kurvene mens arkivet
    ennå er for kort til ukevisningen."""
    today = datetime.fromtimestamp(now, OSLO).date()
    dates = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    idx = {d: i for i, d in enumerate(dates)}
    saker = [0] * days
    counts = {t["id"]: [0] * days for t in TERMS}
    since = datetime.fromisoformat(dates[0]).replace(tzinfo=OSLO).timestamp()
    for a in _articles(since):
        i = idx.get(datetime.fromtimestamp(a["publisert"], OSLO).date().isoformat())
        if i is None:
            continue
        saker[i] += 1
        for t in a["ord"]:
            counts[t][i] += 1
    top = sorted(saker, reverse=True)[:7]
    typical = max(top[len(top) // 2], 1)
    covered = [n >= max(10, typical / 5) for n in saker]

    # Andelen glattes over tre dager (dagen og de to før), ellers blir kurvene bare støy
    def smooth(v: list[int]) -> list[float | None]:
        out = []
        for i in range(days):
            idx3 = [j for j in range(max(0, i - 2), i + 1) if covered[j]]
            tot = sum(saker[j] for j in idx3)
            out.append(round(100 * sum(v[j] for j in idx3) / tot, 2) if covered[i] and tot else None)
        return out

    return {"dager": dates, "saker": saker, "dekket": covered, "glatting_dager": 3,
            "ord": {k: {"antall": v, "andel": smooth(v)} for k, v in counts.items()}}


def last_days(now: float, days: int = 7, baseline_days: int = 28) -> dict:
    """De siste sju dagene mot de fire ukene før: hvilke ord nevnes mer enn vanlig nå."""
    recent_cut = now - days * 86400
    arts = _articles(recent_cut - baseline_days * 86400)
    recent = [a for a in arts if a["publisert"] > recent_cut]
    base = [a for a in arts if a["publisert"] <= recent_cut]
    out = []
    for t in TERMS:
        hits = [a for a in recent if t["id"] in a["ord"]]
        n_base = sum(t["id"] in a["ord"] for a in base)
        share = 100 * len(hits) / max(len(recent), 1)
        base_share = 100 * n_base / len(base) if base else None
        partners: dict[str, int] = {}
        for a in hits:
            for o in a["ord"]:
                if o != t["id"]:
                    partners[o] = partners.get(o, 0) + 1
        out.append({
            "id": t["id"], "navn": t["navn"], "antall": len(hits), "andel": round(share, 2),
            "faktor": round(share / max(base_share, 100 / max(len(base), 1)), 1) if base_share is not None else None,
            "sammen_med": [k for k, _ in sorted(partners.items(), key=lambda kv: -kv[1])[:3]],
            "tittel": _title(hits[0]) if hits else None,
        })
    out.sort(key=lambda x: -x["antall"])
    return {"saker": len(recent), "ord": out}


def summary(previous: list[dict] | None = None) -> dict:
    now = time.time()
    _articles(datetime.fromisoformat(_week_starts(now)[0]).replace(tzinfo=OSLO).timestamp() - 1)
    weeks = merge(weekly(now), previous)
    data = analyse(weeks, now)
    data["rå"] = weeks  # flettes inn ved neste øyeblikksbilde
    return data
