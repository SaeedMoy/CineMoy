// CineMoy web client — no build step, so it runs as-is in Electron, browsers and TV web runtimes.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtSpeed = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s');

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('pp.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pp.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const DEFAULTS = { apiBase: '', torrentio: '', subdlKey: '', subLangs: 'fa,en', subAddons: '', subSize: 34, autoSub: true, quality: '1080p' };
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let serverConfig = { ffmpeg: false, defaults: {} };

const api = p => (settings.apiBase || '').replace(/\/+$/, '') + p;
async function getJSON(p) {
  const r = await fetch(api(p));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- progress (continue watching)
const progress = {
  all: () => store.get('progress', {}),
  get: id => progress.all()[id],
  save(entry) {
    const all = progress.all();
    if (entry.dur && entry.pos / entry.dur > 0.93) delete all[entry.id];
    else all[entry.id] = { ...entry, updated: Date.now() };
    store.set('progress', all);
  },
};

// ---------------------------------------------------------------- views
const view = $('#view');
const YEAR = new Date().getFullYear();

const stars = r => {
  const n = Math.round((Number(r) || 0) / 2);
  return r ? `<span class="stars" aria-label="Rated ${esc(r)} of 10">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span> ${esc(r)}` : '';
};
const runtimeText = r => (r && /^\d+$/.test(String(r)) ? `${r} min` : r || '');
const metaLine = m => [stars(m.rating), m.year && esc(m.year), runtimeText(m.runtime) && esc(runtimeText(m.runtime)), (m.genres || []).slice(0, 3).map(esc).join(' · ')]
  .filter(Boolean).map(x => `<span>${x}</span>`).join('');
const titleHref = (m, videoId) => `#/title/${m.type}/${encodeURIComponent(m.id)}${videoId ? '/' + encodeURIComponent(videoId) : ''}`;

// A shelf is { title, load() → items, href }. list: 'top' (popular) or 'year' (new this year).
const cinemeta = (title, type, { list = 'top', genre = '' } = {}) => ({
  title,
  load: () => getJSON(`/api/catalog?type=${type}&list=${list}&genre=${encodeURIComponent(genre)}`),
  href: `#/browse/${type}/${list}/${encodeURIComponent(genre)}`,
});

const genreShelves = (type, genres) => genres.map(g => cinemeta(g, type, { genre: g }));
const SHELVES = {
  home: [
    cinemeta('Popular movies', 'movie'),
    cinemeta('Popular series', 'series'),
    cinemeta(`New movies of ${YEAR}`, 'movie', { list: 'year' }),
    cinemeta(`New series of ${YEAR}`, 'series', { list: 'year' }),
    cinemeta('Action', 'movie', { genre: 'Action' }),
    cinemeta('Crime series', 'series', { genre: 'Crime' }),
    cinemeta('Comedy', 'movie', { genre: 'Comedy' }),
    cinemeta('Sci-Fi', 'movie', { genre: 'Sci-Fi' }),
    cinemeta('Animation', 'movie', { genre: 'Animation' }),
  ],
  movie: [
    cinemeta('Popular', 'movie'), cinemeta(`New in ${YEAR}`, 'movie', { list: 'year' }),
    ...genreShelves('movie', ['Action', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi', 'Horror', 'Romance', 'Animation', 'Documentary']),
  ],
  series: [
    cinemeta('Popular', 'series'), cinemeta(`New in ${YEAR}`, 'series', { list: 'year' }),
    ...genreShelves('series', ['Drama', 'Crime', 'Comedy', 'Sci-Fi', 'Thriller', 'Mystery', 'Animation', 'Documentary']),
  ],
};

function setTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
}

// Landscape tile (rows). `key` lets focus/hover update the hero banner.
const heroItems = new Map();
function tile(m, prog) {
  const key = `${m.type}:${m.id}`;
  heroItems.set(key, m);
  const pct = prog?.dur ? Math.min(100, (prog.pos / prog.dur) * 100) : 0;
  const img = m.background || m.poster;
  return `<a class="tile focusable" tabindex="0" href="${titleHref(m, prog?.videoId)}" data-key="${esc(key)}">
    <div class="tile-art">${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="tile-cap"><span>${esc(m.name)}</span>${prog?.season ? `<small>S${prog.season} · E${prog.episode}</small>` : ''}</div>
    ${pct ? `<div class="tile-prog"><i style="width:${pct}%"></i></div>` : ''}
  </a>`;
}

// Portrait poster (grids).
function poster(m) {
  heroItems.set(`${m.type}:${m.id}`, m);
  return `<a class="poster-card focusable" tabindex="0" href="${titleHref(m)}">
    <div class="poster-art">${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy">` : ''}</div>
    <div class="poster-name">${esc(m.name)}</div>
    <div class="poster-sub">${esc(m.year || '')}${m.rating ? ` · ★ ${esc(m.rating)}` : ''}</div>
  </a>`;
}
const skeletonRow = n => Array.from({ length: n }, () => '<div class="tile skeleton"></div>').join('');
const skeletonGrid = n => `<div class="grid">${Array.from({ length: n }, () => '<div class="poster-art skeleton"></div>').join('')}</div>`;

// ---- hero banner (crossfades between two layers)
let heroLayer = 0, heroTimer, heroKey;
function setHero(m, immediate) {
  const hero = $('#hero');
  if (!hero || !m) return;
  const key = `${m.type}:${m.id}`;
  if (key === heroKey) return;
  clearTimeout(heroTimer);
  heroTimer = setTimeout(() => {
    heroKey = key;
    const layers = hero.querySelectorAll('.hero-bg');
    heroLayer ^= 1;
    const next = layers[heroLayer], prev = layers[heroLayer ^ 1];
    const src = m.background || m.poster || '';
    const show = () => { next.classList.add('on'); prev.classList.remove('on'); };
    if (src) { next.onload = show; next.onerror = show; next.src = src; } else { next.removeAttribute('src'); show(); }
    const info = hero.querySelector('.hero-info');
    info.classList.remove('in');
    void info.offsetWidth; // restart the fade-in animation
    info.innerHTML = `
      ${m.logo ? `<img class="hero-logo" src="${esc(m.logo)}" alt="${esc(m.name)}" onerror="this.outerHTML='<h1>'+this.alt.replace(/</g,'&lt;')+'</h1>'">` : `<h1>${esc(m.name)}</h1>`}
      <div class="meta-line">${metaLine(m)}</div>
      <p class="hero-desc">${esc(m.description || '')}</p>`;
    info.classList.add('in');
  }, immediate ? 0 : 140);
}
const heroMarkup = `<section class="hero" id="hero" aria-live="polite">
    <img class="hero-bg" alt=""><img class="hero-bg" alt="">
    <div class="hero-info"></div>
  </section>`;

function bindHero(root) {
  const pick = e => { const t = e.target.closest?.('[data-key]'); if (t) setHero(heroItems.get(t.dataset.key)); };
  root.addEventListener('focusin', pick);
  root.addEventListener('mouseover', pick);
}

// ---- shelves page: hero banner + rows (Home / Movies / Series)
async function shelves(tab) {
  setTab(tab);
  heroKey = null;
  const cont = tab === 'home' ? Object.values(progress.all()).sort((a, b) => b.updated - a.updated).slice(0, 20) : [];
  const list = SHELVES[tab];
  view.innerHTML = `<div class="browse">${heroMarkup}
    <div class="rows" id="rows">
      ${cont.length ? `<section class="shelf"><h2>Continue watching</h2><div class="row">${cont.map(p => tile(p, p)).join('')}</div></section>` : ''}
      ${list.map((s, i) => `<section class="shelf" data-i="${i}"><h2>${esc(s.title)} <a class="see-all" href="${s.href}" tabindex="-1">See all ›</a></h2>
        <div class="row">${skeletonRow(8)}</div></section>`).join('')}
    </div></div>`;
  bindHero($('#rows'));
  if (cont.length) setHero(cont[0], true);

  let heroSet = !!cont.length;
  await Promise.all(list.map(async (s, i) => {
    const row = view.querySelector(`.shelf[data-i="${i}"] .row`);
    try {
      const items = (await s.load()).slice(0, 24);
      if (!row.isConnected) return;
      if (!items.length) return row.closest('.shelf').remove();
      row.innerHTML = items.map(m => tile(m)).join('') + `<a class="tile more-tile focusable" tabindex="0" href="${s.href}"><span>See all<br>${esc(s.title)}</span></a>`;
      if (!heroSet && items[0]) { heroSet = true; setHero(items[0], true); }
    } catch {
      if (row.isConnected) row.closest('.shelf').remove();
    }
  }));
}

// ---- grid page ("See all")
async function browse(type, list, genre) {
  setTab(type);
  const title = list === 'year' ? `New ${type === 'movie' ? 'movies' : 'series'} of ${genre || YEAR}` : `${genre || 'Popular'} ${type === 'movie' ? 'movies' : 'series'}`;
  view.innerHTML = `<div class="page"><h1 class="page-title">${esc(title)}</h1><div id="grid">${skeletonGrid(18)}</div></div>`;
  let items = [];
  const load = async () => {
    const more = await getJSON(`/api/catalog?type=${type}&list=${list}&genre=${encodeURIComponent(genre)}&skip=${items.length}`);
    items = items.concat(more.filter(m => !items.some(i => i.id === m.id)));
    $('#grid').innerHTML = `<div class="grid">${items.map(poster).join('')}</div>
      ${more.length ? '<button class="pill more focusable" id="moreBtn">Load more</button>' : ''}`;
    const btn = $('#moreBtn');
    if (btn) btn.onclick = () => { const n = items.length; load().then(() => $('#grid .grid').children[n]?.focus()); };
  };
  try { await load(); } catch (e) { $('#grid').innerHTML = `<div class="error">Could not load: ${esc(e.message)}</div>`; }
}

async function search(q) {
  setTab('');
  $('#searchInput').value = q;
  view.innerHTML = `<div class="page"><h1 class="page-title">“${esc(q)}”</h1>${skeletonGrid(12)}</div>`;
  try {
    const [movies, series] = await Promise.all(['movie', 'series'].map(t => getJSON(`/api/catalog?type=${t}&q=${encodeURIComponent(q)}`)));
    $('.page').innerHTML = `<h1 class="page-title">“${esc(q)}”</h1>
      <h2>Movies</h2>${movies.length ? `<div class="grid">${movies.map(poster).join('')}</div>` : '<div class="empty">No movies found</div>'}
      <h2>Series</h2>${series.length ? `<div class="grid">${series.map(poster).join('')}</div>` : '<div class="empty">No series found</div>'}`;
  } catch (e) {
    $('.page').innerHTML = `<div class="error">Search failed: ${esc(e.message)}</div>`;
  }
}

const FARSI_AUDIO = /🇮🇷|farsi|persian|dubbed[ ._-]?fa|دوبله/i;
const HARD_CODEC = /x265|hevc|h\.?265|10[ .-]?bit|\bdts\b|truehd|atmos|\bac-?3\b|\bddp?\s?5|\beac3\b/i;

const FOREIGN_DUB = /[Ѐ-ӿ]|\b(dub|mvo|avo|rus|ukr|ita|esp|spa|lat|latino|castellano|french|vff|truefrench|hindi|tamil|telugu|multi|dual)\b/i;
const qOf = s => (/4k|2160/i.test(s.quality + s.name) ? '4K' : /1080/.test(s.quality + s.name) ? '1080p' : /720/.test(s.quality + s.name) ? '720p' : 'SD');
const sizeGB = s => {
  const m = /([\d.]+)\s*([KMGT])B/i.exec(s.size || '');
  return m ? Number(m[1]) * { K: 1e-6, M: 1e-3, G: 1, T: 1000 }[m[2].toUpperCase()] : 0;
};
const isHardCodec = s => HARD_CODEC.test(`${s.release} ${s.filename || ''} ${s.quality}`);
// The Android player and ffmpeg compatibility mode decode everything; plain browsers don't.
const canPlayHardCodecs = () => !!window.CineMoyAndroid || serverConfig.ffmpeg;
const QUALITY_ORDER = {
  '1080p': ['1080p', '720p', '4K', 'SD'],
  '4K': ['4K', '1080p', '720p', 'SD'],
  '720p': ['720p', '1080p', 'SD', '4K'],
};

// The source the "Play" button uses: preferred quality, well seeded, playable on this device,
// not needlessly huge. `same` (last used source) and `bingeGroup` (same release as the previous
// episode) win when present.
function pickBest(list, { same, bingeGroup } = {}) {
  if (!list.length) return null;
  const again = same && list.find(s => (same.infoHash ? s.infoHash === same.infoHash && (s.fileIdx ?? null) === (same.fileIdx ?? null) : same.url && s.url === same.url));
  if (again) return again;
  const order = QUALITY_ORDER[settings.quality] || QUALITY_ORDER['1080p'];
  const score = s => {
    let x = order.indexOf(qOf(s)) * 100;
    if (s.infoHash) x += s.seeders < 3 ? 400 : -Math.min(60, Math.log2(s.seeders + 1) * 10);
    else x -= 60; // debrid link: instant
    if (isHardCodec(s) && !canPlayHardCodecs()) x += 300;
    if (FARSI_AUDIO.test(s.release + s.filename)) x -= 20;
    else if (FOREIGN_DUB.test(s.release)) x += 120; // likely starts with Russian/Italian/… audio
    if (/remux/i.test(s.release)) x += 40;
    const gb = sizeGB(s);
    if (gb > 20) x += 30;
    if (gb > 40) x += 40;
    if (bingeGroup && s.bingeGroup === bingeGroup) x -= 150;
    return x;
  };
  return list.map(s => [score(s), s]).reduce((a, b) => (b[0] < a[0] ? b : a))[1];
}

async function detail(type, id, videoId) {
  setTab(type);
  view.innerHTML = `<div class="detail"><section class="hero detail-hero"><div class="hero-info in"><div class="skeleton" style="height:3.5rem;width:22rem;max-width:80%"></div></div></section></div>`;
  let meta;
  try { meta = await getJSON(`/api/meta/${type}/${encodeURIComponent(id)}`); }
  catch (e) { view.innerHTML = `<div class="page"><div class="error">Could not load title: ${esc(e.message)}</div></div>`; return; }

  const saved = progress.get(meta.id);
  view.innerHTML = `<div class="detail">
    <section class="hero detail-hero">
      ${meta.background || meta.poster ? `<img class="hero-bg on" src="${esc(meta.background || meta.poster)}" alt="">` : ''}
      <div class="hero-info in">
        ${meta.logo ? `<img class="hero-logo" src="${esc(meta.logo)}" alt="${esc(meta.name)}" onerror="this.outerHTML='<h1>'+this.alt.replace(/</g,'&lt;')+'</h1>'">` : `<h1>${esc(meta.name)}</h1>`}
        <div class="meta-line">${metaLine(meta)}</div>
        <p class="hero-desc full">${esc(meta.description || '')}</p>
        ${meta.cast.length ? `<p class="cast">${esc(meta.cast.slice(0, 5).join(', '))}</p>` : ''}
        <div class="hero-actions" id="heroActions"></div>
      </div>
    </section>
    <div class="detail-body ${type === 'series' ? 'split' : ''}">
      ${type === 'series' ? '<div><h2>Episodes</h2><select class="season focusable" id="seasonSel"></select><div class="episodes" id="eps"></div></div>' : ''}
      <div><h2 id="srcTitle">Sources</h2><div class="chips" id="qChips"></div><div class="sources" id="sources"></div></div>
    </div></div>`;

  if (type === 'movie') return loadSources(meta, null);

  if (!meta.videos.length) { $('#sources').innerHTML = '<div class="empty">No episodes listed.</div>'; return; }
  const seasons = [...new Set(meta.videos.map(v => v.season))];
  let current = meta.videos.find(v => v.id === videoId) || meta.videos.find(v => v.id === saved?.videoId) || meta.videos[0];
  const sel = $('#seasonSel');
  sel.innerHTML = seasons.map(s => `<option value="${s}">Season ${s}</option>`).join('');
  sel.value = current.season;

  const renderEps = () => {
    const eps = meta.videos.filter(v => v.season === Number(sel.value));
    $('#eps').innerHTML = eps.map(v => `
      <button class="ep focusable ${v.id === current.id ? 'active' : ''}" data-id="${esc(v.id)}">
        ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : '<img alt="">'}
        <div style="text-align:left"><div class="n">Episode ${v.episode}${v.released ? ' · ' + new Date(v.released).toLocaleDateString() : ''}</div><div>${esc(v.title || '')}</div></div>
      </button>`).join('');
    $('#eps').querySelectorAll('.ep').forEach(b => b.onclick = () => {
      current = meta.videos.find(v => v.id === b.dataset.id);
      history.replaceState(null, '', `#/title/series/${encodeURIComponent(meta.id)}/${encodeURIComponent(current.id)}`);
      $('#eps').querySelectorAll('.ep').forEach(x => x.classList.toggle('active', x === b));
      loadSources(meta, current);
    });
  };
  sel.onchange = renderEps;
  renderEps();
  $('#eps .ep.active')?.scrollIntoView({ block: 'nearest' });
  loadSources(meta, current);
}

let sourcesToken = 0;
async function loadSources(meta, video) {
  const token = ++sourcesToken;
  const box = $('#sources');
  const actions = $('#heroActions');
  const videoId = video ? video.id : meta.id;
  const epLabel = video ? ` S${video.season} E${video.episode}` : '';
  $('#srcTitle').textContent = video ? `Sources · S${video.season} E${video.episode}` : 'Sources';
  $('#qChips').innerHTML = '';
  box.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton" style="height:4.2rem"></div>').join('');
  actions.innerHTML = `<button class="pill primary play-btn" disabled>Finding the best source…</button>`;
  let list;
  try {
    list = await getJSON(`/api/streams/${meta.type}/${encodeURIComponent(videoId)}?addon=${encodeURIComponent(settings.torrentio)}`);
  } catch (e) {
    if (token === sourcesToken) { box.innerHTML = `<div class="error">Torrentio error: ${esc(e.message)}</div>`; actions.innerHTML = ''; }
    return;
  }
  if (token !== sourcesToken) return;
  if (!list.length) { box.innerHTML = '<div class="empty">No sources found for this title.</div>'; actions.innerHTML = ''; return; }

  // One-click play: resume with the same source if there is saved progress for this video.
  const saved = progress.get(meta.id);
  const resume = saved?.videoId === videoId && saved.pos > 30 ? saved : null;
  const best = pickBest(list, { same: resume?.src });
  const facts = [qOf(best), best.size, best.infoHash ? `👤 ${best.seeders}` : '⚡ Debrid'].filter(Boolean).map(esc).join(' · ');
  actions.innerHTML = `<button class="pill primary play-btn focusable" id="playBest">▶ ${resume ? `Resume${epLabel} · ${fmtTime(resume.pos)}` : `Play${epLabel}`}</button>
    <span class="play-src">${facts}</span>`;
  $('#playBest').onclick = () => player.open({ meta, video, stream: best });
  // On a TV nothing is focused after navigation: start on the Play button.
  if (!view.contains(document.activeElement) || document.activeElement === document.body) $('#playBest').focus();

  const qualities = ['All', ...['4K', '1080p', '720p', 'SD'].filter(q => list.some(s => qOf(s) === q))];
  let filter = 'All';
  const render = () => {
    const shown = list.filter(s => filter === 'All' || qOf(s) === filter);
    box.innerHTML = shown.map((s, i) => {
      const q = qOf(s);
      return `<button class="src focusable" data-i="${list.indexOf(s)}">
        <div class="q ${q === '4K' ? 'k4' : q === '1080p' ? 'p1080' : ''}">${q}</div>
        <div><div class="rel">${esc(s.release)}</div>
          <div class="facts">${s === best ? '<span class="badge best">★ Best pick</span>' : ''}${s.size ? `<span>💾 ${esc(s.size)}</span>` : ''}${s.infoHash ? `<span class="seed">👤 ${s.seeders}</span>` : '<span class="seed">⚡ Debrid</span>'}
            ${s.source ? `<span>${esc(s.source)}</span>` : ''}
            ${FARSI_AUDIO.test(s.release + s.filename) ? '<span class="badge fa">Farsi audio</span>' : ''}
            ${isHardCodec(s) && !canPlayHardCodecs() ? '<span class="badge" title="Browsers usually cannot decode this codec. Install ffmpeg on the server.">may not play</span>' : ''}
          </div></div>
        <div class="muted">▶</div>
      </button>`;
    }).join('') || '<div class="empty">No sources in this quality.</div>';
    box.querySelectorAll('.src').forEach(b => b.onclick = () => player.open({ meta, video, stream: list[b.dataset.i] }));
  };
  $('#qChips').innerHTML = qualities.map(q => `<button class="chip focusable ${q === filter ? 'active' : ''}" data-q="${q}">${q}</button>`).join('');
  $('#qChips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    filter = c.dataset.q;
    $('#qChips').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
    render();
  });
  render();
}

// ---------------------------------------------------------------- player
const player = (() => {
  const root = $('#player'), video = $('#video'), overlay = $('#subOverlay'), panel = $('#panel');
  const loading = $('#loading');
  let st = null;          // current session state
  let idleTimer, statusTimer, rafId, saveTimer, lastSubHtml = '';

  const isCompat = () => st?.mode === 'compat';
  const now = () => (isCompat() ? st.offset + video.currentTime : video.currentTime);
  const total = () => (isCompat() || !isFinite(video.duration) ? st?.probe?.duration || 0 : video.duration);

  function showLoading(text) {
    if (!$('#loadingText')) resetLoading(); // an error message replaced the spinner
    loading.hidden = false;
    $('#loadingText').textContent = text;
  }
  function hideLoading() { loading.hidden = true; }
  function showError(msg) {
    loading.hidden = false;
    loading.style.pointerEvents = 'auto';
    loading.innerHTML = `<div class="error" style="font-size:1.1rem">${esc(msg)}</div>
      <button class="pill primary focusable" id="errBack">Choose another source</button>`;
    $('#errBack').onclick = close;
    $('#errBack').focus();
  }
  function resetLoading() {
    loading.style.pointerEvents = 'none';
    loading.innerHTML = '<div class="spinner"></div><div id="loadingText"></div>';
  }

  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused && panel.hidden) root.classList.add('idle'); }, 3500);
  }

  function transcodeUrl(start) {
    return api(`/transcode?${st.srcQuery}&start=${Math.floor(start)}&audio=${st.audio}`);
  }

  function setSource(start = 0) {
    if (isCompat()) {
      st.offset = start;
      video.src = transcodeUrl(start);
    } else {
      video.src = st.directUrl;
      if (start) video.addEventListener('loadedmetadata', () => (video.currentTime = start), { once: true });
    }
    video.play().catch(() => {});
  }

  function switchToCompat(reason) {
    if (isCompat() || !serverConfig.ffmpeg) return false;
    const at = now();
    st.mode = 'compat';
    toast(reason || 'Using compatibility mode (ffmpeg)');
    showLoading('Converting video for this device…');
    setSource(at);
    return true;
  }

  function seekTo(t) {
    t = Math.max(0, Math.min(t, (total() || Infinity) - 1));
    if (isCompat()) {
      const rel = t - st.offset;
      const buffered = [...Array(video.buffered.length).keys()].some(i => rel >= video.buffered.start(i) && rel <= video.buffered.end(i));
      if (buffered) video.currentTime = rel; else { showLoading('Seeking…'); setSource(t); }
    } else video.currentTime = t;
    wake();
  }

  async function open({ meta, video: ep, stream, resumeAt }) {
    if (st) teardown();
    const sid = ep ? { s: ep.season, e: ep.episode } : { s: 0, e: 0 };
    let directUrl, srcQuery;
    if (stream.url) {
      directUrl = stream.url;
      srcQuery = `ref=${stream.ref}`;
    } else {
      const q = new URLSearchParams(sid);
      (stream.trackers || []).slice(0, 6).forEach(t => q.append('tr', t));
      directUrl = api(`/stream/${stream.infoHash}/${stream.fileIdx ?? 'auto'}?${q}`);
      srcQuery = `hash=${stream.infoHash}&idx=${stream.fileIdx ?? ''}&${q}`;
    }
    const videoId = ep ? ep.id : meta.id;
    const saved = progress.get(meta.id);
    if (resumeAt == null && saved?.videoId === videoId && saved.pos > 30) resumeAt = saved.pos;

    st = { meta, ep, stream, directUrl, srcQuery, videoId, mode: 'direct', offset: 0, audio: 0, delay: 0, probe: null, subs: null, subRef: null, cues: [] };
    st.returnFocus = document.activeElement;
    if (window.CineMoyAndroid) return openNative(resumeAt);

    $('#pTitle').textContent = meta.name + (ep ? ` — S${ep.season}E${ep.episode}${ep.title ? ' · ' + ep.title : ''}` : '');
    $('#pNext').hidden = !nextEpisode();
    $('#pAudio').hidden = true;
    panel.hidden = true;
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    history.pushState({ player: true }, '', location.hash);
    resetLoading();
    showLoading(stream.infoHash ? 'Connecting to peers…' : 'Loading…');
    wake();
    $('#pPlay').focus();
    // Fire-and-forget: on some platforms this promise never settles without a user gesture.
    try { root.requestFullscreen?.()?.catch(() => {}); } catch { /* not supported (e.g. TV) */ }

    if (stream.infoHash) pollStatus(stream.infoHash);
    loadSubtitleList();
    rafId = requestAnimationFrame(tick);
    saveTimer = setInterval(saveProgress, 5000);

    const session = st;
    if (serverConfig.ffmpeg) {
      showLoading(stream.infoHash ? 'Connecting to peers & reading file info…' : 'Reading file info…');
      try {
        st.probe = await getJSON(`/api/probe?${srcQuery}`);
      } catch { /* fall back to direct play */ }
      if (st !== session) return;
      if (st.probe && !st.probe.browserSafe) st.mode = 'compat';
      renderAudioButton();
    }
    if (resumeAt) toast(`Resuming from ${fmtTime(resumeAt)}`);
    setSource(resumeAt || 0);
  }

  function pollStatus(hash) {
    const tick = async () => {
      try {
        const s = await getJSON(`/api/status/${hash}`);
        if (s.state === 'idle') return;
        const txt = `👤 ${s.peers} peers · ⬇ ${fmtSpeed(s.downloadSpeed)}`;
        $('#pStats').textContent = txt;
        if (!loading.hidden && $('#loadingText')) $('#loadingText').textContent = (s.state === 'ready' ? 'Buffering…' : 'Connecting to peers…') + '\n' + txt;
      } catch { /* server busy */ }
    };
    tick();
    statusTimer = setInterval(tick, 1500);
  }

  function renderAudioButton() {
    const tracks = st.probe?.audio || [];
    $('#pAudio').hidden = tracks.length < 2;
  }

  // -------- subtitles
  // Sorted by the server: language, then how closely the subtitle's release matches this file.
  function searchSubtitles() {
    const p = new URLSearchParams({
      langs: settings.subLangs || 'fa', subdl: settings.subdlKey || '', addons: settings.subAddons || '',
      release: st.stream.filename || st.stream.release || '',
    });
    return getJSON(`/api/subtitles/${st.meta.type}/${encodeURIComponent(st.videoId)}?${p}`);
  }
  const MATCH = 6; // same release group + similar name (see matchScore on the server)

  async function loadSubtitleList() {
    const session = st;
    try {
      const res = await searchSubtitles();
      if (st !== session) return;
      st.subs = res.subtitles;
      st.subErrors = res.errors;
      const first = st.subs.find(s => s.lang === 'fa');
      if (settings.autoSub && first) selectSub(first.ref, true);
      else if (!first && settings.subLangs.includes('fa')) toast('No Farsi subtitles found for this title');
    } catch (e) {
      if (st === session) { st.subs = []; st.subErrors = [e.message]; }
    }
    if (st === session && !panel.hidden && panel.dataset.kind === 'subs') openSubsPanel();
  }

  async function selectSub(ref, auto = false) {
    const session = st;
    st.subRef = ref;
    st.cues = [];
    if (!ref) return refreshPanel();
    refreshPanel();
    try {
      const { cues } = await getJSON(`/api/subtitle/${ref}`);
      if (st !== session || st.subRef !== ref) return;
      st.cues = cues;
      const s = st.subs?.find(x => x.ref === ref);
      if (s) toast(`${auto ? 'Subtitle: ' : ''}${s.provider} · ${s.label}`.slice(0, 120));
    } catch (e) {
      toast('Subtitle failed: ' + e.message);
      if (st === session) st.subRef = null;
    }
    refreshPanel();
  }

  async function loadLocalSub(file) {
    const buf = await file.arrayBuffer();
    const r = await fetch(api(`/api/parse?lang=${(settings.subLangs || 'fa').split(',')[0]}`), { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
    const j = await r.json();
    if (!r.ok) return toast(j.error || 'Could not read file');
    st.subRef = 'local';
    st.cues = j.cues;
    toast(`Loaded ${file.name}`);
    refreshPanel();
  }

  function cuesAt(t) {
    const c = st.cues;
    let lo = 0, hi = c.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].s <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    const out = [];
    for (let i = idx; i >= 0 && i > idx - 8; i--) if (c[i].e > t) out.unshift(c[i]);
    return out;
  }
  const fmtLine = l => esc(l).replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>');

  function tick() {
    if (!st) return;
    const t = now();
    const html = st.cues.length ? cuesAt(t - st.delay).map(c => c.t.split('\n').map(l => `<span class="line" dir="auto">${fmtLine(l)}</span>`).join('')).join('') : '';
    if (html !== lastSubHtml) { overlay.innerHTML = html; lastSubHtml = html; }
    const d = total();
    const pct = d ? (t / d) * 100 : 0;
    $('#seekFill').style.width = pct + '%';
    $('#seekThumb').style.left = pct + '%';
    if (video.buffered.length && d) {
      const end = (isCompat() ? st.offset : 0) + video.buffered.end(video.buffered.length - 1);
      $('#seekBuf').style.width = Math.min(100, (end / d) * 100) + '%';
    }
    $('#pTime').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    rafId = requestAnimationFrame(tick);
  }

  // -------- side panel (subtitles / audio)
  function refreshPanel() {
    if (panel.hidden) return;
    if (panel.dataset.kind === 'subs') openSubsPanel(true); else openAudioPanel(true);
  }

  function openSubsPanel(keepFocus) {
    const focusedRef = keepFocus && document.activeElement?.dataset?.ref;
    panel.dataset.kind = 'subs';
    const list = st.subs;
    const LANG = { fa: 'فارسی', en: 'English', ar: 'العربية', tr: 'Türkçe' };
    panel.innerHTML = `
      <h3>Subtitles</h3>
      <div class="opt-row"><span class="muted">Sync</span>
        <button class="pill focusable" data-act="d-">−0.5s</button><span class="val">${st.delay > 0 ? '+' : ''}${st.delay.toFixed(1)}s</span><button class="pill focusable" data-act="d+">+0.5s</button>
        <span class="muted" style="margin-left:.6rem">Size</span>
        <button class="pill focusable" data-act="s-">A−</button><button class="pill focusable" data-act="s+">A+</button>
      </div>
      <button class="opt focusable ${!st.subRef ? 'active' : ''}" data-ref="">Off</button>
      ${st.subRef === 'local' ? '<button class="opt focusable active" data-ref="local"><div class="t">Local file</div></button>' : ''}
      ${list == null ? '<div class="empty"><div class="spinner" style="margin:auto"></div>Searching subtitles…</div>'
        : list.length ? list.map(s => `<button class="opt focusable ${s.ref === st.subRef ? 'active' : ''}" data-ref="${s.ref}">
            <div class="t" dir="auto">${esc(s.label)}</div><div class="p">${s.match >= MATCH ? '<b class="match">✓ Matches this video</b> · ' : ''}${esc(LANG[s.lang] || s.lang)} · ${esc(s.provider)}${s.downloads ? ' · ⬇ ' + s.downloads : ''}${s.author ? ' · ' + esc(s.author) : ''}</div></button>`).join('')
        : '<div class="empty">No subtitles found.</div>'}
      ${st.subErrors?.length ? `<p class="muted" style="font-size:.75rem">${st.subErrors.map(esc).join('<br>')}</p>` : ''}
      ${!settings.subdlKey ? '<p class="muted" style="font-size:.8rem">Tip: add a free SubDL API key in Settings for many more Farsi subtitles.</p>' : ''}
      <label class="pill focusable" style="display:inline-block;margin-top:.6rem" tabindex="0">Load from file…<input type="file" accept=".srt,.vtt,.ass,.ssa,.zip" hidden id="subFile"></label>`;
    panel.hidden = false;
    panel.querySelectorAll('.opt').forEach(b => b.onclick = () => selectSub(b.dataset.ref || null));
    panel.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'd-' || a === 'd+') st.delay = Math.round((st.delay + (a === 'd+' ? 0.5 : -0.5)) * 10) / 10;
      else {
        settings.subSize = Math.max(16, Math.min(72, settings.subSize + (a === 's+' ? 4 : -4)));
        store.set('settings', settings); applySubSize();
      }
      openSubsPanel(true);
      panel.querySelector(`[data-act="${a}"]`).focus();
    });
    $('#subFile').onchange = e => e.target.files[0] && loadLocalSub(e.target.files[0]);
    if (!keepFocus) (panel.querySelector('.opt.active') || panel.querySelector('.focusable')).focus();
    else if (focusedRef != null) panel.querySelector(`[data-ref="${focusedRef}"]`)?.focus();
  }

  function openAudioPanel(keepFocus) {
    panel.dataset.kind = 'audio';
    const tracks = st.probe?.audio || [];
    panel.innerHTML = `<h3>Audio</h3>` + tracks.map(a => `
      <button class="opt focusable ${a.index === st.audio ? 'active' : ''}" data-a="${a.index}">
        <div class="t">${esc(a.title || a.lang || 'Track ' + (a.index + 1))}</div>
        <div class="p">${esc([a.lang, a.codec, a.channels && a.channels + 'ch'].filter(Boolean).join(' · '))}</div></button>`).join('') +
      (!serverConfig.ffmpeg ? '<p class="muted">Switching audio tracks needs ffmpeg on the server.</p>' : '');
    panel.hidden = false;
    panel.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const idx = Number(b.dataset.a);
      if (idx === st.audio) return;
      const at = now();
      st.audio = idx;
      st.mode = 'compat';
      showLoading('Switching audio…');
      setSource(at);
      openAudioPanel();
    });
    if (!keepFocus) (panel.querySelector('.opt.active') || panel.querySelector('.focusable'))?.focus();
  }

  function closePanel() { panel.hidden = true; $('#pSubs').focus(); wake(); }

  function applySubSize() {
    document.documentElement.style.setProperty('--sub-size', Math.round(settings.subSize * (innerWidth < 800 ? 0.6 : innerWidth / 1600)) + 'px');
  }
  addEventListener('resize', applySubSize);
  applySubSize();

  // -------- progress / next episode
  function saveProgress(pos = now(), dur = total()) {
    if (!st || !dur || pos < 5) return;
    const { meta, ep, stream } = st;
    progress.save({
      id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, background: meta.background, logo: meta.logo,
      year: meta.year, rating: meta.rating, runtime: meta.runtime, genres: meta.genres.slice(0, 3), description: (meta.description || '').slice(0, 400),
      videoId: st.videoId, season: ep?.season, episode: ep?.episode, pos, dur,
      // Resume uses the same source (same file, so the position and the subtitle sync still fit).
      src: stream.infoHash ? { infoHash: stream.infoHash, fileIdx: stream.fileIdx ?? null } : { url: stream.url },
    });
  }

  // -------- Android: playback goes to the native ExoPlayer, which decodes every common
  // codec (HEVC, AC3/E-AC3, DTS, TrueHD…) and shows the Farsi subtitles as selectable tracks.
  async function openNative(resumeAt) {
    const session = st;
    const abs = u => new URL(u, location.href).href;
    toast('Opening player…');
    let list = [];
    try {
      const res = await Promise.race([
        searchSubtitles(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
      ]);
      list = res.subtitles.slice(0, 25);
    } catch { /* play without subtitles */ }
    if (st !== session) return;
    const { meta, ep, stream } = st;
    // The native player draws these subtitles itself (so it can shift them for sync).
    window.CineMoyAndroid.play(JSON.stringify({
      url: abs(st.directUrl),
      title: meta.name,
      subtitle: ep ? `S${ep.season} · E${ep.episode}${ep.title ? ' · ' + ep.title : ''}` : String(meta.year || ''),
      startMs: Math.round((resumeAt || 0) * 1000),
      statusUrl: stream.infoHash ? abs(api(`/api/status/${stream.infoHash}`)) : '',
      preferredSubLang: settings.autoSub ? 'fa' : '',
      subtitles: list.map(s => ({
        cuesUrl: abs(api(`/api/subtitle/${s.ref}`)),
        label: `${s.match >= MATCH ? '✓ ' : ''}${s.provider} · ${s.label}`.slice(0, 90),
        lang: s.lang,
      })),
    }));
  }
  // Called by the Android player when it closes.
  window.__cmNativeClosed = (posMs, durMs, ended) => {
    if (!st) return;
    saveProgress(posMs / 1000, durMs / 1000);
    if (ended && nextEpisode()) { toast('Playing next episode…'); playNext(); }
    else st = null;
  };

  function nextEpisode() {
    if (!st?.ep) return null;
    const vids = st.meta.videos;
    return vids[vids.findIndex(v => v.id === st.ep.id) + 1] || null;
  }

  async function playNext() {
    const next = nextEpisode();
    if (!next) return;
    const { meta, stream } = st;
    showLoading(`Finding S${next.season}E${next.episode}…`);
    try {
      const list = await getJSON(`/api/streams/series/${encodeURIComponent(next.id)}?addon=${encodeURIComponent(settings.torrentio)}`);
      const pick = pickBest(list, { bingeGroup: stream.bingeGroup });
      if (!pick) throw new Error('No sources for next episode');
      open({ meta, video: next, stream: pick, resumeAt: 0 });
    } catch (e) {
      close();
      location.hash = `#/title/series/${encodeURIComponent(meta.id)}/${encodeURIComponent(next.id)}`;
      toast(e.message);
    }
  }

  // -------- lifecycle
  function teardown() {
    saveProgress();
    clearInterval(statusTimer); clearInterval(saveTimer); cancelAnimationFrame(rafId);
    video.pause(); video.removeAttribute('src'); video.load();
    overlay.innerHTML = ''; lastSubHtml = ''; $('#pStats').textContent = '';
    st = null;
  }

  function close() {
    if (!st) return;
    const back = st.returnFocus;
    teardown();
    root.hidden = true;
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (history.state?.player) history.back();
    back?.focus?.();
  }
  // Browser / Android back button while the player is open closes the player.
  addEventListener('popstate', () => { if (st && !history.state?.player) close(); });

  // Torrent data arrives in bursts. The browser resumes as soon as it has a fraction of a second,
  // which turns a slow torrent into constant stop/start; after a stall, hold until there is a cushion.
  const REBUFFER_S = 8, REBUFFER_MAX_MS = 30000;
  let stalled = true, holdTimer = null;
  function bufferedAhead() {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i)) return video.buffered.end(i) - t;
    }
    return 0;
  }
  function holdForBuffer() {
    const left = (isFinite(video.duration) ? video.duration : Infinity) - video.currentTime;
    if (holdTimer || bufferedAhead() >= Math.min(REBUFFER_S, left - 1)) return false;
    const since = Date.now();
    video.pause();
    showLoading('Buffering…');
    holdTimer = setInterval(() => {
      if (!st || video.ended) return releaseHold(false);
      if (bufferedAhead() >= Math.min(REBUFFER_S, left - 1) || Date.now() - since > REBUFFER_MAX_MS) releaseHold(true);
    }, 500);
    return true;
  }
  function releaseHold(resume) {
    clearInterval(holdTimer);
    holdTimer = null;
    if (resume) video.play().catch(() => {});
  }

  // -------- video events
  video.addEventListener('waiting', () => { stalled = true; showLoading('Buffering…'); });
  video.addEventListener('emptied', () => { stalled = true; releaseHold(false); });
  video.addEventListener('playing', () => {
    if (holdTimer) releaseHold(false); // the viewer pressed play during the hold
    else if (stalled) { stalled = false; if (holdForBuffer()) return; }
    hideLoading(); wake();
  });
  video.addEventListener('canplay', () => { if (!holdTimer) hideLoading(); });
  video.addEventListener('play', () => ($('#pPlay').textContent = '❚❚'));
  video.addEventListener('pause', () => { $('#pPlay').textContent = '▶'; wake(); });
  video.addEventListener('loadedmetadata', () => {
    // Audio plays but the video track can't be decoded (typically HEVC) → convert.
    if (st && !isCompat() && video.videoWidth === 0 && !switchToCompat('Video codec not supported here, converting with ffmpeg…') && !serverConfig.ffmpeg) {
      toast('This video codec is not supported by this device. Try an x264 source or install ffmpeg on the server.', 7000);
    }
  });
  video.addEventListener('error', () => {
    if (!st || !video.getAttribute('src')) return;
    if (switchToCompat('Format not supported directly, converting with ffmpeg…')) return;
    showError(isCompat()
      ? 'Playback failed. The torrent may have too few peers. Try another source.'
      : 'This device cannot play this file format. Pick an MP4/x264 source, or install ffmpeg on the server to enable compatibility mode.');
  });
  video.addEventListener('ended', () => { if (nextEpisode()) { toast('Playing next episode…'); playNext(); } else close(); });

  // -------- controls
  const togglePlay = () => (video.paused ? video.play() : video.pause());
  $('#pPlay').onclick = togglePlay;
  $('#pRew').onclick = () => seekTo(now() - 10);
  $('#pFwd').onclick = () => seekTo(now() + 10);
  $('#pBack').onclick = close;
  $('#pNext').onclick = playNext;
  $('#pSubs').onclick = () => (panel.hidden || panel.dataset.kind !== 'subs' ? openSubsPanel() : closePanel());
  $('#pAudio').onclick = () => (panel.hidden || panel.dataset.kind !== 'audio' ? openAudioPanel() : closePanel());
  $('#pFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.());
  video.onclick = () => { if (!panel.hidden) return closePanel(); togglePlay(); };
  video.ondblclick = () => $('#pFull').onclick();
  root.addEventListener('mousemove', wake);
  const seekBar = $('#seek');
  seekBar.onclick = e => { const r = seekBar.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * total()); };

  // Returns true when the key was consumed.
  function handleKey(e, isBack) {
    if (!st) return false;
    const k = e.key;
    wake();
    if (isBack) { if (!panel.hidden) closePanel(); else close(); return true; }
    if (!panel.hidden) return false; // let spatial nav move inside the panel
    const focused = document.activeElement;
    const hidden = root.classList.contains('idle');
    if (k === 'MediaPlayPause' || k === ' ' && focused?.tagName !== 'BUTTON') { togglePlay(); return true; }
    if (k === 'MediaPlay') { video.play(); return true; }
    if (k === 'MediaPause') { video.pause(); return true; }
    if (k === 'MediaFastForward' || (k === 'ArrowRight' && (hidden || focused === seekBar))) { seekTo(now() + (e.shiftKey ? 60 : 10)); return true; }
    if (k === 'MediaRewind' || (k === 'ArrowLeft' && (hidden || focused === seekBar))) { seekTo(now() - (e.shiftKey ? 60 : 10)); return true; }
    if (hidden && (k === 'ArrowUp' || k === 'ArrowDown')) { $('#pPlay').focus(); return true; }
    if (hidden && k === 'Enter') { togglePlay(); return true; }
    if (k === 'f') { $('#pFull').onclick(); return true; }
    if (k === 's' || k === 'c') { $('#pSubs').onclick(); return true; }
    return false;
  }

  return { open, close, handleKey, isOpen: () => !!st, panel, root };
})();

// ---------------------------------------------------------------- settings
async function openSettings() {
  const d = $('#settings');
  const langOpts = [['fa', 'Farsi only'], ['fa,en', 'Farsi + English'], ['en', 'English only'], ['fa,en,ar,tr', 'Farsi, English, Arabic, Turkish']];
  const qualityOpts = [['1080p', '1080p (recommended)'], ['4K', '4K when available'], ['720p', '720p (slow connections)']];
  const desktop = window.CineMoyDesktop ? await window.CineMoyDesktop.info().catch(() => null) : null;
  d.innerHTML = `
    <h2 style="margin-top:0">Settings</h2>
    <label for="sQuality">Quality for the Play button</label>
    <select id="sQuality" class="focusable">${qualityOpts.map(([v, l]) => `<option value="${v}" ${v === settings.quality ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="hint">Play picks a well-seeded source in this quality that plays on this device. You can still choose any source from the list.</div>

    <label for="sTorrentio">Torrentio addon URL</label>
    <input id="sTorrentio" class="focusable" placeholder="${esc(serverConfig.defaults.torrentio || 'https://torrentio.strem.fun')}" value="${esc(settings.torrentio)}">
    <div class="hint">Leave empty for the default. To filter qualities or use Real-Debrid / AllDebrid / Premiumize, open
      <a href="https://torrentio.strem.fun/configure" target="_blank" rel="noopener">torrentio.strem.fun/configure</a>, then copy the install link (stremio://… or https://…/manifest.json) here.</div>

    <label for="sSubdl">SubDL API key</label>
    <input id="sSubdl" class="focusable" value="${esc(settings.subdlKey)}" placeholder="Optional, but strongly recommended for Farsi">
    <div class="hint">Free at <a href="https://subdl.com/panel/api" target="_blank" rel="noopener">subdl.com/panel/api</a>. SubDL has the largest collection of Farsi subtitles (it hosts the old Subscene archive). OpenSubtitles is always searched without a key.</div>

    <label for="sLangs">Subtitle languages</label>
    <select id="sLangs" class="focusable">${langOpts.map(([v, l]) => `<option value="${v}" ${v === settings.subLangs ? 'selected' : ''}>${l}</option>`).join('')}</select>

    <label style="display:flex;gap:.6rem;align-items:center"><input type="checkbox" id="sAuto" class="focusable" style="width:auto" ${settings.autoSub ? 'checked' : ''}> Automatically turn on the best Farsi subtitle</label>

    <label for="sAddons">Extra Stremio subtitle addons</label>
    <input id="sAddons" class="focusable" value="${esc(settings.subAddons)}" placeholder="https://example-addon/manifest.json, …">
    <div class="hint">Comma-separated. Any Stremio subtitles addon works here.</div>

    ${desktop ? `
    <label style="display:flex;gap:.6rem;align-items:center"><input type="checkbox" id="sLan" class="focusable" style="width:auto" ${desktop.lanSharing ? 'checked' : ''}> Share with TVs and phones on my network</label>
    <div class="hint">Lets devices on your Wi-Fi use this PC to stream. Off by default, so nobody else on your network can use it. Changing this restarts CineMoy.
      ${desktop.lanSharing && desktop.addresses.length ? `<br>Open on your TV: <b>${desktop.addresses.map(esc).join('</b> or <b>')}</b>` : ''}</div>` : ''}

    <label for="sApi">Server address (advanced)</label>
    <input id="sApi" class="focusable" value="${esc(settings.apiBase)}" placeholder="Same as this page">
    <div class="hint">Only needed when this UI is installed as a separate TV app. Example: http://192.168.1.20:7070.
      Server ffmpeg: <b>${serverConfig.ffmpeg ? 'found ✓' : 'not installed'}</b>.</div>

    <div class="about">CineMoy ${esc(serverConfig.version || '')}
      ${updatePlatform() ? '<button class="pill focusable" id="sUpdate">Check for updates</button>' : ''}</div>

    <div class="actions"><button class="pill focusable" id="sCancel">Cancel</button><button class="pill primary focusable" id="sSave">Save</button></div>`;
  d.showModal();
  $('#sQuality').focus();
  $('#sCancel').onclick = () => d.close();
  if ($('#sUpdate')) $('#sUpdate').onclick = () => { d.close(); checkForUpdate(true); };
  $('#sSave').onclick = async () => {
    settings = {
      ...settings,
      quality: $('#sQuality').value,
      torrentio: $('#sTorrentio').value.trim(),
      subdlKey: $('#sSubdl').value.trim(),
      subLangs: $('#sLangs').value,
      autoSub: $('#sAuto').checked,
      subAddons: $('#sAddons').value.trim(),
      apiBase: $('#sApi').value.trim(),
    };
    store.set('settings', settings);
    d.close();
    if (desktop && $('#sLan').checked !== desktop.lanSharing) {
      toast('Restarting CineMoy…');
      return window.CineMoyDesktop.setLanSharing($('#sLan').checked);
    }
    await loadServerConfig();
    toast('Settings saved');
    router();
  };
}

// ---------------------------------------------------------------- updates (Windows + Android apps)
// New versions are published as GitHub releases; the app offers the right file for this device.
const REPO = 'SaeedMoy/CineMoy';
const updatePlatform = () => (window.CineMoyAndroid ? 'android' : window.CineMoyDesktop ? 'windows' : '');
const isNewer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkForUpdate(manual = false) {
  const platform = updatePlatform();
  if (!platform || !serverConfig.version) return;
  if (!manual && Date.now() - store.get('updateChecked', 0) < 12 * 3600 * 1000) return;
  store.set('updateChecked', Date.now());
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(r.status === 404 ? 'no release published yet' : `HTTP ${r.status}`);
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!isNewer(latest, serverConfig.version)) { if (manual) toast(`You have the latest version (${serverConfig.version}).`); return; }
    if (!manual && store.get('updateSkipped') === latest) return;
    const asset = await pickAsset(platform, rel.assets || []);
    showUpdate(rel, latest, asset);
  } catch (e) {
    if (manual) toast('Could not check for updates: ' + e.message);
  }
}

async function pickAsset(platform, assets) {
  const find = re => assets.find(a => re.test(a.name));
  if (platform === 'android') {
    const abi = window.CineMoyAndroid.abi?.() || '';
    return (abi && assets.find(a => a.name.endsWith('.apk') && a.name.includes(abi))) || find(/universal.*\.apk$/i) || find(/\.apk$/i);
  }
  const info = await window.CineMoyDesktop.info().catch(() => ({}));
  if (info.platform === 'darwin') {
    const arch = info.arch === 'arm64' ? 'arm64' : 'x64';
    return assets.find(a => a.name.endsWith('.dmg') && a.name.includes(`mac-${arch}`)) || find(/\.dmg$/i);
  }
  if (info.platform === 'linux') return info.appImage ? find(/\.AppImage$/i) : find(/\.deb$/i) || find(/\.AppImage$/i);
  return (info.portable ? find(/portable.*\.exe$/i) : find(/setup.*\.exe$/i)) || find(/\.exe$/i);
}

function showUpdate(rel, latest, asset) {
  const d = $('#update');
  const android = updatePlatform() === 'android';
  d.innerHTML = `
    <h2 style="margin-top:0">CineMoy ${esc(latest)} is available</h2>
    <p class="muted">You have version ${esc(serverConfig.version)}.</p>
    ${rel.body ? `<div class="notes">${esc(rel.body.slice(0, 4000))}</div>` : ''}
    <div class="actions">
      <button class="pill focusable" id="uSkip">Skip this version</button>
      <button class="pill focusable" id="uLater">Later</button>
      <button class="pill primary focusable" id="uGo">${asset ? (android ? 'Download & install' : 'Download') : 'Open release page'}</button>
    </div>`;
  d.showModal();
  $('#uGo').focus();
  $('#uLater').onclick = () => d.close();
  $('#uSkip').onclick = () => { store.set('updateSkipped', latest); d.close(); };
  $('#uGo').onclick = () => {
    if (!asset) { window.open(rel.html_url, '_blank'); return d.close(); }
    if (!android) {
      window.open(asset.browser_download_url, '_blank'); // opens in the default browser
      toast('Downloading in your browser. Run the file to update CineMoy.', 8000);
      return d.close();
    }
    const btn = $('#uGo');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    window.__cmUpdateProgress = pct => { btn.textContent = `Downloading… ${pct}%`; };
    window.__cmUpdateDone = () => d.close(); // Android's installer takes over
    window.__cmUpdateError = msg => { btn.disabled = false; btn.textContent = 'Try again'; toast('Update failed: ' + msg, 6000); };
    window.CineMoyAndroid.installUpdate(asset.browser_download_url);
  };
}
$('#settingsBtn').onclick = openSettings;

// ---------------------------------------------------------------- spatial navigation (TV remotes)
const openDialog = () => document.querySelector('dialog[open]');
const FOCUSABLE = '.focusable, button, input, select, a[href]';
function candidates(scope) {
  // tabindex="-1" (logo, "See all" headings) is mouse-only; the row's own "See all" tile covers remotes.
  return [...scope.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden');
}
function moveFocus(dir) {
  let scope = document;
  const dialog = openDialog();
  if (dialog) scope = dialog;
  else if (player.isOpen()) scope = player.panel.hidden ? player.root : player.panel;
  const list = candidates(scope);
  const cur = document.activeElement;
  if (!list.includes(cur)) { list[0]?.focus(); return; }
  const a = cur.getBoundingClientRect();
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    let gap, cross;
    if (dir === 'left') { if (b.right > a.left + 4) continue; gap = a.left - b.right; cross = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) ? Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) : 0; }
    else if (dir === 'right') { if (b.left < a.right - 4) continue; gap = b.left - a.right; cross = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) ? Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) : 0; }
    else if (dir === 'up') { if (b.bottom > a.top + 4) continue; gap = a.top - b.bottom; cross = Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2); }
    else { if (b.top < a.bottom - 4) continue; gap = b.top - a.bottom; cross = Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2); }
    const score = gap + cross * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus({ preventScroll: true });
    const vertical = dir === 'up' || dir === 'down';
    const rows = $('#rows');
    const shelf = best.closest('.shelf');
    if (rows && shelf && rows.contains(shelf)) {
      // Fire TV style: the focused shelf snaps to the top of the rows area (absolute target, so
      // fast key repeats don't drift), and the row scrolls sideways only when the tile is cut off.
      if (vertical) rows.scrollTo({ top: shelf.offsetTop, behavior: 'smooth' });
      const row = best.closest('.row'), r = row?.getBoundingClientRect(), b = best.getBoundingClientRect();
      if (row && (b.left < r.left || b.right > r.right)) row.scrollBy({ left: b.left < r.left ? b.left - r.left - 40 : b.right - r.right + 40, behavior: 'smooth' });
    } else if (vertical && rows && !rows.contains(best)) {
      rows.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      best.scrollIntoView({ block: vertical ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }
}

const isTyping = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' && !['checkbox', 'file'].includes(el.type) || el.tagName === 'TEXTAREA');
};

document.addEventListener('keydown', e => {
  const k = e.key, code = e.keyCode;
  const isBack = k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || code === 461 || code === 10009 || (k === 'Backspace' && !isTyping());
  if (player.isOpen() && !openDialog() && player.handleKey(e, isBack)) { e.preventDefault(); return; }
  if (isBack) {
    if (openDialog()) return; // native dialog handles Escape
    if (isTyping()) { document.activeElement.blur(); e.preventDefault(); return; }
    if (location.hash && location.hash !== '#/') { e.preventDefault(); history.back(); }
    return;
  }
  const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
  if (!dir) return;
  if (isTyping() && (dir === 'left' || dir === 'right')) return;
  if (document.activeElement?.tagName === 'SELECT' && (dir === 'up' || dir === 'down') && !matchMedia('(pointer: none)').matches) return;
  e.preventDefault();
  moveFocus(dir);
});
// Enter on a focused <label> (file picker) or link-like element.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.tagName === 'LABEL') document.activeElement.querySelector('input')?.click();
});

// Android's Back button calls this; returning false lets the app exit from the home screen.
window.__cmBack = () => {
  if (openDialog()) { openDialog().close(); return true; }
  if (player.isOpen() && !player.root.hidden) { player.close(); return true; }
  if (isTyping()) { document.activeElement.blur(); return true; }
  if (location.hash && location.hash !== '#/') { history.back(); return true; }
  return false;
};

// Samsung Tizen needs media keys registered explicitly.
try { ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind'].forEach(k => window.tizen?.tvinputdevice?.registerKey(k)); } catch { /* not Tizen */ }

// ---------------------------------------------------------------- router + boot
$('#searchForm').onsubmit = e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
};

function router() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/title\/(movie|series)\/([^/]+)(?:\/([^/]+))?$/))) return detail(m[1], decodeURIComponent(m[2]), m[3] && decodeURIComponent(m[3]));
  if ((m = h.match(/^#\/search\/(.+)$/))) return search(decodeURIComponent(m[1]));
  if ((m = h.match(/^#\/browse\/(movie|series)\/(top|year)\/([^/]*)$/))) return browse(m[1], m[2], decodeURIComponent(m[3]));
  if (h === '#/movies') return shelves('movie');
  if (h === '#/series') return shelves('series');
  return shelves('home');
}
addEventListener('hashchange', () => { if (!player.isOpen()) { router(); scrollTo(0, 0); } });

async function loadServerConfig() {
  try { serverConfig = await getJSON('/api/config'); }
  catch { toast('Cannot reach the CineMoy server. Check "Server address" in Settings.', 8000); }
}

await loadServerConfig();
router();
setTimeout(checkForUpdate, 4000);
