/* World News Globe: first version.
   Static client: reads data/events.json (curated, sourced) and data/live.json (automated open feeds). */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY = 864e5, HOUR = 36e5, RAD = Math.PI / 180;

const CATS = {
  conflict:     {label: 'Conflict',                 color: '#ef5a5f'},
  security:     {label: 'Security',                 color: '#f7853d'},
  politics:     {label: 'Politics',                 color: '#9a98f5'},
  diplomacy:    {label: 'Diplomacy',                color: '#3dd6c5'},
  disaster:     {label: 'Disasters & accidents',    color: '#f5b83d'},
  protest:      {label: 'Protests & strikes',       color: '#e879c9'},
  climate:      {label: 'Climate & environment',    color: '#5bc98b'},
  humanitarian: {label: 'Humanitarian & migration', color: '#70b8ff'},
  other:        {label: 'Other',                    color: '#b6c0cf'}
};
const LEVELS = {confirmed: 'Confirmed', reported: 'Reported', disputed: 'Disputed', unknown: 'Unknown', automated: 'Automated feed'};
const POLITICAL = ['#f1e2b6', '#cfe3c0', '#f0cfc2', '#d9d0ea', '#c8e0e4', '#efd9e6', '#e2e6c3'];

const S = {
  T: Date.now(), tMin: Date.now() - 14 * DAY, tMax: Date.now(),
  win: 14 * DAY, playing: false, speed: 6 * HOUR, mode: 'then',
  cats: new Set(Object.keys(CATS)), cur: true, live: true,
  style: 'dark', sel: null, alt: 1.9, follow: true
};
let EVENTS = [], LIVE_META = null, GAZ = [], COUNTRIES = [];
let globe, lastKey = '', lastPolyKey = '', mv = null;

/* ---------- time formatting ---------- */
const fDate = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
const fDT = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});
const fDay = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short'});
const fUTC = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'});
const TZ = (new Intl.DateTimeFormat('en-GB', {timeZoneName: 'short'}).formatToParts(new Date()).find(p => p.type === 'timeZoneName') || {}).value || 'local';
const dt = ms => fDT.format(ms);
function eventTime(e) {
  const d = fDate.format(e.t);
  switch (e.timePrecision) {
    case 'exact': return `${dt(e.t)} ${TZ}<small>${fUTC.format(e.t)} UTC</small>`;
    case 'morning': case 'midday': case 'evening': return `${d}, ${e.timePrecision}<small>local time of day as reported; hour not established</small>`;
    case 'overnight': return `Night before ${d}<small>hour not established</small>`;
    case 'uncertain': return `Around ${d}<small>date not firmly established</small>`;
    default: return `${d}<small>time of day not established</small>`;
  }
}
const published = p => !p ? '' : (p.length <= 10 ? fDate.format(new Date(p + 'T12:00:00Z')) : `${dt(new Date(p))} ${TZ}`);

/* ---------- data ---------- */
const getJSON = (u, fallback) => fetch(u, {cache: 'no-cache'}).then(r => r.ok ? r.json() : Promise.reject(r.status)).catch(() => fallback);

function normCurated(e) {
  return {...e, t: +new Date(e.time), learned: +new Date(e.learnedAt || e.time), live: false,
          updates: (e.updates || []).map(u => ({...u, t: +new Date(u.at)})).sort((a, b) => a.t - b.t)};
}
function normLive(i) {
  const t = +new Date(i.time), p = +new Date(i.published || i.time);
  return {id: i.id, live: true, category: CATS[i.category] ? i.category : 'other', headline: i.title, place: i.place || '',
          lat: i.lat, lng: i.lng, precision: i.precision || 'exact', radiusKm: i.radiusKm,
          t, learned: Math.max(t, p), timePrecision: i.timeBasis === 'published' ? 'published' : 'exact',
          status: 'automated', summary: i.detail || '', facts: [], updates: [], src: i.src,
          sources: [{publisher: i.srcName || i.src, title: i.title, url: i.url, published: i.published}]};
}
async function usgsFallback() {
  // Public-domain USGS feed, CORS-enabled. Used only if the scheduled job has not produced fresh data.
  const j = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', null);
  if (!j || !j.features) return [];
  return j.features.filter(f => f.properties.mag >= 5.5).map(f => ({
    id: 'usgs-' + f.id, src: 'usgs', srcName: 'USGS Earthquake Hazards Program', title: f.properties.title, url: f.properties.url,
    time: new Date(f.properties.time).toISOString(), published: new Date(f.properties.time).toISOString(), timeBasis: 'event',
    lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], precision: 'exact', category: 'disaster',
    place: f.properties.place, detail: `Magnitude ${f.properties.mag} earthquake, depth ${Math.round(f.geometry.coordinates[2])} km. Automated record from USGS; values may be revised.`
  }));
}

/* ---------- visibility + versions ---------- */
function inView(e) {
  if (e.live ? !S.live : !S.cur) return false;
  if (!S.cats.has(e.category)) return false;
  const appears = S.mode === 'then' ? e.learned : e.t;
  if (appears > S.T) return false;
  if (S.win && e.t < S.T - S.win) return false;
  return true;
}
function versionOf(e) {
  let facts = (e.facts || []).slice(); const log = []; let hidden = 0;
  for (const u of e.updates) {
    if (S.mode === 'then' && u.t > S.T) { hidden++; continue; }
    if (u.replaceFacts) facts = u.replaceFacts.slice();
    if (u.facts) facts = facts.concat(u.facts);
    log.push(u);
  }
  return {facts, log, hidden};
}

/* ---------- geometry ---------- */
function vec(lat, lng) { const a = lat * RAD, b = lng * RAD; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; }
function ang(a, b) { const u = vec(a.lat, a.lng), v = vec(b.lat, b.lng); return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))); }
function slerp(a, b, t) {
  const u = vec(a.lat, a.lng), v = vec(b.lat, b.lng), w = ang(a, b);
  if (w < 1e-6) return {lat: a.lat, lng: a.lng};
  const s = Math.sin(w), k1 = Math.sin((1 - t) * w) / s, k2 = Math.sin(t * w) / s;
  const x = k1 * u[0] + k2 * v[0], y = k1 * u[1] + k2 * v[1], z = k1 * u[2] + k2 * v[2];
  return {lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lng: Math.atan2(y, x) / RAD};
}
function circle(lat, lng, km) {
  // Ring wound clockwise (d3-geo spherical convention) so the polygon is the small cap, not its complement.
  const d = km / 6371, la = lat * RAD, lo = lng * RAD, ring = [];
  for (let b = 0; b <= 360; b += 12) {
    const br = b * RAD;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    ring.push([lo2 / RAD, la2 / RAD]);
  }
  return {type: 'Polygon', coordinates: [ring]};
}
function clusters(list) {
  const thr = Math.min(28, Math.max(0.35, S.alt * 5)) * RAD, out = [];
  const sorted = list.slice().sort((a, b) => (a.live - b.live) || (b.t - a.t));
  for (const e of sorted) {
    if (e.id === S.sel) { out.push({lat: e.lat, lng: e.lng, items: [e], pinned: true}); continue; }
    const c = out.find(c => !c.pinned && ang(c, e) < thr);
    if (c) { c.items.push(e); const n = c.items.length; c.lat += (e.lat - c.lat) / n; c.lng += (e.lng - c.lng) / n; }
    else out.push({lat: e.lat, lng: e.lng, items: [e]});
  }
  return out;
}

/* ---------- globe ---------- */
function initGlobe() {
  const el = $('#globe');
  globe = new Globe(el, {animateIn: false})
    .backgroundColor('#05070b')
    .showAtmosphere(true).atmosphereColor('#5f8fd6').atmosphereAltitude(0.13)
    .polygonGeoJsonGeometry(d => d.geometry)
    .polygonCapColor(capColor).polygonSideColor(() => 'rgba(0,0,0,0)').polygonStrokeColor(strokeColor)
    .polygonAltitude(d => d.kind === 'area' ? 0.009 : 0.005)
    .polygonLabel(d => d.kind === 'area' ? `<div class="mk"><span class="lab" style="display:block;position:static;transform:none">Approximate area · ${esc(d.ev.place)}</span></div>` : '')
    .polygonsTransitionDuration(0)
    .onPolygonClick(d => { if (d.kind === 'area') select(d.ev.id); else select(null); })
    .onGlobeClick(() => select(null))
    .htmlLat('lat').htmlLng('lng').htmlAltitude(0.012).htmlElement(markerEl).htmlTransitionDuration(0)
    .ringLat('lat').ringLng('lng').ringColor(() => t => `rgba(255,255,255,${0.55 * (1 - t)})`)
    .ringMaxRadius(d => d.r).ringPropagationSpeed(1).ringRepeatPeriod(1800)
    .pathPoints('pts').pathPointLat(p => p[0]).pathPointLng(p => p[1]).pathPointAlt(p => p[2])
    .pathColor(() => 'rgba(61,214,197,0.95)').pathStroke(1.4)
    .pathDashLength(0.035).pathDashGap(0.02).pathDashAnimateTime(7000).pathTransitionDuration(0)
    .onZoom(pov => {
      if (Math.abs(pov.altitude - S.alt) / S.alt > 0.06) { S.alt = pov.altitude; schedule(); }
    });
  if (typeof globe.htmlElementVisibilityModifier === 'function')
    globe.htmlElementVisibilityModifier((el, vis) => { el.style.opacity = vis ? 1 : 0; el.style.pointerEvents = vis ? 'auto' : 'none'; });
  const c = globe.controls();
  c.autoRotate = false; c.enableDamping = true; c.minDistance = 103; c.maxDistance = 520; c.zoomSpeed = 0.9; c.rotateSpeed = 0.7;
  globe.pointOfView({lat: 28, lng: 28, altitude: S.alt}, 0);
  const fit = () => { const r = $('#stage').getBoundingClientRect(); globe.width(r.width).height(r.height); };
  new ResizeObserver(fit).observe($('#stage')); fit();
  applyStyle();
}
function capColor(d) {
  if (d.kind === 'area') { const c = CATS[d.ev.category].color; return c + (d.ev.id === S.sel ? '55' : '2e'); }
  if (S.style === 'political') return POLITICAL[d.i % POLITICAL.length];
  if (S.style === 'satellite') return 'rgba(0,0,0,0)';
  return '#172131';
}
function strokeColor(d) {
  if (d.kind === 'area') return CATS[d.ev.category].color;
  return S.style === 'political' ? '#66768f' : S.style === 'satellite' ? 'rgba(255,255,255,0.32)' : '#3a4a66';
}
function applyStyle() {
  const m = globe.globeMaterial();
  if (S.style === 'satellite') {
    globe.globeImageUrl('vendor/earth-blue-marble.jpg').bumpImageUrl('vendor/earth-topology.png'); m.color.set('#ffffff');
  } else {
    globe.globeImageUrl(null).bumpImageUrl(null); m.map = null; m.bumpMap = null;
    m.color.set(S.style === 'political' ? '#8fbbe3' : '#0a1220');
  }
  m.needsUpdate = true;
  const n = $('#mapNote');
  n.hidden = S.style !== 'satellite';
  n.textContent = 'Satellite view is a static background composite (NASA Blue Marble). It does not show conditions on the selected date.';
  document.querySelectorAll('#styleSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.style));
  lastPolyKey = ''; schedule();
}
function markerEl(c) {
  const el = document.createElement('button');
  el.type = 'button';
  if (c.items.length > 1) {
    el.className = 'mk cluster';
    const cur = c.items.filter(e => !e.live).length;
    el.innerHTML = `<span class="pin">${c.items.length}</span><span class="lab">${cur ? cur + ' curated' : ''}${cur && cur < c.items.length ? ' · ' : ''}${cur < c.items.length ? (c.items.length - cur) + ' live' : ''} · zoom in</span>`;
    el.setAttribute('aria-label', `${c.items.length} events, zoom in`);
    el.onclick = ev => { ev.stopPropagation(); S.follow = true; globe.pointOfView({lat: c.lat, lng: c.lng, altitude: Math.max(0.12, S.alt * 0.45)}, 700); };
  } else {
    const e = c.items[0];
    el.className = 'mk' + (e.live ? ' live' : '') + (!e.live && e.precision !== 'exact' && e.precision !== 'city' ? ' area' : '') + (e.id === S.sel ? ' sel' : '');
    el.style.setProperty('--c', CATS[e.category].color);
    el.innerHTML = `<span class="pin"></span><span class="lab">${esc(e.headline)}</span>`;
    el.setAttribute('aria-label', e.headline);
    el.onclick = ev => { ev.stopPropagation(); select(e.id); };
  }
  el.style.pointerEvents = 'auto';
  return el;
}

/* ---------- refresh ---------- */
let pending = false;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; refresh(); }); } }
function refresh() {
  if (!globe) return;
  const vis = EVENTS.filter(inView);
  const cl = clusters(vis);
  const key = S.sel + '|' + cl.map(c => c.items.map(e => e.id).join(',')).join(';');
  if (key !== lastKey) { lastKey = key; globe.htmlElementsData(cl); }

  const areas = vis.filter(e => !e.live && e.radiusKm && (e.id === S.sel || S.alt < 1.3));
  const pkey = S.style + '|' + S.sel + '|' + areas.map(e => e.id).join(',');
  if (pkey !== lastPolyKey) {
    lastPolyKey = pkey;
    globe.polygonsData(COUNTRIES.concat(areas.map(e => ({kind: 'area', ev: e, geometry: circle(e.lat, e.lng, e.radiusKm)}))));
  }
  renderTimeline(); renderCounts(vis); renderPanel(vis); renderMode();
}

/* ---------- selection + movement ---------- */
function select(id, fly = true) {
  if (S.sel === id) return;
  S.sel = id;
  const e = EVENTS.find(x => x.id === id);
  stopMovement();
  if (e) {
    document.body.classList.add('story');
    globe.ringsData([{lat: e.lat, lng: e.lng, r: e.radiusKm ? Math.max(2, e.radiusKm / 60) : 2.5}]);
    if (e.movement) startMovement(e);
    else if (fly) globe.pointOfView({lat: e.lat, lng: e.lng, altitude: Math.min(S.alt, e.radiusKm > 150 ? 1.1 : 0.75)}, 900);
  } else { globe.ringsData([]); document.body.classList.remove('story'); }
  lastKey = ''; schedule();
}
function startMovement(e) {
  const legs = e.movement.legs.map(l => {
    const w = ang(l.from, l.to), h = Math.max(0.03, Math.min(0.42, w / Math.PI * 0.9)), pts = [];
    for (let i = 0; i <= 80; i++) { const t = i / 80, p = slerp(l.from, l.to, t); pts.push([p.lat, p.lng, h * Math.sin(Math.PI * t) + 0.004]); }
    return {pts, from: l.from};
  });
  globe.pathsData(legs);
  const ov = $('#overlay'); ov.innerHTML = '';
  const syms = legs.map(l => {
    const s = document.createElement('div'); s.className = 'mv sym' + (e.movement.type === 'drone' ? ' drone' : ''); ov.appendChild(s);
    const n = document.createElement('div'); n.className = 'mv name'; n.textContent = l.from.name; ov.appendChild(n);
    return {s, n, l};
  });
  $('#schematic').hidden = false;
  // frame the whole movement
  const all = e.movement.legs.flatMap(l => [l.from, l.to]);
  const far = Math.max(...all.map(p => ang(p, e)));
  globe.pointOfView({lat: e.lat + 8, lng: e.lng - 18, altitude: Math.max(1.3, Math.min(2.6, far * 1.9))}, 1000);
  const t0 = performance.now(), R = globe.getGlobeRadius();
  const place = (el, lat, lng, alt) => {
    const p = globe.getCoords(lat, lng, alt), c = globe.camera().position;
    const front = p.x * c.x + p.y * c.y + p.z * c.z > R * R * 0.98;
    if (!front) { el.style.display = 'none'; return; }
    const sc = globe.getScreenCoords(lat, lng, alt);
    el.style.display = ''; el.style.left = sc.x + 'px'; el.style.top = sc.y + 'px';
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  mv = {raf: 0};
  const tick = now => {
    const cyc = (Math.max(0, now - t0) % 6500) / 5000, t = reduce ? 1 : Math.min(1, cyc), k = Math.min(80, Math.floor(t * 80));
    for (const {s, n, l} of syms) {
      const a = l.pts[k], b = l.pts[Math.min(80, k + 1)], f = t * 80 - k;
      place(s, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      place(n, l.from.lat, l.from.lng, 0.01);
    }
    mv.raf = requestAnimationFrame(tick);
  };
  mv.raf = requestAnimationFrame(tick);
}
function stopMovement() {
  if (mv) cancelAnimationFrame(mv.raf); mv = null;
  if (globe) globe.pathsData([]);
  $('#overlay').innerHTML = ''; $('#schematic').hidden = true;
}

/* ---------- panel ---------- */
function renderPanel(vis) {
  const e = EVENTS.find(x => x.id === S.sel), p = $('#panel');
  if (!e) return renderList(vis);
  const cat = CATS[e.category], v = versionOf(e), shown = vis.includes(e);
  const approx = !e.live && e.precision !== 'exact' && e.precision !== 'city';
  let h = `<div class="p-top" style="--c:${cat.color}"><span class="p-cat">${esc(cat.label)}</span>
    <span class="lv ${e.status}">${LEVELS[e.status] || e.status}</span><button class="p-close" aria-label="Close story">×</button></div>
    <h1>${esc(e.headline)}</h1>`;
  if (!shown) h += `<div class="note warn">This story is outside the selected time or filters, so it is not on the map right now.</div>`;
  if (e.live) h += `<div class="note">Automated item from ${esc(e.sources[0].publisher)}. It has not been editorially reviewed.${e.timePrecision === 'published' ? ' The location is inferred from the text and placed at country level.' : ''}</div>`;
  h += `<dl class="kv">
    <dt>Where</dt><dd>${esc(e.place) || '—'}${approx ? `<small>Approximate area${e.radiusKm ? `, drawn about ${e.radiusKm} km across the centre` : ''}; not a precise point</small>` : e.precision === 'city' ? '<small>Located to the town or city</small>' : ''}</dd>
    <dt>Event time</dt><dd>${e.timePrecision === 'published' ? 'Not established<small>placed on the timeline at publication time</small>' : eventTime(e)}</dd>
    <dt>${e.live ? 'Published' : 'First reported'}</dt><dd>${dt(e.learned)} ${TZ}${!e.live ? '<small>when this compilation first has reporting; may be approximate</small>' : ''}</dd></dl>`;
  if (e.summary) h += `<p class="sum">${esc(e.summary)}</p>`;
  if (e.movement) h += `<div class="note teal"><b>${esc(e.movement.label)}.</b> ${esc(e.movement.note)}</div>`;
  if (v.facts.length) {
    h += `<h2>What is known${S.mode === 'then' && S.T < S.tMax - 6e4 ? ' at this point' : ''}</h2><ul class="facts">` +
      v.facts.map(f => `<li><span class="lv ${f.level}">${LEVELS[f.level]}</span>${esc(f.text)}${f.by ? `<span class="by">${esc(f.by)}</span>` : ''}</li>`).join('') + '</ul>';
  }
  if (v.log.length || v.hidden) {
    h += `<h2>How the story developed</h2><ul class="log">` +
      v.log.map(u => `<li><time>${dt(u.t)} ${TZ}</time>${esc(u.text)}${u.by ? ` <span class="by" style="color:var(--mute);font-size:11.5px">${esc(u.by)}</span>` : ''}</li>`).join('') + '</ul>';
    if (v.hidden) h += `<div class="note warn">${v.hidden} later update${v.hidden > 1 ? 's are' : ' is'} hidden because you are viewing the story as reported at ${dt(S.T)}. Switch to Retrospective to include them.</div>`;
  }
  if (e.people && e.people.length) {
    h += `<h2>People involved</h2><div class="people">` + e.people.map(q =>
      `<div class="person"><div class="avatar" title="Illustrative placeholder, not a photograph">${esc(q.name.split(/\s+/).map(w => w[0]).slice(0, 2).join(''))}</div><div><b>${esc(q.name)}</b><span>${esc(q.role)}</span></div></div>`).join('') +
      `</div><p class="fine">Initials are illustrative placeholders. No photographs are used in this version.</p>`;
  }
  const pubT = s => !s.published ? -Infinity : +new Date(s.published.length <= 10 ? s.published + 'T00:00:00Z' : s.published);
  const srcs = S.mode === 'then' ? e.sources.filter(s => pubT(s) <= S.T) : e.sources, later = e.sources.length - srcs.length;
  h += `<h2>Sources</h2><ul class="src">` + srcs.map(s =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span class="pub">${esc(s.publisher)}${s.published ? ' · published ' + published(s.published) : ''}</span></li>`).join('') + '</ul>';
  if (later) h += `<p class="fine">${later} source${later > 1 ? 's' : ''} published after ${dt(S.T)} ${later > 1 ? 'are' : 'is'} hidden in this view.</p>`;
  if (!e.live) h += `<p class="fine">Images are not reproduced here. Follow the source links for photographs and full reporting.</p>`;
  const rel = (e.related || []).map(id => EVENTS.find(x => x.id === id)).filter(Boolean);
  if (rel.length) h += `<h2>Related events</h2><ul class="rel">` + rel.map(r => `<li data-id="${esc(r.id)}">${esc(r.headline)}</li>`).join('') + '</ul>';
  if (p._html !== h) { p._html = h; p.innerHTML = h; }
}
function renderList(vis) {
  const p = $('#panel'), list = vis.slice().sort((a, b) => (a.live - b.live) || (b.t - a.t)).slice(0, 60);
  let h = `<h2 style="margin-top:4px">In view · ${vis.length} event${vis.length === 1 ? '' : 's'}</h2>`;
  if (!list.length) h += `<p class="empty">Nothing is shown for this time and these filters. Move the timeline, widen “Showing”, or switch topics back on.</p>`;
  h += `<ul class="evlist">` + list.map(e => `<li data-id="${esc(e.id)}" style="--c:${CATS[e.category].color}">
      <div class="meta"><i class="${e.live ? 'live' : ''}"></i>${fDay.format(e.t)} · ${esc(e.live ? 'Live feed' : CATS[e.category].label)}</div>${esc(e.headline)}</li>`).join('') + '</ul>';
  if (p._html !== h) { p._html = h; p.innerHTML = h; }
}
$('#panel').addEventListener('click', ev => {
  if (ev.target.closest('.p-close')) return select(null);
  const li = ev.target.closest('[data-id]'); if (li) select(li.dataset.id);
});

/* ---------- left panel ---------- */
function buildCats() {
  $('#cats').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<label class="cat" data-k="${k}" style="--c:${c.color}"><input type="checkbox" checked><span class="sw"></span>${c.label}<em></em></label>`).join('');
  $('#cats').addEventListener('change', ev => {
    const l = ev.target.closest('.cat'); if (!l) return;
    ev.target.checked ? S.cats.add(l.dataset.k) : S.cats.delete(l.dataset.k); l.classList.toggle('off', !ev.target.checked); schedule();
  });
  const setAll = on => { S.cats = new Set(on ? Object.keys(CATS) : []); document.querySelectorAll('.cat').forEach(l => { l.querySelector('input').checked = on; l.classList.toggle('off', !on); }); schedule(); };
  $('#catAll').onclick = () => setAll(true); $('#catNone').onclick = () => setAll(false);
  $('#lyCurated').onchange = e => { S.cur = e.target.checked; schedule(); };
  $('#lyLive').onchange = e => { S.live = e.target.checked; schedule(); };
}
function renderCounts(vis) {
  const n = {}; for (const e of vis) n[e.category] = (n[e.category] || 0) + 1;
  document.querySelectorAll('.cat').forEach(l => { l.querySelector('em').textContent = n[l.dataset.k] || ''; });
  $('#nCur').textContent = vis.filter(e => !e.live).length; $('#nLive').textContent = vis.filter(e => e.live).length;
}
function buildSearch() {
  const q = $('#q'), box = $('#qres'); let res = [], act = -1;
  const run = () => {
    const s = q.value.trim().toLowerCase(); act = -1;
    if (s.length < 2) { box.hidden = true; return; }
    const places = GAZ.filter(g => [g.n, ...(g.a || [])].some(n => n.toLowerCase().includes(s)))
      .sort((a, b) => (b.n.toLowerCase().startsWith(s) - a.n.toLowerCase().startsWith(s)) || a.n.length - b.n.length).slice(0, 6)
      .map(g => ({kind: 'place', label: g.n, sub: g.t, g}));
    const evs = EVENTS.filter(e => !e.live && (e.headline + ' ' + e.place).toLowerCase().includes(s)).slice(0, 5).map(e => ({kind: 'event', label: e.headline, sub: 'story', e}));
    res = evs.concat(places);
    box.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}">${esc(r.label)}<small>${esc(r.sub)}</small></li>`).join('') : '<li>No match</li>';
    box.hidden = false;
  };
  const go = r => {
    if (!r) return; box.hidden = true; q.blur(); document.body.classList.remove('menu');
    if (r.kind === 'event') { if (!inView(r.e)) { S.follow = false; setT(Math.min(S.tMax, r.e.learned + HOUR)); } select(r.e.id); }
    else { select(null); globe.pointOfView({lat: r.g.lat, lng: r.g.lng, altitude: r.g.t === 'city' ? 0.35 : r.g.t === 'place' ? 0.6 : 0.9}, 900); }
  };
  q.addEventListener('input', run);
  q.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); act = (act + (ev.key === 'ArrowDown' ? 1 : -1) + res.length) % Math.max(1, res.length); [...box.children].forEach((li, i) => li.classList.toggle('act', i === act)); }
    else if (ev.key === 'Enter') go(res[Math.max(0, act)]);
    else if (ev.key === 'Escape') box.hidden = true;
  });
  box.addEventListener('mousedown', ev => { const li = ev.target.closest('[data-i]'); if (li) go(res[+li.dataset.i]); });
  q.addEventListener('blur', () => setTimeout(() => box.hidden = true, 150));
}

/* ---------- timeline ---------- */
const isLive = () => S.T >= S.tMax - 9e4;
function setT(t) { S.T = Math.max(S.tMin, Math.min(S.tMax, t)); S.follow = isLive(); schedule(); }
function renderMode() {
  const m = $('#mode'), live = isLive();
  m.className = 'mode ' + (live ? 'live' : 'past');
  $('#modeText').textContent = live ? 'Live · current news' :
    `Historical playback · ${dt(S.T)} · ${S.mode === 'then' ? 'as reported then' : 'with later corrections'}`;
  $('#goLive').classList.toggle('on', live);
  document.querySelectorAll('#knowSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.mode));
}
function buildTimeline() {
  const span = S.tMax - S.tMin, pos = t => ((t - S.tMin) / span * 100).toFixed(3) + '%';
  $('#ticks').innerHTML = EVENTS.filter(e => e.t >= S.tMin).map(e =>
    `<i data-id="${esc(e.id)}" class="${e.live ? 'live' : ''}" style="left:${pos(e.t)};--c:${CATS[e.category].color}"></i>`).join('');
  const days = []; const d0 = new Date(S.tMin); d0.setHours(0, 0, 0, 0);
  const nd = Math.ceil(span / DAY), every = Math.max(1, Math.ceil(nd / (innerWidth < 860 ? 6 : 14)));
  for (let d = +d0, i = 0; d < S.tMax; d += DAY, i++) if (d >= S.tMin && i % every === 0) days.push(`<span style="left:${pos(d)}">${fDay.format(d)}</span>`);
  $('#days').innerHTML = days.join('');
}
function renderTimeline() {
  const span = S.tMax - S.tMin, p = (S.T - S.tMin) / span;
  const sc = $('#scrub'); if (document.activeElement !== sc || !sc._drag) sc.value = Math.round(p * 1000);
  sc.style.setProperty('--p', (p * 100).toFixed(2) + '%');
  $('#clock').innerHTML = `${dt(S.T)} <small>${TZ}</small>`;
  const d = new Date(S.T), iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (document.activeElement !== $('#date')) $('#date').value = iso;
  $('#play').textContent = S.playing ? '❚❚' : '▶'; $('#play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  const ids = new Set(EVENTS.filter(inView).map(e => e.id));
  document.querySelectorAll('#ticks i').forEach(i => i.classList.toggle('dim', !ids.has(i.dataset.id)));
}
function bindTimeline() {
  const sc = $('#scrub');
  sc.addEventListener('input', () => { sc._drag = true; pause(); setT(S.tMin + sc.value / 1000 * (S.tMax - S.tMin)); });
  sc.addEventListener('change', () => { sc._drag = false; });
  $('#stepBack').onclick = () => { pause(); setT(S.T - HOUR); };
  $('#stepFwd').onclick = () => { pause(); setT(S.T + HOUR); };
  $('#goLive').onclick = () => { pause(); S.tMax = Date.now(); setT(S.tMax); };
  $('#speed').onchange = e => { S.speed = +e.target.value; };
  $('#win').onchange = e => { S.win = +e.target.value; schedule(); };
  $('#date').onchange = e => { if (!e.target.value) return; pause(); const d = new Date(e.target.value + 'T00:00:00'); setT(+d + 8 * HOUR); };
  $('#play').onclick = () => S.playing ? pause() : play();
  document.addEventListener('keydown', ev => {
    if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.code === 'Space') { ev.preventDefault(); S.playing ? pause() : play(); }
    if (ev.key === 'Escape') select(null);
  });
  document.querySelectorAll('#knowSeg button').forEach(b => b.onclick = () => { S.mode = b.dataset.v; schedule(); });
  document.querySelectorAll('#styleSeg button').forEach(b => b.onclick = () => { S.style = b.dataset.v; applyStyle(); });
  $('#menuBtn').onclick = () => { const on = document.body.classList.toggle('menu'); $('#menuBtn').setAttribute('aria-expanded', on); };
  $('#stage').addEventListener('pointerdown', () => { document.body.classList.remove('menu'); if (!S.sel) document.body.classList.remove('story'); });
  // On small screens the story panel is a bottom sheet: tapping its visible edge opens it.
  $('#right').addEventListener('click', ev => { if (matchMedia('(max-width:860px)').matches && !document.body.classList.contains('story')) { ev.stopPropagation(); document.body.classList.add('story'); } }, true);
}
let playRaf = 0, playLast = 0;
function play() {
  if (isLive()) { const first = Math.min(...EVENTS.filter(e => !e.live).map(e => e.learned)); S.T = Math.max(S.tMin, (isFinite(first) ? first : S.tMin) - 3 * HOUR); }
  S.playing = true; S.follow = false; playLast = performance.now();
  const step = now => {
    if (!S.playing) return;
    S.T += (now - playLast) / 1000 * S.speed; playLast = now;
    if (S.T >= S.tMax) { S.T = S.tMax; S.playing = false; S.follow = true; }
    schedule(); if (S.playing) playRaf = requestAnimationFrame(step);
  };
  playRaf = requestAnimationFrame(step); schedule();
}
function pause() { if (S.playing) { S.playing = false; cancelAnimationFrame(playRaf); schedule(); } }

/* ---------- boot ---------- */
async function boot() {
  buildCats(); bindTimeline(); buildSearch();
  const [cur, live, gaz, topo] = await Promise.all([
    getJSON('data/events.json', {events: []}), getJSON('data/live.json', {items: []}),
    getJSON('data/gazetteer.json', []), getJSON('vendor/countries-110m.json', null)]);
  GAZ = gaz; LIVE_META = live;
  if (topo) COUNTRIES = topojson.feature(topo, topo.objects.countries).features.map((f, i) => ({kind: 'country', i, name: f.properties.name, geometry: f.geometry}));
  let liveItems = live.items || [];
  const stale = !live.generated || Date.now() - new Date(live.generated) > 3 * HOUR;
  EVENTS = (cur.events || []).map(normCurated).concat(liveItems.map(normLive));
  const now = Date.now(), first = Math.min(now - 10 * DAY, ...EVENTS.map(e => e.t));
  const d0 = new Date(first); d0.setHours(0, 0, 0, 0);
  S.tMin = +d0; S.tMax = now; S.T = now;
  try { initGlobe(); } catch (err) { $('#loading').textContent = 'This browser could not start WebGL, which the globe needs.'; console.error(err); return; }
  $('#loading').remove();
  // If the curated set has aged out of the default window, widen the window instead of showing an empty globe.
  if (!EVENTS.some(inView) && EVENTS.length) { S.win = 0; $('#win').value = '0'; }
  buildTimeline(); liveInfo(); refresh();
  addEventListener('resize', buildTimeline);
  setInterval(() => { S.tMax = Date.now(); if (S.follow && !S.playing) S.T = S.tMax; schedule(); }, 30000);
  if (stale) usgsFallback().then(items => {
    const have = new Set(EVENTS.map(e => e.id)), add = items.filter(i => !have.has(i.id)).map(normLive);
    if (!add.length) return;
    EVENTS = EVENTS.concat(add); LIVE_META = {...LIVE_META, direct: true}; buildTimeline(); liveInfo(); lastKey = ''; schedule();
  });
}
function liveInfo() {
  const m = LIVE_META || {}, n = EVENTS.filter(e => e.live).length;
  const names = (m.sources || []).filter(s => s.ok).map(s => s.name);
  $('#liveInfo').textContent = m.generated
    ? `${n} items. Feeds refreshed ${dt(new Date(m.generated))} ${TZ}${names.length ? ' from ' + names.join(', ') : ''}.${m.direct ? ' Earthquakes loaded directly from USGS.' : ''}`
    : (m.direct ? `${n} items loaded directly from USGS. The scheduled feed job has not run yet.` : 'The scheduled feed job has not run yet.');
}
boot();
})();
