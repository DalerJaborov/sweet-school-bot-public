'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Bridge, MAX_MEDIA_BYTES } = require('../bridge.cjs');
const USER = '992900000001@c.us';
const SAVED = '992900000002@c.us';
const ACCOUNT = '992900000000@c.us';
const NOW = 1800000000000;

class FakeClient extends EventEmitter {
  constructor() {
    super(); this.info = { wid: { _serialized: ACCOUNT } }; this.sent = [];
    this.contacts = new Map([[SAVED, { id: { _serialized: SAVED }, number: '992900000002', isMyContact: true }], [USER, { id: { _serialized: USER }, number: '992900000001', isMyContact: false }]]);
  }
  async initialize() {}
  async destroy() {}
  async logout() {}
  async getContacts() { return [...this.contacts.values()]; }
  async getContactById(id) { return this.contacts.get(id); }
  async getContactLidAndPhone() { return this.mappings || []; }
  async sendMessage(chatId, text, options) { this.sent.push({ chatId, text, options }); return { id: { _serialized: `out-${this.sent.length}` } }; }
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wa-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new FakeClient();
  const bridge = new Bridge({ stateDir: dir, createClient: () => client, makeQr: async () => 'data:image/png;base64,test', mediaFromUrl: async () => 'media', now: () => NOW, ...options });
  await bridge.start(); await bridge.onReady(client);
  return { bridge, client, dir };
}
function message(id = 'in-1', extra = {}) { return { id: { _serialized: id }, from: USER, timestamp: NOW / 1000, type: 'chat', body: 'Сколько стоит курс?', fromMe: false, ...extra }; }
function request(extra = {}) { return { operationId: 'op-1', chatId: USER, replyToId: 'in-1', text: '50 сомони', purpose: 'reply', ...extra }; }
async function prepare(bridge) { await bridge.resume(); await bridge.onMessage(message()); }

test('initial sync leaves replies paused and no contacts/no identity fail closed', async t => {
  const { bridge, client } = await fixture(t);
  assert.equal(bridge.status().enabled, false);
  await bridge.onMessage(message()); assert.equal(bridge.events().events.length, 0);
  client.contacts.clear(); await assert.rejects(bridge.resume(), /Contact list/);
  assert.equal((await bridge.contactStatus(USER)).blocked, true);
});
test('saved contacts are not retained and remain blocked after removal from book', async t => {
  const { bridge, client } = await fixture(t); await bridge.resume();
  await bridge.onMessage(message('private', { from: SAVED }));
  await bridge.onMessage(message('human-private', { fromMe: true, to: SAVED }));
  assert.equal(bridge.events().events.length, 0);
  client.contacts.get(SAVED).isMyContact = false;
  assert.equal((await bridge.contactStatus(SAVED)).blocked, true);
});
test('old history, groups, statuses, broadcasts and protocol events do not enter queue', async t => {
  const { bridge } = await fixture(t); await bridge.resume();
  for (const extra of [{ timestamp: NOW / 1000 - 1 }, { from: '12345@g.us' }, { isStatus: true }, { broadcast: true }, { type: 'notification' }]) await bridge.onMessage(message(JSON.stringify(extra), extra));
  assert.equal(bridge.events().events.length, 0);
});
test('unknown LID does not masquerade as telephone; resolved alias is blocked', async t => {
  const { bridge, client } = await fixture(t); await bridge.resume();
  const lid = '111111111111111@lid';
  client.contacts.set(lid, { id: { _serialized: lid }, number: '111111111111111', isMyContact: false });
  assert.equal((await bridge.contactStatus(lid)).identityResolved, false);
  client.mappings = [{ lid, pn: SAVED }];
  assert.equal((await bridge.contactStatus(lid)).blocked, true);
});
test('incoming event persists, deduplicates and ack retains reply authority', async t => {
  const { bridge, dir } = await fixture(t); await prepare(bridge); await bridge.onMessage(message());
  assert.equal(bridge.events().events.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).accounts[ACCOUNT].events['in-1'].accountId, ACCOUNT);
  bridge.ack('in-1'); assert.equal(bridge.events().events.length, 0);
  assert.equal((await bridge.send(request())).status, 'sent');
});
test('unsolicited, wrong recipient and expired replies cannot send', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  await assert.rejects(bridge.send(request({ replyToId: 'unseen' })), /incoming/);
  await assert.rejects(bridge.send(request({ chatId: SAVED })), /incoming/);
  bridge.account().events['in-1'].timestamp = NOW - 86400001;
  await assert.rejects(bridge.send(request()), /incoming/); assert.equal(client.sent.length, 0);
});
test('idempotent send returns same receipt; changed body rejected', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  assert.deepEqual(await bridge.send(request()), await bridge.send(request()));
  await assert.rejects(bridge.send(request({ text: 'Different' })), /payload changed/);
  assert.equal(client.sent.length, 1);
});
test('concurrent same operation sends once', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  await Promise.all([bridge.send(request()), bridge.send(request())]); assert.equal(client.sent.length, 1);
});
test('human response permanently stops reply but permits attested course access', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  await bridge.onMessage(message('phone-1', { fromMe: true, to: USER, body: 'Отвечу сама' }));
  await assert.rejects(bridge.send(request()), /taken over/);
  await bridge.send(request({ purpose: 'verified_receipt_access' }));
  assert.equal(client.sent.length, 1); assert.equal(bridge.events().events.find(e => e.type === 'human').text, 'Отвечу сама');
});
test('saving contact during media fetch blocks actual send even access exception', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  bridge.mediaFromUrl = async () => { client.contacts.get(USER).isMyContact = true; return 'media'; };
  await assert.rejects(bridge.send(request({ mediaUrl: 'https://example.com/a', mediaType: 'image', purpose: 'verified_receipt_access' })), /excluded/);
  assert.equal(client.sent.length, 0);
});
test('human response during media fetch cancels normal send', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  bridge.mediaFromUrl = async () => { await bridge.onMessage(message('phone-1', { fromMe: true, to: USER })); return 'media'; };
  await assert.rejects(bridge.send(request({ mediaUrl: 'https://example.com/a', mediaType: 'image' })), /taken over/);
  assert.equal(client.sent.length, 0);
});
test('own echo before send promise resolves is not mistaken for human', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  let echo;
  client.sendMessage = async () => { echo = bridge.onMessage(message('own-1', { fromMe: true, to: USER })); return { id: { _serialized: 'own-1' } }; };
  await bridge.send(request()); await echo;
  assert.equal((await bridge.contactStatus(USER)).takenOver, false);
  assert.equal(bridge.events().events.filter(e => e.type === 'human').length, 0);
});
test('ambiguous transport failure cannot be retried', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  let attempts = 0; client.sendMessage = async () => { attempts++; throw new Error('network response lost'); };
  await assert.rejects(bridge.send(request()), /uncertain/);
  await assert.rejects(bridge.send(request()), /uncertain/); assert.equal(attempts, 1);
});
test('crashed sending state becomes uncertain after restart and blacklist persists', async t => {
  const { bridge, dir, client } = await fixture(t); await prepare(bridge);
  bridge.account().operations.x = { status: 'sending' }; bridge.save();
  const next = new Bridge({ stateDir: dir, createClient: () => client, makeQr: async () => '', mediaFromUrl: async () => '', now: () => NOW });
  await next.start(); await next.onReady(client);
  assert.equal(next.account().operations.x.status, 'uncertain'); assert.equal((await next.contactStatus(SAVED)).blocked, true);
});
test('media bound enforced before download and receipts remain available after takeover', async t => {
  const { bridge } = await fixture(t); await prepare(bridge);
  await bridge.onMessage(message('human', { fromMe: true, to: USER }));
  let downloads = 0;
  await bridge.onMessage(message('large', { type: 'image', hasMedia: true, _data: { size: MAX_MEDIA_BYTES + 1 }, downloadMedia: async () => { downloads++; } }));
  await bridge.onMessage(message('receipt', { type: 'image', hasMedia: true, _data: { size: 3 }, downloadMedia: async () => { downloads++; return { mimetype: 'image/jpeg', data: 'YWJj' }; } }));
  assert.equal(downloads, 1); assert.equal(bridge.events().events.find(e => e.id === 'receipt').media.data, 'YWJj');
});
test('incoming envelope is durable before media network work and hidden until complete', async t => {
  const { bridge, dir } = await fixture(t); await bridge.resume();
  let finish; let began;
  const started = new Promise(resolve => { began = resolve; });
  const download = new Promise(resolve => { finish = resolve; });
  const pending = bridge.onMessage(message('receipt-durable', { type: 'image', hasMedia: true, _data: { size: 3 }, downloadMedia: () => { began(); return download; } }));
  await started;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
  assert.equal(saved.accounts[ACCOUNT].events['receipt-durable'].mediaPending, true);
  assert.equal(bridge.events().events.length, 0);
  finish({ mimetype: 'image/jpeg', data: 'YWJj' }); await pending;
  assert.equal(bridge.events().events.length, 1);
});
test('pause stops receipt exception too; reset takeover never unblocks saved contact', async t => {
  const { bridge } = await fixture(t); await prepare(bridge); bridge.pause();
  await assert.rejects(bridge.send(request({ purpose: 'verified_receipt_access' })), /paused/);
  assert.equal((await bridge.resetTakeover(SAVED)).blocked, true);
});
test('changing connected account isolates history and preferences', async t => {
  const { bridge, client } = await fixture(t); await prepare(bridge);
  client.info.wid._serialized = '992900000099@c.us'; await bridge.onReady(client);
  assert.equal(bridge.status().enabled, false); assert.equal(bridge.events().events.length, 0);
  await assert.rejects(bridge.send(request()), /incoming/);
});

test('pacing: typing state, random gap between sends and caps that fail before dispatch', async t => {
  const sleeps = [];
  const { bridge, client } = await fixture(t, { pacing: { perChatMax: 2, hourMax: 3, dayMax: 4 }, sleep: async ms => { sleeps.push(ms); }, random: () => 0.5 });
  let typing = 0, cleared = 0;
  client.pupPage = { evaluate: async (_fn, _chatId, state) => { if (state === 'typing') typing++; if (state === 'stop') cleared++; return true; } };
  await prepare(bridge);
  await bridge.send(request({ operationId: 'op-a' }));
  assert.equal(client.sent.length, 1); assert.equal(typing, 1); assert.equal(cleared, 1);
  assert.ok(sleeps.some(ms => ms >= 1200 && ms <= 9600), 'a typing pause of 1.2-9.6 s happened');
  await bridge.send(request({ operationId: 'op-b' }));
  await assert.rejects(bridge.send(request({ operationId: 'op-c' })), error => error.status === 429 && /Chat send limit/.test(error.message));
  assert.equal(client.sent.length, 2);
  assert.equal(bridge.account().operations['op-c'], undefined, 'a capped send leaves no uncertain operation behind');
});
test('pacing: typing failures never block the reply, and pacing is off when not configured', async t => {
  const { bridge, client } = await fixture(t, { pacing: {}, sleep: async () => {}, random: () => 0 });
  client.pupPage = { evaluate: async () => { throw new Error('no page'); } };
  client.sendSeen = async () => { throw new Error('no chat'); };
  await prepare(bridge); await bridge.send(request());
  assert.equal(client.sent.length, 1);
});

test('audio goes out as a voice note (ptt) with a recording state and no caption', async t => {
  const { bridge, client } = await fixture(t, { pacing: {}, sleep: async () => {}, random: () => 0.5 });
  let typing = 0, recording = 0;
  client.pupPage = { evaluate: async (_fn, _chatId, state) => { if (state === 'typing') typing++; if (state === 'recording') recording++; return true; } };
  await prepare(bridge);
  await assert.rejects(bridge.send(request({ operationId: 'op-voice-text', text: 'подпись', mediaUrl: 'https://shirinsweets.online/media/a.ogg', mediaType: 'audio' })), /voice note cannot carry text/);
  await bridge.send(request({ operationId: 'op-voice', text: undefined, mediaUrl: 'https://shirinsweets.online/media/a.ogg', mediaType: 'audio' }));
  assert.equal(recording, 1); assert.equal(typing, 0);
  assert.equal(client.sent[0].options.sendAudioAsVoice, true);
  assert.equal(client.sent[0].options.caption, undefined);
});
test('images keep the caption and are not sent as voice', async t => {
  const { bridge, client } = await fixture(t);
  await prepare(bridge);
  await bridge.send(request({ operationId: 'op-img', text: 'подпись', mediaUrl: 'https://shirinsweets.online/media/a.jpg', mediaType: 'image' }));
  assert.equal(client.sent[0].options.caption, 'подпись'); assert.equal(client.sent[0].options.sendAudioAsVoice, undefined);
});
test('pacing: the chat is marked as read before typing starts', async t => {
  const { bridge, client } = await fixture(t, { pacing: {}, sleep: async () => {}, random: () => 0 });
  const order = [];
  client.sendSeen = async () => { order.push('seen'); };
  client.pupPage = { evaluate: async (_fn, _chatId, state) => { if (state !== 'stop') order.push(state); return true; } };
  await prepare(bridge); await bridge.send(request());
  assert.deepEqual(order, ['seen', 'typing']);
});
test('react: only whitelisted emoji on a recent incoming message, idempotent, blocked for saved contacts', async t => {
  const { bridge, client } = await fixture(t);
  const reactions = [];
  client.getMessageById = async id => ({ react: async emoji => { reactions.push({ id, emoji }); } });
  await prepare(bridge);
  await assert.rejects(bridge.react({ operationId: 'r-0', chatId: USER, replyToId: 'in-1', emoji: '👍' }), /Invalid reaction/);
  await assert.rejects(bridge.react({ operationId: 'r-1', chatId: USER, replyToId: 'unknown', emoji: '❤️' }), /recent incoming/);
  assert.deepEqual(await bridge.react({ operationId: 'r-2', chatId: USER, replyToId: 'in-1', emoji: '❤️' }), { operationId: 'r-2', status: 'sent' });
  await bridge.react({ operationId: 'r-2', chatId: USER, replyToId: 'in-1', emoji: '❤️' });
  assert.deepEqual(reactions, [{ id: 'in-1', emoji: '❤️' }]);
  client.contacts.get(USER).isMyContact = true;
  await assert.rejects(bridge.react({ operationId: 'r-3', chatId: USER, replyToId: 'in-1', emoji: '🌸' }), /excluded/);
});

test('pacing: read mark only for ordinary replies and only when not switched off', async t => {
  const { bridge, client } = await fixture(t, { pacing: {}, sleep: async () => {}, random: () => 0 });
  let seen = 0;
  client.sendSeen = async () => { seen++; };
  client.pupPage = { evaluate: async () => true };
  await prepare(bridge);
  await bridge.send(request({ operationId: 'op-s1' })); assert.equal(seen, 1);
  await bridge.send(request({ operationId: 'op-s2', markSeen: false })); assert.equal(seen, 1);
});
test('react: a reaction counts in the anti-ban limits', async t => {
  const { bridge, client } = await fixture(t, { pacing: { perChatMax: 1 }, sleep: async () => {}, random: () => 0 });
  client.getMessageById = async () => ({ react: async () => {} });
  await prepare(bridge);
  await bridge.react({ operationId: 'r-a', chatId: USER, replyToId: 'in-1', emoji: '❤️' });
  await assert.rejects(bridge.send(request({ operationId: 'op-after' })), error => error.status === 429);
});

test('owner test number: saved contact is answered, any other saved contact stays blocked', async t => {
  const { bridge, client } = await fixture(t, { testNumbers: ['+992 900 000 002'] });
  await prepare(bridge); client.mappings = [];
  const status = await bridge.contactStatus(SAVED);
  assert.equal(status.blocked, false); assert.equal(status.isMyContact, false);
  client.contacts.set('992900000009@c.us', { id: { _serialized: '992900000009@c.us' }, number: '992900000009', isMyContact: true });
  const other = await bridge.contactStatus('992900000009@c.us');
  assert.equal(other.blocked, true); assert.equal(other.isMyContact, true);
});

test('start() removes stale Chromium Singleton* locks but never touches session data', async t => {
  const auth = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wa-auth-'));
  t.after(() => fs.rmSync(auth, { recursive: true, force: true }));
  const profile = path.join(auth, 'session-school');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  for (const n of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.symlinkSync('stale-target', path.join(profile, n));
  fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'keep');
  await fixture(t, { authDir: auth });
  assert.deepEqual(fs.readdirSync(profile).filter(n => n.startsWith('Singleton')), []);
  assert.equal(fs.readFileSync(path.join(profile, 'Default', 'Cookies'), 'utf8'), 'keep');
});

test('lock cleanup is a no-op without auth dir or profile', async t => {
  const { bridge } = await fixture(t);
  assert.equal(bridge.clearBrowserLocks(), 0);
  assert.equal(new Bridge({ stateDir: os.tmpdir(), authDir: path.join(os.tmpdir(), 'nope-wa'), createClient: () => null }).clearBrowserLocks(), 0);
});
