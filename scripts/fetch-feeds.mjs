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

/* ---- NRK (Norway): district feeds, placed by matching Norwegian place names ---- */
const NO = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'norway-places.json'), 'utf8'));
const PREP = '(?:[Ii]|[Pp]å|[Vv]ed|[Ff]r[aå]|[Tt]il|[Uu]t[ae]nfor|[Nn]ær|[Mm]ot|[Gg]jennom|[Ff]orbi|(?:[Ss]ør|[Nn]ord|[Øø]st|[Vv]est) for)';
const NO_RE = NO.flatMap(g => [g.n, ...(g.a || [])].map(n => ({g, n,
  prep: new RegExp(`(?<![\\p{L}])${PREP}\\s+${esc(n)}(?![\\p{L}-])`, 'u'),
  // municipality name fused with a landmark word: "Lærdalstunnelen", "Tromsøbrua"
  comp: g.t === 'kommune' && n.length > 3 ? new RegExp(`(?<![\\p{L}-])${esc(n)}s?(?:tunnelen|brua|broen|brui|sykehuset|sjukehuset|ferja|ferga|havna|hamna|lufthavn|flyplass|sentrum|området|fjorden|elva|vassdraget)(?![\\p{L}])`, 'u') : null,
  // strong names also match as the first part of a hyphenated compound ("Voss-ordføraren")
  bare: g.w ? null : new RegExp(`(?<![\\p{L}-])${esc(n)}(?![\\p{L}])`, 'u')})));
// A name after a preposition ("i Bergen", "på Voss") is strong evidence. Bare names count only for
// municipalities, counties and large towns, because many small place names are also surnames or common words.
export function locateNorway(title, desc, fylker = []) {
  let best = null;
  for (const [text, inTitle] of [[title, 1], [desc, 0]]) {
    for (const {g, n, prep, bare, comp} of NO_RE) {
      let m = prep.exec(text), score = 3;
      if (!m && bare) { m = bare.exec(text); score = 2; }
      if (!m && comp) { m = comp.exec(text); score = 2.5; }
      if (!m) continue;
      score += inTitle + (fylker.includes(g.f) ? 2 : 0) + (g.t === 'fylke' ? 0 : g.t === 'omr' ? 0.3 : 0.5) + Math.min(n.length, 12) / 100;
      if (!best || score > best.score || (score === best.score && m.index < best.i)) best = {score, i: m.index, g, n, inTitle};
    }
  }
  return best;
}
export function categoriseNo(text) {
  const t = text.toLowerCase();
  if (/(flom|skred|\bras\b|raset|brann|brenn|storm|uvær|ekstremvær|ulykke|ulukke|jordskjelv|kolli|forlis|omkom|krasj)/.test(t)) return 'disaster';
  if (/(politi|drap|skutt|skyt|knivst|sikta|siktet|pågrep|tiltal|dømt|dømd|vold|\bran\b|ranet|trussel|narkotika|fengsel|retten|rettssak)/.test(t)) return 'security';
  if (/(streik|demonstra|aksjon|protest)/.test(t)) return 'protest';
  if (/(klima|miljø|utslipp|utslepp|vindkraft|naturvern|rovdyr|ulv|oppdrett|forurens)/.test(t)) return 'climate';
  if (/(storting|regjering|ordfør|kommunestyr|fylkesting|\bvalg|statsbudsjett|minister|parti|\bfrp\b|\bap\b|høyre|høgre|\bsv\b|senterpartiet|budsjett)/.test(t)) return 'politics';
  if (/(flyktning|asyl|nødhjelp)/.test(t)) return 'humanitarian';
  return 'other';
}
const NRK_FEEDS = [
  ['Buskerud', 'ostafjells/buskerud|buskerud', ['33']], ['Troms og Finnmark', 'nordnytt|tromsogfinnmark|troms|finnmark', ['55', '56'], [69.65, 18.96]], ['Hedmark og Oppland', 'ho', ['34']],
  ['Hordaland', 'hordaland', ['46'], [60.39, 5.32]], ['Sogn og Fjordane', 'sognogfjordane', ['46'], [61.45, 5.85]], ['Møre og Romsdal', 'mr', ['15']],
  ['Nordland', 'nordland', ['18']], ['Rogaland', 'rogaland', ['11']], ['Sørlandet', 'sorlandet', ['42']], ['Telemark', 'ostafjells/telemark', ['40']],
  ['Trøndelag', 'trondelag', ['50']], ['Vestfold', 'ostafjells/vestfold', ['39']], ['Østfold', 'ostfold', ['31']],
  ['Østlandssendingen', 'ostlandssendingen', ['03', '32'], [59.91, 10.75]], ['Norge', '', []]
];
export function parseNRK(xml, [district, , fylker, centre]) {
  return items(xml).map(x => {
    const title = tag(x, 'title'), desc = tag(x, 'description'), link = tag(x, 'link') || tag(x, 'guid'), p = iso(tag(x, 'pubDate') || tag(x, 'dc:date'));
    if (!title || !link || !p) return null;
    const hit = locateNorway(title, desc, fylker);
    let g, note;
    if (hit) { g = hit.g; note = `Placed at ${hit.n} because the place is named in the ${hit.inTitle ? 'headline' : 'summary'}. The event itself may be somewhere else nearby.`; }
    else if (fylker.length) {
      const f = NO.find(o => o.t === 'fylke' && o.f === fylker[0]);
      g = {n: district, lat: centre ? centre[0] : f.lat, lng: centre ? centre[1] : f.lng, r: 60};
      note = `No place name was recognised in the text, so this is placed at the centre of the NRK ${district} district.`;
    } else return null;
    return {
      id: 'nrk-' + ((link.match(/1\.(\d+)/) || [])[1] || Buffer.from(link).toString('base64url').slice(-14)), src: 'nrk', srcName: 'NRK' + (fylker.length ? ' ' + district : ''),
      title, url: link, time: p, published: p, timeBasis: 'published', lat: g.lat, lng: g.lng, precision: 'approximate', radiusKm: g.r || 8,
      category: categoriseNo(title + ' ' + desc), place: hit ? hit.n + (g.t === 'fylke' || g.t === 'omr' ? '' : ', Norway') : district + ', Norway', locNote: note, detail: clip(desc, 180), located: !!hit
    };
  }).filter(Boolean);
}
async function fetchNRK() {
  const got = new Map(); let ok = 0, fail = 0;
  for (const f of NRK_FEEDS) {
    try {
      let xml = null, err;
      for (const p of f[1].split('|')) {   // some districts have moved; try each known path
        try { xml = await get(`https://www.nrk.no/${p ? p + '/' : ''}toppsaker.rss`); if (p !== f[1].split('|')[0]) console.log(`nrk ${f[0]}: using /${p}/`); break; } catch (e) { err = e; }
      }
      if (xml === null) throw err;
      for (const i of parseNRK(xml, f)) { const prev = got.get(i.id); if (!prev || (i.located && !prev.located)) got.set(i.id, i); }
      ok++;
    } catch (e) { fail++; console.warn(`nrk ${f[0]}: failed (${e.message || e})`); }
  }
  if (!ok) throw new Error('all NRK feeds failed');
  const list = [...got.values()].filter(i => now - new Date(i.time) < 4 * 864e5).sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 90);
  console.log(`nrk: ${ok} feeds ok, ${fail} failed, ${list.length} items, ${list.filter(i => i.located).length} matched to a place`);
  for (const i of list.slice(0, 12)) console.log(`  [${i.place}] ${i.title}`);
  return list.map(({located, ...i}) => i);
}

const FEEDS = [
  {id: 'usgs', name: 'USGS', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', as: 'json', parse: parseUSGS},
  {id: 'eonet', name: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10&limit=60', as: 'json', parse: parseEONET},
  {id: 'gdacs', name: 'GDACS', url: 'https://www.gdacs.org/xml/rss.xml', as: 'text', parse: parseGDACS},
  {id: 'nrk', name: 'NRK', url: 'https://www.nrk.no/rss/', run: fetchNRK},
  {id: 'unnews', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', as: 'text', parse: parseUNNews}
];

async function main() {
  const sources = [], all = [];
  for (const f of FEEDS) {
    try {
      const got = (f.run ? await f.run() : f.parse(await get(f.url, f.as))).filter(i => i.time && isFinite(i.lat) && isFinite(i.lng) && now - new Date(i.time) < MAX_AGE && new Date(i.time) <= now + 36e5);
      all.push(...got.slice(0, f.id === 'nrk' ? 90 : 50)); sources.push({id: f.id, name: f.name, url: f.url, ok: true, count: got.length});
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
