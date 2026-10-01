// Run:  TMDB_KEY=your_key node server.js     (Node 18+, no npm install needed)
// Windows PowerShell:  $env:TMDB_KEY="your_key"; node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const KEY = process.env.TMDB_KEY || '', PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'universes.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB)); } catch { return { universes: [] }; } };
const save = d => fs.writeFileSync(DB, JSON.stringify(d, null, 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' from ' + u.split('?')[0]); return r.json(); };
const T = (p, q = {}) => {
  if (!KEY) throw new Error('Set the TMDB_KEY environment variable (free key at themoviedb.org)');
  return get('https://api.themoviedb.org/3' + p + '?' + new URLSearchParams({ api_key: KEY, ...q }));
};
const J = async p => { await sleep(450); return get('https://api.jikan.moe/v4' + p); }; // Jikan rate limit

const mMovie = m => ({ id: 'tm' + m.id, n: m.title, date: m.release_date || '', k: 'Movie', s: m.overview || '' });
const mTv = m => ({ id: 'tv' + m.id, n: m.name, date: m.first_air_date || '', k: 'Series', s: m.overview || '' });
const mAni = a => ({ id: 'an' + a.mal_id, n: a.title_english || a.title, date: ((a.aired && a.aired.from) || '').slice(0, 10), k: 'Anime', s: (a.synopsis || '').slice(0, 450) });

async function search(src, q) {
  if (src == 'movie') return (await T('/search/movie', { query: q })).results.slice(0, 8).map(mMovie);
  if (src == 'tv') return (await T('/search/tv', { query: q })).results.slice(0, 8).map(mTv);
  if (src == 'anime') return (await J('/anime?limit=8&q=' + encodeURIComponent(q))).data.map(mAni);
  if (src == 'animechain') return (await J('/anime?limit=8&q=' + encodeURIComponent(q))).data.map(a => ({ ...mAni(a), id: String(a.mal_id), franchise: 1 }));
  if (src == 'collection') return (await T('/search/collection', { query: q })).results.slice(0, 8).map(c => ({ id: String(c.id), n: c.name, s: 'Movie franchise', franchise: 1 }));
  throw new Error('Unknown source');
}

// Turns a franchise source into a list of items.
async function expand(type, id) {
  if (type == 'collection') return (await T('/collection/' + id)).parts.map(mMovie);
  // animechain: walk prequel/sequel/side-story links on MyAnimeList (max 30 titles)
  const seen = new Map(), queue = [id], ok = ['Prequel', 'Sequel', 'Side story', 'Parent story', 'Spin-off'];
  while (queue.length && seen.size < 30) {
    const i = String(queue.shift()); if (seen.has(i)) continue;
    const a = (await J('/anime/' + i + '/full')).data;
    seen.set(i, mAni(a));
    for (const r of a.relations || []) if (ok.includes(r.relation))
      for (const e of r.entry) if (e.type == 'anime') queue.push(e.mal_id);
  }
  return [...seen.values()];
}

// Adds only new items; never overwrites your edits. New items chain after the last one by date.
function merge(un, items) {
  const have = new Set(un.items.map(i => i.id));
  const fresh = items.filter(i => !have.has(i.id)).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  for (const i of fresh) {
    const last = [...un.items].sort((a, b) => a.o - b.o).pop();
    un.items.push({ ...i, y: +(i.date || '0').slice(0, 4) || 0, o: last ? last.o + 1 : 1, r: last ? [last.id] : [] });
  }
}

async function refresh() { // re-checks every saved franchise for new releases
  const d = load();
  for (const un of d.universes) for (const s of un.sources || []) merge(un, await expand(s.type, s.id));
  save(d); console.log('Refreshed', new Date().toISOString());
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname == '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    if (u.pathname == '/api/data' && req.method == 'GET') return send(200, load());
    let body = ''; if (req.method == 'POST') for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    if (u.pathname == '/api/data') { save(b); return send(200, b); }
    if (u.pathname == '/api/search') return send(200, await search(u.searchParams.get('src'), u.searchParams.get('q')));
    if (u.pathname == '/api/add') {
      const d = load(), un = d.universes.find(x => x.id == b.uid);
      if (!un) throw new Error('Create or pick a universe first');
      let items = b.items || [];
      if (b.source) { items = await expand(b.source.type, b.source.id); (un.sources = un.sources || []).push(b.source); }
      merge(un, items); save(d); return send(200, d);
    }
    if (u.pathname == '/api/refresh') { await refresh(); return send(200, load()); }
    send(404, { error: 'Not found' });
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, () => console.log('Open http://localhost:' + PORT));
setInterval(() => refresh().catch(console.error), 24 * 3600e3); // auto-update once a day