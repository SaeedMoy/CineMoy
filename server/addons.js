// Stremio addon protocol clients: Cinemeta (catalog/meta) and Torrentio (streams).
const CINEMETA = 'https://v3-cinemeta.strem.io';
export const DEFAULT_TORRENTIO = 'https://torrentio.strem.fun/sort=qualityseeders|qualityfilter=cam,scr,unknown';

const cache = new Map();
async function getJson(url, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.data;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    if (hit) return hit.data; // flaky link: an older answer beats an error
    throw e;
  }
  cache.set(url, { data, exp: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

// Filtered/VPN links drop connections at random (ECONNRESET, TLS resets): retry a few times.
async function fetchJson(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'CineMoy/0.1' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
      const err = new Error(`${res.status} from ${new URL(url).host}`);
      if (res.status < 500 || i >= attempts) throw Object.assign(err, { final: true });
      throw err;
    } catch (e) {
      if (e.final || i >= attempts) throw e;
      await new Promise(r => setTimeout(r, 800 * i));
    }
  }
}

const enc = encodeURIComponent;

// list: 'top' (popular, optional genre) or 'year' (genre = a year, e.g. 2026).
export async function catalog({ type = 'movie', list = 'top', q, genre, skip }) {
  if (!['top', 'year'].includes(list)) list = 'top';
  if (list === 'year' && !genre) genre = String(new Date().getFullYear());
  const extras = [];
  if (q) extras.push(`search=${enc(q)}`);
  if (genre) extras.push(`genre=${enc(genre)}`);
  if (skip) extras.push(`skip=${Number(skip) || 0}`);
  const url = `${CINEMETA}/catalog/${type}/${list}${extras.length ? '/' + extras.join('&') : ''}.json`;
  const { metas = [] } = await getJson(url);
  return metas.map(m => ({
    id: m.imdb_id || m.id, type: m.type || type, name: m.name, poster: m.poster,
    background: m.background, logo: m.logo,
    year: m.releaseInfo || m.year, rating: m.imdbRating, runtime: m.runtime,
    genres: (m.genres || m.genre || []).slice(0, 3),
    description: m.description ? m.description.slice(0, 400) : '',
  }));
}

export async function meta(type, id) {
  const { meta: m } = await getJson(`${CINEMETA}/meta/${type}/${enc(id)}.json`, 6 * 3600 * 1000);
  if (!m) throw new Error('Not found');
  return {
    id: m.imdb_id || m.id, type, name: m.name, description: m.description,
    poster: m.poster, background: m.background, logo: m.logo,
    year: m.releaseInfo || m.year, runtime: m.runtime, rating: m.imdbRating,
    genres: m.genres || m.genre || [], cast: m.cast || [],
    videos: (m.videos || [])
      .filter(v => v.season > 0)
      .map(v => ({ id: v.id, season: v.season, episode: v.episode || v.number, title: v.name || v.title, released: v.released, thumbnail: v.thumbnail }))
      .sort((a, b) => a.season - b.season || a.episode - b.episode),
  };
}

// Accepts "stremio://host/cfg/manifest.json", "https://host/cfg/manifest.json" or a bare base URL.
export function normalizeAddonBase(input) {
  let s = (input || '').trim();
  if (!s) return DEFAULT_TORRENTIO;
  s = s.replace(/^stremio:\/\//i, 'https://').replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function parseTitle(title = '') {
  const seeders = Number((title.match(/👤\s*(\d+)/) || [])[1] || 0);
  const size = (title.match(/💾\s*([\d.]+\s*[KMGT]B)/i) || [])[1] || '';
  const source = (title.match(/⚙️\s*([^\n]+)/) || [])[1]?.trim() || '';
  const firstLine = title.split('\n')[0];
  return { seeders, size, source, release: firstLine };
}

export async function streams(type, id, addon) {
  const base = normalizeAddonBase(addon);
  const { streams: list = [] } = await getJson(`${base}/stream/${type}/${enc(id)}.json`, 30 * 60 * 1000);
  return list.map(s => {
    const info = parseTitle(s.title || s.description);
    return {
      name: (s.name || '').replace(/\n/g, ' '),
      quality: (s.name || '').split('\n').slice(1).join(' ').trim(),
      ...info,
      filename: s.behaviorHints?.filename,
      bingeGroup: s.behaviorHints?.bingeGroup,
      infoHash: s.infoHash,
      fileIdx: s.fileIdx,
      url: s.url, // present when a debrid service is configured in Torrentio
      trackers: (s.sources || []).filter(x => x.startsWith('tracker:')).map(x => x.slice(8)),
    };
  }).filter(s => s.infoHash || s.url);
}
