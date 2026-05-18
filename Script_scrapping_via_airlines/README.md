# Airnavradar Scraper

Script pour scraper les vols depuis [airnavradar.com](https://www.airnavradar.com) avec bypass Cloudflare.

## Installation

```bash
npm install
```

## Utilisation

```bash
# Scraper UPS (mode visible - recommandé)
node scraper.js UPS

# Scraper FedEx avec max 50 clics
node scraper.js FDX --max=50

# Mode headless (peut être bloqué par Cloudflare)
node scraper.js DHL --headless
```

## Options

| Option | Description |
|--------|-------------|
| `CODE_ICAO` | Code ICAO de la compagnie (obligatoire) |
| `--max=N` | Nombre maximum de clics sur "Load Earlier/Later" (défaut: 100) |
| `--headless` | Mode sans interface graphique (déconseillé) |

## Sortie

Le script génère un fichier `flights_XXX.json` contenant:
- `airline`: Code de la compagnie
- `scraped_at`: Date/heure du scraping
- `total_flights`: Nombre de vols
- `flights`: Tableau des vols avec:
  - `date`, `flight`, `origin`, `destination`
  - `std` (heure départ), `sta` (heure arrivée)
  - `aircraft`, `status`, `duration`

