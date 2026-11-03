// Startup options: command-line flags (--port=, --host=, --cache-dir=), then environment variables.
// The Android app passes flags, since environment changes made from Java don't reliably reach Node.
import os from 'node:os';
import path from 'node:path';

const flag = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const options = {
  port: Number(flag('port') || process.env.PORT) || 7070,
  host: flag('host') || process.env.HOST || '0.0.0.0',
  cacheDir: flag('cache-dir') || process.env.CINEMOY_CACHE || path.join(os.tmpdir(), 'cinemoy-cache'),
  // Fixed peer port (TCP + UDP), so Docker/routers can forward it; 0 = random.
  torrentPort: Number(flag('torrent-port') || process.env.CINEMOY_TORRENT_PORT) || 0,
  // Upload cap in KB/s (-1 = unlimited). A saturated upload starves the download on home links.
  uploadLimit: Number(flag('upload-limit') || process.env.CINEMOY_UPLOAD_LIMIT || 200),
};
