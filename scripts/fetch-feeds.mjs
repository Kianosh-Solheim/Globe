#!/usr/bin/env node
// Collects automated items from open feeds into data/live.json.
// Runs in GitHub Actions on a schedule (see .github/workflows/pages.yml). Node 20+, no dependencies.
// Each feed is independent: one failing does not stop the others, and a total failure keeps the previous file.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'live.json');
const MAX_AGE = 10 * 864e5, now = Date.now();
const UA = 'WorldNewsGlobe/0.1 (+https://github.com/Kianosh-Solheim/Globe)';

const get = async (url, as = 'text') => {
  const r = await fetch(url, {headers: {'user-agent': UA, accept: '*/*'}, signal: AbortSignal.timeout(25000)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === 'json' ? r.json() : r.text();
};
const ents = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = s => s.replace(/<[^>]+>/g, ' ');
// Feed text is often HTML escaped inside XML, so unescape and strip twice.
const decode = s => ents(strip(ents(strip(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))))).replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
const items = xml => xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
const iso = d => { const t = new Date(d); return isNaN(t) ? null : t.toISOString(); };
const clip = (s, n) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;

/* ---- gazetteer matching for feeds that carry no coordinates ---- */
const GAZ = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'gazetteer.json'), 'utf8'));
const NAMES = GAZ.flatMap(g => [g.n, ...(g.a || [])].filter(n => n.length > 1 && !/\.$/.test(n)).map(n => ({n, g})));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function locate(text) {
  let best = null;
  for (const {n, g} of NAMES) {
    // Short all-caps aliases (US, UK, UAE) must match case-sensitively; others ignore case.
    const re = new RegExp(`(?<![\\p{L}-])${esc(n)}(?![\\p{L}-])`, /^[A-Z.]{2,4}$/.test(n) ? 'u' : 'iu');
    const m = re.exec(text);
    if (m && (!best || m.index < best.i || (m.index === best.i && n.length > best.n.length))) best = {i: m.index, n, g};
  }
  return best && {...best.g, n: best.n.length > 3 ? best.n : best.g.n};
}
export function categorise(text) {
  const t = text.toLowerCase();
  if (/\b(earthquake|quake|flood|cyclone|hurricane|typhoon|storm|drought|wildfire|volcan|landslide|tsunami)/.test(t)) return 'disaster';
  if (/\b(attack|air ?strike|strikes? on|war\b|killed|ceasefire|fighting|bomb|missile|drone|shelling|hostilit|troops)/.test(t)) return 'conflict';
  if (/\b(refugee|famine|hunger|displace|migrant|humanitarian|aid\b|malnutrition|cholera)/.test(t)) return 'humanitarian';
  if (/\b(climate|cop\d\d|emission|biodiversity|pollution)/.test(t)) return 'climate';
  if (/\b(protest|demonstrat|strike\b|rally)/.test(t)) return 'protest';
  if (/\b(election|vote|parliament|coup|referendum|president|prime minister)/.test(t)) return 'politics';
  if (/\b(talks|summit|security council|envoy|treaty|negotiat|diplomat)/.test(t)) return 'diplomacy';
  return 'other';
}

/* ---- feeds ---- */
export function parseUSGS(j) {
  return j.features.filter(f => f.properties.mag >= 5.5 && f.geometry).map(f => ({
    id: 'usgs-' + f.id, src: 'usgs', srcName: 'USGS Earthquake Hazards Program', title: f.properties.title, url: f.properties.url,
    time: iso(f.properties.time), published: iso(f.properties.time), timeBasis: 'event',
    lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], precision: 'exact', category: 'disaster', place: f.properties.place || '',
    detail: `Magnitude ${f.properties.mag} earthquake, depth ${Math.round(f.geometry.coordinates[2])} km. Automated record from USGS; values may be revised.`
  }));
}
export function parseEONET(j) {
  const out = []; let fires = 0;
  for (const e of j.events || []) {
    const g = (e.geometry || []).filter(x => x.type === 'Point').pop(); if (!g) continue;
    const cat = (e.categories || [])[0] || {};
    if (cat.id === 'wildfires' && ++fires > 8) continue;
    out.push({
      id: 'eonet-' + e.id, src: 'eonet', srcName: 'NASA EONET', title: e.title, url: (e.sources && e.sources[0] && e.sources[0].url) || e.link,
      time: iso(g.date), published: iso(g.date), timeBasis: 'event', lat: g.coordinates[1], lng: g.coordinates[0], precision: 'exact',
      category: cat.id === 'seaLakeIce' ? 'climate' : 'disaster', place: '',
      detail: `${cat.title || 'Natural event'} tracked by NASA's Earth Observatory Natural Event Tracker. Position is the latest reported observation.`
    });
  }
  return out;
}
export function parseGDACS(xml) {
  const kinds = {EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire'};
  return items(xml).map(x => {
    const pt = tag(x, 'georss:point').split(/\s+/).map(Number), level = tag(x, 'gdacs:alertlevel'), type = tag(x, 'gdacs:eventtype');
    if (pt.length < 2 || pt.some(isNaN) || !/orange|red/i.test(level)) return null;
    const t = iso(tag(x, 'gdacs:fromdate')) || iso(tag(x, 'pubDate'));
    return {
      id: 'gdacs-' + type + (tag(x, 'gdacs:eventid') || tag(x, 'guid')), src: 'gdacs', srcName: 'GDACS', title: tag(x, 'title'), url: tag(x, 'link'),
      time: t, published: iso(tag(x, 'pubDate')) || t, timeBasis: 'event', lat: pt[0], lng: pt[1], precision: type === 'EQ' ? 'exact' : 'approximate',
      category: 'disaster', place: tag(x, 'gdacs:country'),
      detail: `${kinds[type] || 'Hazard'} with ${level.toLowerCase()} alert level from the Global Disaster Alert and Coordination System. Automated impact estimate, not a damage report.`
    };
  }).filter(Boolean);
}
export function parseUNNews(xml) {
  return items(xml).map(x => {
    const title = tag(x, 'title'), desc = tag(x, 'description'), link = tag(x, 'link') || tag(x, 'guid');
    const g = locate(title) || locate(desc); if (!g) return null;
    const p = iso(tag(x, 'pubDate')); if (!p) return null;
    return {
      id: 'un-' + (link.match(/(\d+)\/?$/) || [0, Buffer.from(link).toString('base64url').slice(-12)])[1], src: 'unnews', srcName: 'UN News', title, url: link,
      time: p, published: p, timeBasis: 'published', lat: g.lat, lng: g.lng, precision: 'country', category: categorise(title + ' ' + desc), place: g.n,
      detail: clip(desc, 180)
    };
  }).filter(Boolean);
}

const FEEDS = [
  {id: 'usgs', name: 'USGS', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', as: 'json', parse: parseUSGS},
  {id: 'eonet', name: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10&limit=60', as: 'json', parse: parseEONET},
  {id: 'gdacs', name: 'GDACS', url: 'https://www.gdacs.org/xml/rss.xml', as: 'text', parse: parseGDACS},
  {id: 'unnews', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', as: 'text', parse: parseUNNews}
];

async function main() {
  const sources = [], all = [];
  for (const f of FEEDS) {
    try {
      const got = f.parse(await get(f.url, f.as)).filter(i => i.time && isFinite(i.lat) && isFinite(i.lng) && now - new Date(i.time) < MAX_AGE && new Date(i.time) <= now + 36e5);
      all.push(...got.slice(0, 50)); sources.push({id: f.id, name: f.name, url: f.url, ok: true, count: got.length});
      console.log(`${f.id}: ${got.length} items`);
    } catch (e) {
      sources.push({id: f.id, name: f.name, url: f.url, ok: false, error: String(e.message || e)});
      console.warn(`${f.id}: failed (${e.message || e})`);
    }
  }
  if (!all.length) { console.warn('No feed returned items; keeping the existing data/live.json.'); return; }
  const seen = new Set(), items = all.filter(i => !seen.has(i.id) && seen.add(i.id)).sort((a, b) => new Date(b.time) - new Date(a.time));
  fs.writeFileSync(OUT, JSON.stringify({generated: new Date().toISOString(), sources, items}, null, 1));
  console.log(`Wrote ${items.length} items to data/live.json`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
