"""Selskapsnettverk fra Enhetsregisteret (Brønnøysundregistrene).

API-et er åpent (NLOD-lisens) og krever ingen nøkkel. Det gir roller *i* et selskap,
men ikke omvendt (hvilke selskaper en person har roller i). Nettverket bygges derfor
ved at analytikeren utvider selskap for selskap, og personer som går igjen i flere
selskaper kobles sammen på navn + fødselsdato.
"""

import hashlib
import re

import httpx

from . import provenance

BASE = "https://data.brreg.no/enhetsregisteret/api"
_client = httpx.AsyncClient(timeout=15, headers={"Accept": "application/json"})


async def _get(url: str, params: dict | None = None) -> dict | None:
    resp = await _client.get(url, params=params)
    provenance.log("Enhetsregisteret", str(resp.url), resp.status_code, resp.content)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def _summary(e: dict) -> dict:
    addr = e.get("forretningsadresse") or e.get("beliggenhetsadresse") or {}
    return {
        "orgnr": e.get("organisasjonsnummer"),
        "navn": e.get("navn"),
        "form": (e.get("organisasjonsform") or {}).get("beskrivelse"),
        "kommune": addr.get("kommune"),
        "adresse": ", ".join(filter(None, [*addr.get("adresse", []), addr.get("postnummer"), addr.get("poststed")])),
        "naering": (e.get("naeringskode1") or {}).get("beskrivelse"),
        "ansatte": e.get("antallAnsatte"),
        "stiftet": e.get("stiftelsesdato"),
        "konkurs": e.get("konkurs", False),
        "underAvvikling": e.get("underAvvikling", False),
        "slettet": bool(e.get("slettedato")),
        "overordnet": e.get("overordnetEnhet"),
        "hjemmeside": e.get("hjemmeside"),
    }


async def search(q: str) -> list[dict]:
    q = q.strip()
    digits = re.sub(r"\s", "", q)
    if re.fullmatch(r"\d{9}", digits):
        e = await get_enhet(digits)
        return [e] if e else []
    data = await _get(f"{BASE}/enheter", {"navn": q, "size": 20})
    return [_summary(e) for e in (data or {}).get("_embedded", {}).get("enheter", [])]


async def get_enhet(orgnr: str) -> dict | None:
    e = await _get(f"{BASE}/enheter/{orgnr}")
    if e is None:
        # Underenheter (avdelinger) ligger i et eget register
        e = await _get(f"{BASE}/underenheter/{orgnr}")
    return _summary(e) if e else None


def _person_id(p: dict) -> str:
    n = p.get("navn", {})
    key = f"{n.get('fornavn', '')}|{n.get('mellomnavn', '')}|{n.get('etternavn', '')}|{p.get('fodselsdato', '')}"
    return "p:" + hashlib.sha1(key.encode()).hexdigest()[:12]


def _person_name(p: dict) -> str:
    n = p.get("navn", {})
    return " ".join(filter(None, [n.get("fornavn"), n.get("mellomnavn"), n.get("etternavn")]))


def _role_orgnr(enhet: dict) -> str | None:
    if enhet.get("organisasjonsnummer"):
        return enhet["organisasjonsnummer"]
    href = enhet.get("_links", {}).get("self", {}).get("href", "")
    m = re.search(r"/(\d{9})$", href)
    return m.group(1) if m else None


async def network(orgnr: str, include_former: bool = False) -> dict:
    """Noder og kanter for ett selskap: rolleinnehavere og eventuelt overordnet enhet."""
    company = await get_enhet(orgnr)
    if company is None:
        return {"nodes": [], "edges": []}

    nodes = {orgnr: {"id": orgnr, "type": "selskap", "label": company["navn"], "data": company, "utvidet": True}}
    edges = []

    if company.get("overordnet"):
        parent = company["overordnet"]
        nodes.setdefault(parent, {"id": parent, "type": "selskap", "label": parent, "data": {"orgnr": parent}})
        edges.append({"source": orgnr, "target": parent, "label": "Del av"})

    roller = await _get(f"{BASE}/enheter/{orgnr}/roller") or {}
    for gruppe in roller.get("rollegrupper", []):
        for r in gruppe.get("roller", []):
            if r.get("avregistrert") and not include_former:
                continue
            rolle = r.get("type", {}).get("beskrivelse", "Rolle")
            if r.get("fratraadt"):
                rolle += " (fratrådt)"
            if "person" in r:
                p = r["person"]
                pid = _person_id(p)
                # Dataminimering: bare fødselsår vises, full dato brukes kun til å skille personer
                year = (p.get("fodselsdato") or "")[:4]
                nodes.setdefault(pid, {
                    "id": pid, "type": "person", "label": _person_name(p),
                    "data": {"fodselsaar": year, "erDoed": p.get("erDoed", False)},
                })
                edges.append({"source": pid, "target": orgnr, "label": rolle})
            elif "enhet" in r:
                ro = _role_orgnr(r["enhet"])
                if not ro:
                    continue
                navn = " ".join(r["enhet"].get("navn", [])) or ro
                nodes.setdefault(ro, {"id": ro, "type": "selskap", "label": navn, "data": {"orgnr": ro}})
                edges.append({"source": ro, "target": orgnr, "label": rolle})

    return {"nodes": list(nodes.values()), "edges": edges}
