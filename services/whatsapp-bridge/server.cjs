'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { Bridge, MAX_MEDIA_BYTES } = require('./bridge.cjs');

const token = process.env.SCHOOL_WHATSAPP_TOKEN;
if (!token || token.length < 32) throw new Error('SCHOOL_WHATSAPP_TOKEN must contain at least 32 characters');
const allowedHosts = new Set((process.env.SCHOOL_WHATSAPP_MEDIA_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

async function mediaFromUrl(rawUrl, mediaType) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw Object.assign(new Error('Media host is not approved'), { status: 400 });
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error('Media unavailable');
  if (Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) throw new Error('Media too large');
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim();
  const expected = { image: /^image\/(jpeg|png|webp)$/, audio: /^audio\/[a-z0-9.+-]+$/, video: /^video\/mp4$/, file: /^application\/pdf$/ };
  if (!expected[mediaType]?.test(mimeType)) throw Object.assign(new Error('Unsupported media type'), { status: 400 });
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_MEDIA_BYTES) throw new Error('Media too large');
    chunks.push(chunk);
  }
  return new MessageMedia(mimeType, Buffer.concat(chunks).toString('base64'));
}

const bridge = new Bridge({
  stateDir: process.env.SCHOOL_WHATSAPP_STATE_DIR || '/data/state',
  authDir: process.env.SCHOOL_WHATSAPP_AUTH_DIR || '/data/auth',
  makeQr: qr => QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
  mediaFromUrl,
  testNumbers: (process.env.SCHOOL_WHATSAPP_TEST_NUMBERS || '').split(',').map(x => x.trim()).filter(Boolean),
  pacing: {}, // anti-ban defaults from bridge.cjs: random gaps, typing state, per-chat/hour/day caps
  createClient: () => new Client({
    authStrategy: new LocalAuth({ clientId: 'school', dataPath: process.env.SCHOOL_WHATSAPP_AUTH_DIR || '/data/auth' }),
    deviceName: 'Shirin Sweets assistant',
    takeoverOnConflict: false,
    // Привязка по номеру телефона (когда QR недоступен): задайте SCHOOL_WHATSAPP_PAIR_PHONE цифрами, например 992905355355.
    ...(process.env.SCHOOL_WHATSAPP_PAIR_PHONE ? { pairWithPhoneNumber: { phoneNumber: process.env.SCHOOL_WHATSAPP_PAIR_PHONE.replace(/\D/g, ''), showNotification: true, intervalMs: 180000 } } : {}),
    puppeteer: {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      // Большая адресная книга: getContacts после перезапуска может идти дольше стандартных 3 минут (08.11.2026 дважды упёрлось в таймаут).
      protocolTimeout: 15 * 60 * 1000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  }),
});

function authorized(request) {
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readBody(request) {
  const parts = []; let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const server = http.createServer(async (request, response) => {
  const reply = (code, body) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (!authorized(request)) return reply(401, { error: 'Unauthorized' });
  try {
    const url = new URL(request.url, 'http://bridge');
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /status') return reply(200, bridge.status());
    if (route === 'GET /events') return reply(200, bridge.events());
    if (route === 'GET /contact-status') return reply(200, await bridge.contactStatus(url.searchParams.get('chatId')));
    if (request.method !== 'POST') return reply(404, { error: 'Not found' });
    const body = await readBody(request);
    if (route === 'POST /start') return reply(200, await bridge.start());
    if (route === 'POST /pause') return reply(200, bridge.pause());
    if (route === 'POST /resume') return reply(200, await bridge.resume());
    if (route === 'POST /logout') return reply(200, await bridge.logout());
    if (route === 'POST /send') return reply(200, await bridge.send(body));
    if (route === 'POST /react') return reply(200, await bridge.react(body));
    if (route === 'POST /contacts/block') return reply(200, await bridge.block(body.chatId));
    if (route === 'POST /takeover/reset') return reply(200, await bridge.resetTakeover(body.chatId));
    const ack = url.pathname.match(/^\/events\/(.+)\/ack$/);
    if (ack) return reply(200, bridge.ack(decodeURIComponent(ack[1])));
    return reply(404, { error: 'Not found' });
  } catch (error) {
    const status = Number(error.status) || 500;
    return reply(status, { error: status === 500 ? 'Bridge operation failed' : error.message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT || 4200), '0.0.0.0');

// Saved sessions reconnect without needing another QR. Initial account remains paused until /resume.
void bridge.start().catch(error => bridge.report(error));
const scanTimer = setInterval(() => {
  if (bridge.client && bridge.state === 'disconnected') {
    void bridge.start().catch(error => bridge.report(error));
    return;
  }
  if (bridge.client && bridge.accountId && ['ready', 'paused'].includes(bridge.state)) {
    void bridge.scanContacts().catch(error => bridge.report(error));
  }
}, 60_000);
scanTimer.unref();

let closing = false;
async function close() {
  if (closing) return;
  closing = true; clearInterval(scanTimer);
  // Keep enabled preference and LocalAuth files; never logout on restart.
  bridge.contactsReady = false;
  server.close();
  if (bridge.client) await bridge.client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });

module.exports = { mediaFromUrl };
