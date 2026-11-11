# World News Globe

Explore world news by place and time on an interactive 3D globe. First version: a visual prototype with a small set of manually compiled, sourced events from around the world, plus automated items from open data feeds.

**Live site:** https://kianosh-solheim.github.io/Globe/

## What it does

- **Globe.** Rotate and zoom. Three map styles: dark, political, satellite.
- **Stories by location.** Markers cluster at a distance and separate as you zoom in. Topic filters and place search on the left.
- **Timeline.** Pick a date, step by the hour, or press play to watch events appear in order. The banner at the top always says whether you are looking at current news or historical playback.
- **Story panel.** Headline, summary, location, event time, first-reported time, people, sources, related events.
- **As reported then / Retrospective.** "As reported then" shows only what had been reported by the selected time, and hides later updates and later-published sources. "Retrospective" includes everything known now.
- **Confidence labels.** Each statement is marked Confirmed, Reported, Disputed or Unknown, with attribution.
- **Approximate areas.** Events without a precise location are drawn as an area, not a pin.
- **Schematic movement.** One reviewed animation (delegations convening for the Abu Dhabi talks). Strikes with no reported launch point show the impact location only.

## How the data works

| File | Contents | Updated by |
| --- | --- | --- |
| `data/events.json` | Curated events with sources, confidence levels and update history | Hand |
| `data/live.json` | Automated feed items | `scripts/fetch-feeds.mjs`, hourly in GitHub Actions |
| `data/gazetteer.json` | Country, city and place coordinates for search and for locating feed items | Generated once |

### Live feeds

The workflow in `.github/workflows/pages.yml` runs every hour, refreshes `data/live.json` and redeploys the site. Feeds used:

- **USGS Earthquake Hazards Program**: earthquakes of magnitude 5.5 and above (public domain).
- **NASA EONET**: open natural events such as storms, volcanoes and wildfires.
- **GDACS**: orange and red disaster alerts.
- **UN News**: headlines, placed at country level by matching place names in the text. These carry a publication time only, and the panel says so.

Live items are labelled as automated and not editorially reviewed. Only the headline, link and a short description from the feed are stored. If the scheduled job has not produced recent data, the page loads earthquakes directly from USGS in the browser.

To add a feed, write a parser in `scripts/fetch-feeds.mjs` that returns items with `id, title, url, time, published, lat, lng, category` and add it to `FEEDS`. Check the provider's terms first.

GitHub pauses scheduled workflows after 60 days without repository activity; re-enable it under the Actions tab if that happens.

### Adding a curated event

Append an object to `events` in `data/events.json`:

```json
{
  "id": "unique-slug",
  "category": "conflict | security | politics | diplomacy | disaster | protest | climate | humanitarian | other",
  "headline": "…",
  "place": "…",
  "lat": 0, "lng": 0,
  "precision": "exact | city | approximate | country",
  "radiusKm": 30,
  "time": "2026-11-08T05:00:00Z",
  "timePrecision": "exact | morning | midday | evening | overnight | day | uncertain",
  "learnedAt": "2026-11-08T17:39:00Z",
  "status": "confirmed | reported | disputed",
  "summary": "…",
  "facts": [{"level": "confirmed | reported | disputed | unknown", "text": "…", "by": "who says so"}],
  "updates": [{"at": "…", "text": "…", "by": "…", "facts": [], "replaceFacts": []}],
  "people": [{"name": "…", "role": "…"}],
  "movement": {"type": "diplomatic | drone", "label": "…", "note": "why this is schematic",
               "legs": [{"from": {"name": "…", "lat": 0, "lng": 0}, "to": {"name": "…", "lat": 0, "lng": 0}}]},
  "sources": [{"publisher": "…", "title": "…", "url": "…", "published": "2026-11-08 or full ISO time"}],
  "related": ["other-id"]
}
```

- `time` is when the event happened; `learnedAt` is when reporting first appeared. They are kept separate on purpose.
- `radiusKm` draws an approximate area. Use it whenever the reporting does not support a precise point.
- An update's `facts` are appended; `replaceFacts` replaces the list, for corrected figures.
- Add `movement` only when origin and destination are established by reporting, and say in `note` what the line does and does not show.

## Limits of this version

- The curated set covers 1–11 November 2026 and does not update itself. Where a source gives only a date, first-reported and update times are approximate.
- Summaries are paraphrases written for this project. No article text or news photographs are reproduced; people are shown with initials placeholders.
- Country outlines are low resolution (Natural Earth 1:110m).
- There is no article grouping, editorial review tool or database yet. Those belong to the next stage of the build sequence.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node scripts/fetch-feeds.mjs  # optional: refresh data/live.json (Node 20+)
```

## Credits

[globe.gl](https://github.com/vasturiano/globe.gl) and three.js (MIT) · country shapes from [world-atlas](https://github.com/topojson/world-atlas) / Natural Earth · satellite texture from NASA Blue Marble · feed data from USGS, NASA EONET, GDACS and UN News.
