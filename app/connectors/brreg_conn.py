from .. import brreg
from .base import Connector, date_to_epoch, entity, norm_org, relation

KILDE = "Enhetsregisteret"


def org_entity(s: dict, lat: float | None = None, lon: float | None = None) -> dict:
    status = [x for x, on in (("Konkurs", s.get("konkurs")), ("Under avvikling", s.get("underAvvikling")),
                              ("Slettet", s.get("slettet"))) if on]
    besk = " · ".join(filter(None, [s.get("form"), (s.get("kommune") or "").title() or None]))
    return entity(
        f"org:{s['orgnr']}", "org", s.get("navn") or s["orgnr"], kilde=KILDE, beskrivelse=besk or None,
        lat=lat, lon=lon, tid=date_to_epoch(s.get("stiftet")),
        orgnr=s["orgnr"], form=s.get("form"), naering=s.get("naering"), adresse=s.get("adresse"),
        ansatte=s.get("ansatte"), stiftet=s.get("stiftet"), status=", ".join(status) or None,
        hjemmeside=s.get("hjemmeside"),
    )


class BrregConnector(Connector):
    name = KILDE
    prefixes = ("org",)

    async def search(self, q: str) -> list[dict]:
        return [org_entity(s) for s in (await brreg.search(q))[:8]]

    async def get(self, eid: str) -> dict | None:
        s = await brreg.get_enhet(eid.split(":", 1)[1])
        if s is None:
            return None
        pos = await brreg.geocode_address(s.get("gate"), s.get("postnummer"))
        return org_entity(s, *(pos or (None, None)))

    async def expand(self, e: dict) -> tuple[list[dict], list[dict]]:
        if e["id"].startswith("org:"):
            return await self._roles(e)
        if e["id"].startswith("orgnavn:"):
            return await self._resolve_mention(e)
        return [], []

    async def _roles(self, e: dict) -> tuple[list[dict], list[dict]]:
        net = await brreg.network(e["props"]["orgnr"])
        ids = {}
        ents = []
        for n in net["nodes"]:
            if n["type"] == "person":
                eid = "person:" + n["id"].removeprefix("p:")
                year = n["data"].get("fodselsaar")
                ents.append(entity(eid, "person", n["label"], kilde=KILDE,
                                   beskrivelse=f"Født {year}" if year else None, fodselsaar=year))
            else:
                eid = f"org:{n['id']}"
                if eid != e["id"]:
                    ents.append(entity(eid, "org", n["label"], kilde=KILDE, orgnr=n["id"]))
            ids[n["id"]] = eid
        rels = [relation(ids[x["source"]], ids[x["target"]], x["label"], KILDE) for x in net["edges"]]
        return ents, rels

    async def _resolve_mention(self, e: dict) -> tuple[list[dict], list[dict]]:
        """Et organisasjonsnavn fra en nyhetssak: finn registerenheter med samme navn."""
        wanted = norm_org(e["label"])
        matches = [s for s in await brreg.search(e["label"]) if norm_org(s.get("navn") or "") == wanted][:3]
        ents = [org_entity(s) for s in matches]
        return ents, [relation(e["id"], o["id"], "Mulig samme som", KILDE) for o in ents]
