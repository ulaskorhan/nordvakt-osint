"""Felles entitetsmodell og grensesnitt for koblinger (connectors).

Alt i Nordvakt er en entitet med en id på formen "<prefiks>:<nøkkel>", f.eks.
"org:923609016", "vessel:257130600" eller "place:Bodø". Hver datakilde er en connector
som kan søke etter entiteter, slå opp en entitet den eier, og utvide en hvilken som helst
entitet med relaterte entiteter fra sin kilde. En ny kilde er dermed én ny fil.

Entitetstyper: org, person, vessel, zone, place, article. Personer kan aldri søkes opp
direkte. De dukker bare opp som roller i en virksomhet.
"""

import re
from datetime import datetime


def entity(eid: str, type_: str, label: str, *, kilde: str, beskrivelse: str | None = None,
           lat: float | None = None, lon: float | None = None, tid: float | None = None, **props) -> dict:
    return {
        "id": eid, "type": type_, "label": label, "kilde": kilde, "beskrivelse": beskrivelse,
        "lat": lat, "lon": lon, "tid": tid,
        "props": {k: v for k, v in props.items() if v not in (None, "", [], False)},
    }


def relation(fra: str, til: str, label: str, kilde: str) -> dict:
    return {"fra": fra, "til": til, "label": label, "kilde": kilde}


_LEGAL_SUFFIX = re.compile(r"\b(asa|as|sf|hf|kf|iks|ba|sa|ans|da|nuf)\b")


def norm_org(name: str) -> str:
    """'GASSCO AS' -> 'gassco', slik at registernavn kan sammenlignes med navn i nyheter."""
    n = _LEGAL_SUFFIX.sub(" ", name.lower())
    n = re.sub(r"[^\wæøå ]", " ", n)
    return " ".join(n.split())


def date_to_epoch(d: str | None) -> float | None:
    try:
        return datetime.fromisoformat(d).timestamp() if d else None
    except ValueError:
        return None


class Connector:
    name = "ukjent"
    prefixes: tuple[str, ...] = ()

    def owns(self, eid: str) -> bool:
        return eid.split(":", 1)[0] in self.prefixes

    async def search(self, q: str) -> list[dict]:
        return []

    async def get(self, eid: str) -> dict | None:
        return None

    async def expand(self, e: dict) -> tuple[list[dict], list[dict]]:
        return [], []

    async def run(self) -> None:
        """Bakgrunnsjobb for kilder som strømmer eller hentes periodisk."""
        return None
