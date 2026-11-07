# Nordvakt

OSINT-plattform for Norge, bygget på åpne offentlige data.

## Moduler

**Maritim.** Henter sanntids AIS fra Kystverkets åpne strøm (`153.44.253.27:5631`, NLOD) og viser fartøy på kart med flaggstat utledet fra MMSI. Appen varsler når:
- `flagg_i_sone`: et fartøy med flagg på overvåkingslisten (`WATCH_FLAGS` i `app/ais.py`) går inn i en sone
- `opphold`: et utenlandsk fartøy holder lav fart (< 1,5 kn) i over 20 minutter i en sone

Sonene ligger i `data/zones.json` og kan redigeres fritt. Koordinatene er omtrentlige. Varslene er indikatorer og må vurderes manuelt.

**Selskapsnettverk.** Bruker Enhetsregisterets åpne API. Du søker opp et selskap og utvider grafen selskap for selskap med rolleinnehavere (styre, daglig leder, revisor og så videre). Personer kobles på navn og fødselsdato, men bare fødselsåret vises (dataminimering).

**Kildelogg.** Alle oppslag mot eksterne kilder logges i `data/kildelogg.sqlite` med tidspunkt, URL og SHA-256 av svaret.

## Kjøre lokalt

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```

Åpne http://localhost:8000.

## Avgrensning

Plattformen handler om virksomheter, infrastruktur og fartøy, ikke om å kartlegge privatpersoner. Personopplysninger fra offentlige registre brukes bare som roller i virksomheter.

## Mulige neste steg

- Sanksjonsscreening av selskaper og fartøy (OpenSanctions)
- Lagre AIS-historikk (PostGIS) for å oppdage AIS-brudd («dark activity») og møter mellom fartøy
- Koble fartøy til rederi og eier
- Nyhetsovervåking med norsk NER (NB-BERT)
