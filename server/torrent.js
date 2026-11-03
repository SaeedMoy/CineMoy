// Torrent engine: turns an infoHash (+ file index) into a seekable HTTP stream.
import path from 'node:path';
import fs from 'node:fs';
import WebTorrent from 'webtorrent';
import { options } from './options.js';
import PieceStore from './piece-store.js';

const CACHE_DIR = options.cacheDir;
// 32-bit builds can't address file positions past 2 GiB (see piece-store.js).
const PIECE_FILES = ['arm', 'ia32'].includes(process.arch) || process.env.CINEMOY_PIECE_FILES === '1';
const MAX_ACTIVE = 2;          // torrents kept alive at once
const IDLE_MS = 5 * 60 * 1000; // drop torrents nobody has read from for this long

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'http://tracker.opentrackr.org:1337/announce', // reaches peers where UDP is filtered
  'https://tracker.tamersunion.org:443/announce',
  'wss://tracker.openwebtorrent.com',
];

// Pieces just ahead of the playback position are "critical": a fast peer may take them over
// from a slow one instead of the player waiting on the slowest peer. WebTorrent itself marks
// at most 1 MB, which is less than a single piece in most movie torrents.
const READ_AHEAD = 24 * 1024 * 1024;
const MIN_CRITICAL_PIECES = 4;

fs.rmSync(CACHE_DIR, { recursive: true, force: true });
const { torrentPort, uploadLimit } = options;
const client = new WebTorrent({
  maxConns: 100,
  torrentPort,
  dhtPort: torrentPort,
  uploadLimit: uploadLimit >= 0 ? uploadLimit * 1024 : -1,
});
client.on('error', e => console.error('[torrent]', e.message));

const active = new Map(); // infoHash -> { torrent, lastUsed, ready: Promise }

const VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts|wmv)$/i;

export function getTorrent(infoHash, extraTrackers = []) {
  infoHash = infoHash.toLowerCase();
  let rec = active.get(infoHash);
  if (rec) { rec.lastUsed = Date.now(); return rec.ready; }

  // Evict least recently used torrents.
  while (active.size >= MAX_ACTIVE) {
    const [oldest] = [...active.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    drop(oldest[0]);
  }

  const magnet = `magnet:?xt=urn:btih:${infoHash}` +
    [...new Set([...extraTrackers, ...TRACKERS])].map(t => `&tr=${encodeURIComponent(t)}`).join('');
  rec = { lastUsed: Date.now() };
  rec.ready = new Promise((resolve, reject) => {
    const t = client.add(magnet, { path: path.join(CACHE_DIR, infoHash), deselect: true, ...(PIECE_FILES ? { store: PieceStore } : {}) });
    rec.torrent = t;
    const timer = setTimeout(() => reject(new Error('No peers found for this torrent (timed out). Try another source.')), 60000);
    t.once('ready', () => { clearTimeout(timer); resolve(t); });
    t.once('error', e => { clearTimeout(timer); reject(e); });
  });
  rec.ready.catch(() => drop(infoHash));
  active.set(infoHash, rec);
  return rec.ready;
}

function drop(infoHash) {
  const rec = active.get(infoHash);
  active.delete(infoHash);
  if (rec?.torrent) rec.torrent.destroy({ destroyStore: true }, () => {});
}

setInterval(() => {
  for (const [h, rec] of active) if (Date.now() - rec.lastUsed > IDLE_MS) drop(h);
}, 60000).unref();

// Low-disk guard (TV boxes often have ~8 GB free). Below the limit, stop downloading whole
// files ahead of time; pieces the player is actually reading still download, so playback goes on.
const LOW_DISK = 1.5 * 1024 ** 3;
export function freeDisk() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const s = fs.statfsSync(CACHE_DIR);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // statfs unsupported: no guard
  }
}
let lowDisk = false;
setInterval(() => {
  lowDisk = freeDisk() < LOW_DISK;
  if (!lowDisk) return;
  for (const { torrent } of active.values()) torrent?.files?.forEach(f => f.deselect());
}, 20000).unref();

export function pickFile(torrent, fileIdx, season, episode) {
  const files = torrent.files;
  if (fileIdx != null && files[fileIdx]) return files[fileIdx];
  const videos = files.filter(f => VIDEO.test(f.name));
  if (season && episode) {
    const re = new RegExp(`s0*${season}[ ._-]*e0*${episode}(?!\\d)|(?<!\\d)0*${season}x0*${episode}(?!\\d)`, 'i');
    const m = videos.find(f => re.test(f.name));
    if (m) return m;
  }
  return (videos.length ? videos : files).reduce((a, b) => (b.length > a.length ? b : a));
}

const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t' };

// Express handler: GET /stream/:hash/:idx?s=&e=&tr=
export async function streamHandler(req, res) {
  try {
    const { hash, idx } = req.params;
    const tr = [].concat(req.query.tr || []).filter(t => /^(udp|https?|wss?):\/\//.test(t));
    const torrent = await getTorrent(hash, tr);
    const fileIdx = idx === 'auto' ? null : Number(idx);
    const file = pickFile(torrent, fileIdx, Number(req.query.s) || 0, Number(req.query.e) || 0);
    if (!lowDisk) file.select(); // download the whole file in the background (faster seeking)

    const total = file.length;
    const ext = file.name.split('.').pop().toLowerCase();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('X-File-Name', encodeURIComponent(file.name));

    let start = 0, end = total - 1;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total) { res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end(); }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();

    const rec = active.get(torrent.infoHash);
    const keepAlive = setInterval(() => { if (rec) rec.lastUsed = Date.now(); }, 10000);
    const stream = file.createReadStream({ start, end });
    const pieceLen = torrent.pieceLength;
    const lastPiece = Math.floor((file.offset + end) / pieceLen);
    const ahead = Math.max(MIN_CRITICAL_PIECES, Math.ceil(READ_AHEAD / pieceLen));
    let pos = start, criticalFrom = -1;
    const markCritical = () => {
      const piece = Math.floor((file.offset + pos) / pieceLen);
      if (piece === criticalFrom) return;
      criticalFrom = piece;
      torrent.critical(piece, Math.min(piece + ahead, lastPiece));
    };
    markCritical();
    stream.on('data', chunk => { pos += chunk.length; markCritical(); });
    stream.pipe(res);
    const done = () => { clearInterval(keepAlive); stream.destroy(); };
    res.on('close', done);
    stream.on('error', done);
  } catch (e) {
    if (!res.headersSent) res.status(504).json({ error: e.message });
  }
}

export function status(infoHash) {
  const rec = active.get(String(infoHash).toLowerCase());
  const t = rec?.torrent;
  if (!t) return { state: 'idle' };
  return {
    state: t.ready ? 'ready' : 'connecting',
    peers: t.numPeers,
    downloadSpeed: Math.round(t.downloadSpeed),
    uploadSpeed: Math.round(t.uploadSpeed),
    progress: t.progress,
    name: t.name,
    lowDisk,
  };
}

export function shutdown() {
  client.destroy();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
}
