# Nordvakt

OSINT-plattform for Norge, bygget på åpne offentlige data.

## Moduler

**Maritim.** Henter sanntids AIS fra Kystverkets åpne strøm (`153.44.253.27:5631`, NLOD) og viser fartøy på kart med flaggstat utledet fra MMSI. Appen varsler når:
- `flagg_i_sone`: et fartøy med flagg på overvåkingslisten (`WATCH_FLAGS` i `app/ais.py`) går inn i en sone
- `opphold`: et utenlandsk fartøy holder lav fart (< 1,5 kn) i over 20 minutter i en sone

Sonene ligger i `data/zones.json` og kan redigeres fritt. Koordinatene er omtrentlige. Varslene er indikatorer og må vurderes manuelt.

**Selskapsnettverk.** Bruker Enhetsregisterets åpne API. Du søker opp et selskap og utvider grafen selskap for selskap med rolleinnehavere (styre, daglig leder, revisor og så videre). Personer kobles på navn og fødselsdato, men bare fødselsåret vises (dataminimering).

**Nyheter.** Henter RSS fra NRK (inkludert regionkontorene langs kysten), E24, VG, Teknisk Ukeblad og regjeringen.no hvert 15. minutt. Kildene står i `data/feeds.json`. Den norske språkmodellen `nb_core_news_md` fra spaCy finner organisasjoner, steder og hendelser i tittel og ingress. Steder plasseres på kartet via Kartverkets stedsnavn-API. For å unngå feilplasseringer godtas bare større stedstyper som kommune, by, fjord og havn, og landnavn plasseres aldri. Saker som nevner et emneord fra `feeds.json` blir markert. Organisasjoner kan åpnes direkte i selskapsnettverket.

Personnavn gjenkjennes av modellen, men forkastes med vilje og lagres ikke.

**Kildelogg.** Alle oppslag mot eksterne kilder logges i `data/kildelogg.sqlite` med tidspunkt, URL og SHA-256 av svaret.

## Kjøre lokalt

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m spacy download nb_core_news_md
.venv/bin/uvicorn app.main:app --port 8000
```

Åpne http://localhost:8000.

## Avgrensning

Plattformen handler om virksomheter, infrastruktur og fartøy, ikke om å kartlegge privatpersoner. Personopplysninger fra offentlige registre brukes bare som roller i virksomheter.

## Mulige neste steg

- Sanksjonsscreening av selskaper og fartøy (OpenSanctions)
- Lagre AIS-historikk (PostGIS) for å oppdage AIS-brudd («dark activity») og møter mellom fartøy
- Koble fartøy til rederi og eier
- Bytte til NB-BERT (Nasjonalbiblioteket) for mer presis gjenkjenning av enheter i nyhetene
