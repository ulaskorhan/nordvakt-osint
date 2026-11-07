import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import ais, brreg, news, provenance

logging.basicConfig(level=logging.INFO)
STATIC = Path(__file__).resolve().parent.parent / "static"

store = ais.AISStore(ais.load_zones())


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [asyncio.create_task(ais.run(store)), asyncio.create_task(news.run())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Nordvakt", lifespan=lifespan)


# --- Maritim ---

@app.get("/api/ais/status")
def ais_status():
    return store.status()


@app.get("/api/ais/vessels")
def ais_vessels():
    return store.compact()


@app.get("/api/ais/vessel/{mmsi}")
def ais_vessel(mmsi: int):
    v = store.detail(mmsi)
    if v is None:
        raise HTTPException(404, "Ukjent MMSI")
    return v


@app.get("/api/ais/alerts")
def ais_alerts():
    return list(store.alerts)


@app.get("/api/zones")
def zones():
    return store.zones


# --- Nyheter ---

@app.get("/api/news")
def news_articles(timer: int = 72, q: str | None = None, enhet: str | None = None, kun_treff: bool = False):
    return news.articles(hours=timer, q=q, enhet=enhet, kun_treff=kun_treff)


@app.get("/api/news/entities")
def news_entities(timer: int = 72):
    return news.top_entities(hours=timer)


@app.get("/api/news/places")
def news_places(timer: int = 72):
    return news.places(hours=timer)


@app.get("/api/news/status")
def news_status():
    return news.status()


# --- Selskapsnettverk ---

@app.get("/api/brreg/search")
async def brreg_search(q: str):
    return await brreg.search(q)


@app.get("/api/brreg/network/{orgnr}")
async def brreg_network(orgnr: str, tidligere: bool = False):
    return await brreg.network(orgnr, include_former=tidligere)


@app.get("/api/kildelogg")
def kildelogg(limit: int = 100):
    return provenance.recent(limit)


@app.get("/")
def home():
    return FileResponse(STATIC / "home.html")


@app.get("/app")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
