"""Samlet søk og entitetsoppslag på tvers av alle connectors."""

import asyncio
import logging

from . import store
from .connectors.ais_conn import AISConnector
from .connectors.brreg_conn import BrregConnector
from .connectors.news_conn import NewsConnector

log = logging.getLogger("nordvakt.core")

ais_connector = AISConnector()
CONNECTORS = [BrregConnector(), ais_connector, NewsConnector()]

# Rekkefølgen grupper vises i søkeresultatene
TYPE_ORDER = ["zone", "place", "org", "vessel", "article"]
TIMEOUT = 12


async def _safe(coro):
    try:
        return await asyncio.wait_for(coro, TIMEOUT)
    except Exception as exc:
        log.warning("Connector feilet: %r", exc)
        return exc


def _merge(a: dict | None, b: dict) -> dict:
    """Samme entitet fra flere kilder: behold det vi har, fyll inn det som mangler."""
    if a is None:
        return b
    out = {**a, "props": {**b["props"], **a["props"]}}
    for k, v in b.items():
        if k != "props" and out.get(k) in (None, ""):
            out[k] = v
    return out


async def search(q: str) -> dict:
    results = await asyncio.gather(*(_safe(c.search(q)) for c in CONNECTORS))
    by_id: dict[str, dict] = {}
    errors = {}
    for c, r in zip(CONNECTORS, results):
        if isinstance(r, Exception):
            errors[c.name] = str(r) or type(r).__name__
            continue
        for e in r:
            by_id[e["id"]] = _merge(by_id.get(e["id"]), e)
    groups = [
        {"type": t, "treff": [e for e in by_id.values() if e["type"] == t]}
        for t in TYPE_ORDER
    ]
    return {"q": q, "grupper": [g for g in groups if g["treff"]], "feil": errors}


async def entity(eid: str) -> dict | None:
    owner = next((c for c in CONNECTORS if c.owns(eid)), None)
    if owner is None:
        return None
    e = await _safe(owner.get(eid))
    if e is None or isinstance(e, Exception):
        return None

    results = await asyncio.gather(*(_safe(c.expand(e)) for c in CONNECTORS))
    related: dict[str, dict] = {}
    relations: dict[tuple, dict] = {}
    errors = {}
    for c, r in zip(CONNECTORS, results):
        if isinstance(r, Exception):
            errors[c.name] = str(r) or type(r).__name__
            continue
        ents, rels = r
        for x in ents:
            if x["id"] == eid:
                e = _merge(e, x)
            else:
                related[x["id"]] = _merge(related.get(x["id"]), x)
        for rel in rels:
            relations[(rel["fra"], rel["til"], rel["label"])] = rel

    store.save([e, *related.values()], list(relations.values()))
    return {"entity": e, "relaterte": list(related.values()), "relasjoner": list(relations.values()), "feil": errors}
