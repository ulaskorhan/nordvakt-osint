from .. import news
from .base import Connector, entity, norm_org, relation

KILDE = "Nyheter (RSS)"
STEDSNAVN = "Kartverket stedsnavn"


def article_entity(a: dict) -> dict:
    return entity(
        f"article:{a['id']}", "article", a["tittel"], kilde=a["kilde"],
        beskrivelse=a["sammendrag"][:160] or None, tid=a["publisert"],
        lenke=a["lenke"], medium=a["kilde"],
    )


def place_entity(p: dict) -> dict:
    besk = f"{p['type']} i {p['kommune']}" if p.get("kommune") else p.get("type")
    return entity(f"place:{p['navn']}", "place", p["navn"], kilde=STEDSNAVN, beskrivelse=besk,
                  lat=p["lat"], lon=p["lon"], stedstype=p.get("type"), kommune=p.get("kommune"))


def mention_entity(name: str, count: int | None = None) -> dict:
    besk = f"Nevnt i {count} nyhetssak{'er' if count != 1 else ''}" if count else "Organisasjon nevnt i nyheter"
    return entity(f"orgnavn:{name}", "org", name, kilde=KILDE, beskrivelse=besk, uavklart=True)


class NewsConnector(Connector):
    name = KILDE
    prefixes = ("article", "place", "orgnavn")

    async def run(self) -> None:
        await news.run()

    async def search(self, q: str) -> list[dict]:
        q = q.strip()
        if len(q) < 2:
            return []
        places = news.search_places(q)
        if not any(p["navn"].lower() == q.lower() for p in places) and len(q) >= 3:
            # Ikke sett i nyhetene ennå: slå opp i Kartverkets stedsnavnregister
            p = await news.resolve_place(q[:1].upper() + q[1:])
            if p:
                places.insert(0, p)
        return (
            [place_entity(p) for p in places]
            + [mention_entity(t, n) for t, n in news.search_org_mentions(q)]
            + [article_entity(a) for a in news.search_articles(q)]
        )

    async def get(self, eid: str) -> dict | None:
        prefix, key = eid.split(":", 1)
        if prefix == "article":
            a = news.get_article(key)
            return article_entity(a) if a else None
        if prefix == "place":
            p = news.get_place(key) or await news.resolve_place(key)
            return place_entity(p) if p else None
        n = len(news.articles_by_entity(key, limit=1000))
        return mention_entity(key, n) if n else None

    async def expand(self, e: dict) -> tuple[list[dict], list[dict]]:
        t, eid = e["type"], e["id"]

        if t == "article":
            ents, rels = [], []
            for x in news.entities_of(eid.split(":", 1)[1]):
                if x["type"] == "ORG":
                    other = mention_entity(x["tekst"])
                elif x["type"] == "STED" and x["funnet"]:
                    other = place_entity({"navn": x["tekst"], "lat": x["lat"], "lon": x["lon"],
                                          "type": x["stedstype"], "kommune": x["kommune"]})
                else:
                    continue
                ents.append(other)
                rels.append(relation(eid, other["id"], "Nevner", KILDE))
            return ents, rels

        if eid.startswith(("place:", "orgnavn:")):
            articles = news.articles_by_entity(e["label"])
        elif t == "zone":
            articles = news.articles_matching(e["props"].get("alias") or [e["label"]])
        elif t == "org":
            name = norm_org(e["label"])
            # Korte navn (f.eks. «DNB») gir for mange tilfeldige treff i fritekst
            articles = news.articles_matching([name]) if len(name) >= 4 else news.articles_by_entity(e["label"])
        elif t == "vessel" and len(e["label"]) >= 5 and not e["label"].startswith("MMSI"):
            articles = news.articles_matching([e["label"]], limit=10)
        else:
            return [], []

        ents = [article_entity(a) for a in articles]
        return ents, [relation(a["id"], eid, "Nevner", KILDE) for a in ents]
