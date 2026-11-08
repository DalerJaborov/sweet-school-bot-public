'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_PENDING = 100;
const REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const idOf = value => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value._serialized === 'string' && value._serialized) return value._serialized;
  // WhatsApp Web 2.3000.x minifier renamed `_serialized` to `$1` (wwebjs PR #201910, not released upstream).
  if (typeof value.$1 === 'string' && value.$1) return value.$1;
  // whatsapp-web.js >= 1.34 may deliver a bare MessageId {fromMe, remote, id} without _serialized.
  const remote = idOf(value.remote);
  if (typeof value.id === 'string' && remote) return `${value.fromMe ? 'true' : 'false'}_${remote}_${value.id}`;
  if (typeof value.user === 'string' && typeof value.server === 'string') return `${value.user}@${value.server}`;
  return undefined;
};
const directId = id => typeof id === 'string' && /^\d{7,20}@(c\.us|lid)$/.test(id);
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Anti-ban pacing for outgoing replies (opt-in via constructor, enabled in server.cjs):
 * a random gap between any two sends, a "typing…" state proportional to the text length, and
 * hard caps per chat, per hour and per day. Caps fail BEFORE dispatch (no operation is recorded),
 * so a capped message is safe to hand to a human instead of being retried blindly.
 */
const DEFAULT_PACING = {
  minGapMs: 4000, maxGapMs: 9000,
  typingMinMs: 1500, typingMaxMs: 8000, typingMsPerChar: 40,
  recordMinMs: 3000, recordMaxMs: 9000,
  perChatWindowMs: 10 * 60 * 1000, perChatMax: 8, hourMax: 40, dayMax: 200,
};
const REACTION_EMOJI = new Set(['❤️', '🌸', '💚', '🤍', '🥰', '😊', '✨', '🌷']);
/** Сколько ждать эхо своей отправки, когда библиотека не вернула id (WA Web 2.3000.105x). */
const ECHO_WAIT_MS = 25_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

class Bridge {
  constructor({ stateDir, authDir = null, createClient, makeQr, mediaFromUrl, testNumbers = [], now = Date.now, pacing = null, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
    // Номера владельца для проверки бота: даже если они сохранены в телефоне Ширин, бот им отвечает (SCHOOL_WHATSAPP_TEST_NUMBERS).
    this.testNumbers = new Set(testNumbers.map(n => String(n).replace(/\D/g, '')).filter(Boolean));
    this.pacing = pacing ? { ...DEFAULT_PACING, ...pacing } : null;
    this.sleep = sleep;
    this.random = random;
    this.lastSendAt = 0;
    this.paceChain = Promise.resolve();
    this.stateDir = stateDir;
    this.authDir = authDir;
    this.createClient = createClient;
    this.makeQr = makeQr;
    this.mediaFromUrl = mediaFromUrl;
    this.now = now;
    this.client = null;
    this.starting = null;
    this.state = 'disconnected';
    this.contactsReady = false;
    this.qrDataUrl = null;
    this.pairingCode = null; // код привязки «по номеру телефона» (вместо QR), живёт ~3 минуты
    this.lastError = null;
    this.accountId = null;
    this.liveSince = this.now();
    this.scanPromise = null;
    this.chatChains = new Map();
    this.sending = new Map();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.filename = path.join(stateDir, 'state.json');
    this.data = fs.existsSync(this.filename)
      ? JSON.parse(fs.readFileSync(this.filename, 'utf8'))
      : { version: 1, accounts: {} };
    if (this.data.version !== 1 || !this.data.accounts) throw new Error('Unsupported bridge state');
    // A transport may have accepted these sends before the previous process died.
    for (const account of Object.values(this.data.accounts)) {
      for (const op of Object.values(account.operations)) if (op.status === 'sending') op.status = 'uncertain';
      for (const event of Object.values(account.events)) {
        if (event.mediaPending) { delete event.mediaPending; event.mediaUnavailable = 'download_interrupted'; }
      }
    }
    this.save();
  }

  save() {
    const temporary = `${this.filename}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.filename);
    try { const dir = fs.openSync(this.stateDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* Windows cannot fsync a directory. */ }
  }

  account() {
    if (!this.accountId) throw failure('WhatsApp account is not ready');
    return this.data.accounts[this.accountId];
  }

  status() {
    const account = this.accountId ? this.data.accounts[this.accountId] : null;
    const digits = this.accountId?.split('@')[0] ?? '';
    return {
      state: this.state, qrDataUrl: this.qrDataUrl, pairingCode: this.pairingCode, accountId: this.accountId,
      accountMasked: digits ? `••••${digits.slice(-4)}` : null,
      contactsReady: this.contactsReady, blockedCount: account ? new Set(Object.keys(account.blocked).map(alias => (account.aliases[alias] || [alias]).find(id => id.endsWith('@c.us')) || alias)).size : 0,
      enabled: !!account?.enabled && this.state === 'ready' && this.contactsReady,
      lastError: this.lastError,
    };
  }

  report(error) {
    this.lastError = String(error?.message || error).slice(0, 180);
    console.error('[wa-error]', String(error?.stack || error?.message || error).slice(0, 600));
  }

  /** Та же ошибка (по ключу) пишется в лог один раз за жизнь процесса и не трогает lastError: косметика, не сбой отправки. */
  reportOnce(key, error) {
    (this.reportedOnce ||= new Set());
    if (this.reportedOnce.has(key)) return;
    this.reportedOnce.add(key);
    console.error('[wa-error]', key, String(error?.stack || error?.message || error).slice(0, 600));
  }

  /** «Печатает…» / «записывает голосовое…» / стоп — напрямую по строковому chatId (см. pace). */
  chatState(chatId, state) {
    const page = this.client?.pupPage;
    if (!page) return Promise.resolve(false);
    return page.evaluate((chatId, state) => { window.WWebJS.sendChatstate(state, chatId); return true; }, chatId, state);
  }

  /**
   * Chromium leaves Singleton* lock files in the profile after an unclean stop; the next
   * launch then refuses to start ("profile in use") and the account looks disconnected.
   * Safe to remove here: start() runs only when no client of ours is alive. Only Singleton*
   * entries are touched - never the session data itself.
   */
  clearBrowserLocks() {
    if (!this.authDir) return 0;
    const dir = path.join(this.authDir, 'session-school');
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (!name.startsWith('Singleton')) continue;
      try { fs.rmSync(path.join(dir, name), { force: true, recursive: false }); removed++; } catch {}
    }
    return removed;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.client && ['pairing', 'starting', 'synchronizing', 'ready', 'paused'].includes(this.state)) return this.status();
    if (this.client) { await this.client.destroy().catch(() => {}); this.client = null; }
    this.state = 'starting'; this.contactsReady = false; this.lastError = null;
    this.clearBrowserLocks();
    const client = this.createClient();
    this.client = client;
    client.on('code', code => { if (this.client === client) { this.pairingCode = String(code); this.state = 'pairing'; this.contactsReady = false; } });
    client.on('qr', qr => { void this.makeQr(qr).then(data => {
      if (this.client === client) { this.qrDataUrl = data; this.state = 'pairing'; this.contactsReady = false; }
    }).catch(e => this.report(e)); });
    client.on('ready', () => { void this.onReady(client).catch(e => { this.report(e); this.state = 'paused'; this.contactsReady = false; }); });
    client.on('auth_failure', () => { this.state = 'auth_failure'; this.contactsReady = false; this.qrDataUrl = null; this.lastError = 'WhatsApp authorization failed'; });
    client.on('disconnected', () => { this.state = 'disconnected'; this.contactsReady = false; this.qrDataUrl = null; this.pairingCode = null; });
    // message_create also includes outgoing phone messages; a single handler avoids duplicate events.
    client.on('message_create', message => {
      if (this.client !== client) return;
      this.trace('message_create', message);
      void this.onMessage(message).catch(error => { this.report(error); this.contactsReady = false; this.state = 'paused'; });
    });
    this.starting = client.initialize().catch(error => { this.report(error); this.state = 'disconnected'; }).finally(() => { this.starting = null; });
    // Browser initialization can wait for QR indefinitely; HTTP should return immediately.
    return this.status();
  }

  async onReady(client) {
    if (this.client !== client) return;
    const accountId = idOf(client.info?.wid);
    if (!directId(accountId)) throw failure('Unable to resolve connected account');
    this.accountId = accountId;
    this.data.accounts[accountId] ||= { enabled: false, blocked: {}, takeovers: {}, aliases: {}, events: {}, operations: {} };
    this.liveSince = this.now();
    this.qrDataUrl = null; this.state = 'synchronizing'; this.contactsReady = false;
    this.save();
    await this.scanContacts();
    this.state = this.account().enabled ? 'ready' : 'paused';
  }

  async aliasesFor(chatId, contact) {
    const aliases = new Set([chatId, idOf(contact?.id)].filter(directId));
    if (idOf(contact?.id)?.endsWith('@c.us') && typeof contact?.number === 'string' && /^\d{7,15}$/.test(contact.number)) aliases.add(`${contact.number}@c.us`);
    const remembered = this.account().aliases[chatId] || [];
    remembered.forEach(id => { if (directId(id)) aliases.add(id); });
    if ([...aliases].some(id => id.endsWith('@lid'))) {
      try {
        const mappings = await this.client.getContactLidAndPhone([...aliases]);
        for (const mapping of mappings) {
          if (directId(mapping.lid)) aliases.add(mapping.lid);
          if (directId(mapping.pn)) aliases.add(mapping.pn);
        }
      } catch { /* A remembered verified mapping is still usable. */ }
    }
    return [...aliases];
  }

  rememberAliases(aliases) {
    for (const alias of aliases) this.account().aliases[alias] = aliases;
  }

  async scanContacts() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.doScan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async doScan() {
    if (!this.client || !this.accountId) throw failure('Account unavailable');
    const accountId = this.accountId;
    try {
      const contacts = await this.client.getContacts();
      if (!Array.isArray(contacts) || contacts.length === 0) throw failure('Contact list has not loaded');
      for (const contact of contacts) {
        const id = idOf(contact.id);
        if (!directId(id) || contact.isMyContact !== true) continue;
        const aliases = await this.aliasesFor(id, contact);
        if (this.accountId !== accountId) throw failure('Account changed during contact synchronization');
        this.rememberAliases(aliases);
        if (this.isTestNumber(aliases)) { for (const alias of aliases) if (this.account().blocked[alias] === 'saved_contact') delete this.account().blocked[alias]; continue; }
        for (const alias of aliases) this.account().blocked[alias] = 'saved_contact';
      }
      this.save(); this.contactsReady = true;
    } catch (error) {
      this.contactsReady = false; this.report(error); throw error;
    }
  }

  isTestNumber(aliases) {
    return aliases.some(id => this.testNumbers.has(String(id).replace(/@.*$/, '')));
  }

  async contactStatus(chatId) {
    const denied = { blocked: true, isMyContact: null, aliases: [], takenOver: false, identityResolved: false };
    if (!directId(chatId) || !this.client || !this.contactsReady || !this.accountId) return denied;
    const accountId = this.accountId;
    try {
      const contact = await this.client.getContactById(chatId);
      if (typeof contact?.isMyContact !== 'boolean' || contact.isMe || contact.isGroup) return denied;
      const aliases = await this.aliasesFor(chatId, contact);
      if (this.accountId !== accountId) return denied;
      const identityResolved = aliases.some(id => /^\d{7,15}@c\.us$/.test(id));
      if (!identityResolved) return { ...denied, aliases };
      this.rememberAliases(aliases);
      const testNumber = this.isTestNumber(aliases);
      if (testNumber) { for (const alias of aliases) if (this.account().blocked[alias] === 'saved_contact') delete this.account().blocked[alias]; }
      else if (contact.isMyContact) for (const alias of aliases) this.account().blocked[alias] = 'saved_contact';
      const blocked = (!testNumber && contact.isMyContact) || aliases.some(id => !!this.account().blocked[id]);
      const takenOver = aliases.some(id => !!this.account().takeovers[id]);
      this.save();
      return { blocked, isMyContact: testNumber ? false : contact.isMyContact, aliases, takenOver, identityResolved };
    } catch (error) { this.report(error); return denied; }
  }

  async block(chatId) {
    const status = await this.contactStatus(chatId);
    if (!directId(chatId) || !this.accountId) throw failure('Unknown contact', 400);
    for (const alias of new Set([chatId, ...status.aliases])) this.account().blocked[alias] ||= 'manual';
    this.save(); return { blocked: true };
  }

  async resetTakeover(chatId) {
    const status = await this.contactStatus(chatId);
    if (!status.identityResolved) throw failure('Contact identity unavailable');
    for (const alias of status.aliases) delete this.account().takeovers[alias];
    this.save(); return { reset: true, blocked: status.blocked };
  }

  pause() {
    if (this.accountId) { this.account().enabled = false; this.save(); }
    if (this.client && this.contactsReady) this.state = 'paused';
    return this.status();
  }

  async resume() {
    if (!this.contactsReady || !['ready', 'paused'].includes(this.state)) throw failure('Contacts must load before enabling replies');
    await this.scanContacts();
    this.account().enabled = true; this.save(); this.state = 'ready'; return this.status();
  }

  async logout() {
    this.pause();
    const client = this.client;
    this.contactsReady = false; this.qrDataUrl = null; this.state = 'disconnected';
    if (client) { await client.logout(); await client.destroy().catch(() => {}); }
    this.client = null; this.accountId = null;
    return this.status();
  }

  /** Диагностика без личных данных: тип, направление, последние 4 цифры чата и причина отбрасывания (08.11.2026, «сообщение не доходит»). */
  trace(reason, message) {
    try {
      const chat = String((message.fromMe ? message.to : message.from) || '');
      const ageS = Math.round((this.now() - Number(message.timestamp) * 1000) / 1000);
      const sinceLiveS = Math.round((Number(message.timestamp) * 1000 - this.liveSince) / 1000);
      console.log(`[wa-trace] ${reason} type=${message.type} fromMe=${!!message.fromMe} chat=*${chat.replace(/@.*$/, '').slice(-4)}${chat.endsWith('@lid') ? '(lid)' : ''} ageS=${ageS} afterLiveS=${sinceLiveS} status=${!!message.isStatus} broadcast=${!!message.broadcast} ready=${this.contactsReady} state=${this.state} enabled=${this.accountId ? !!this.account().enabled : 'n/a'}`);
    } catch { /* диагностика не должна ломать приём */ }
  }

  /** whatsapp-web.js reads `this.id._serialized` inside downloadMedia/reload; restore it when WhatsApp Web only gave `$1`. */
  normalizeId(message) {
    const id = message?.id;
    if (id && typeof id === 'object' && !id._serialized) {
      const serialized = idOf(id);
      if (serialized) try { id._serialized = serialized; } catch { /* frozen */ }
    }
  }

  /**
   * Копия Message.downloadMedia() из whatsapp-web.js 1.34.7 с одной правкой: WhatsApp Web 2.3000.105x
   * требует `mimetype` в downloadAndMaybeDecrypt, иначе бросает минифицированное `t: t` (wwebjs issue #201908,
   * PR #201914 не выпущен). Убрать, когда библиотека выйдет с этим исправлением.
   */
  async downloadMediaCompat(message) {
    if (!message.hasMedia) return undefined;
    const msgId = idOf(message.id);
    if (!msgId) throw failure('Message has no id for media download');
    // Без страницы браузера (тесты, заглушки) — обычный путь библиотеки.
    if (!this.client?.pupPage) return (await message.downloadMedia?.()) || undefined;
    const result = await this.client.pupPage.evaluate(async (msgId) => {
      const collections = window.require('WAWebCollections');
      const msg = collections.Msg.get(msgId) || (await collections.Msg.getMessagesById([msgId]))?.messages?.[0];
      if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
      if (msg.mediaData.mediaStage != 'RESOLVED') await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return undefined;
      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const decryptedMedia = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
          mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
          mimetype: msg.mimetype,
          signal: new AbortController().signal, downloadQpl: mockQpl,
        });
        const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
        return { data, mimetype: msg.mimetype, filename: msg.filename, filesize: msg.size };
      } catch (e) {
        if (e && e.status === 404) return undefined;
        throw new Error('downloadAndMaybeDecrypt failed: ' + String(e && (e.message || e.name || e)) + ' stage=' + msg.mediaData.mediaStage + ' mime=' + msg.mimetype);
      }
    }, msgId);
    return result || undefined;
  }

  async onMessage(message) {
    this.normalizeId(message);
    const accountId = this.accountId;
    const messageId = idOf(message.id);
    const chatId = message.fromMe ? message.to : message.from;
    if (message.fromMe && messageId) {
      // Own send whose library promise returned no model: adopt its echo as the message id.
      const waiter = (this.echoWaiters ||= new Map()).get(chatId);
      if (waiter && waiter.matches(message)) waiter.resolve(messageId);
    }
    const timestamp = Number(message.timestamp) * 1000;
    if (!messageId || !directId(chatId) || !Number.isFinite(timestamp)
      || timestamp < Math.floor(this.liveSince / 1000) * 1000 || timestamp > this.now() + 60_000
      || message.isStatus || message.broadcast || !this.contactsReady || !this.accountId) {
      this.trace(`drop:early idShape=${message.id && typeof message.id === 'object' ? Object.keys(message.id).join(',') : typeof message.id} noId=${!messageId} badChat=${!directId(chatId)} badTs=${!Number.isFinite(timestamp)} old=${timestamp < Math.floor(this.liveSince / 1000) * 1000} future=${timestamp > this.now() + 60_000} contacts=${!this.contactsReady} noAccount=${!this.accountId} chatLen=${String(chatId).replace(/@.*$/, '').length} chatSuffix=${String(chatId).replace(/^[^@]*/, '')}`, message);
      return;
    }
    if (message.fromMe) {
      // A library send emits its own echo before its promise returns on some versions.
      const active = this.sending.get(chatId);
      if (active) await active.catch(() => {});
      if (Object.values(this.account().operations).some(op => op.messageId === messageId)) return;
    }
    const status = await this.contactStatus(chatId);
    if (this.accountId !== accountId) return;
    if (status.blocked || !status.identityResolved) { this.trace(`drop:blocked=${status.blocked} resolved=${status.identityResolved}`, message); return; } // Do not retain personal conversations.
    const account = this.account();
    if (account.events[messageId]) return;
    if (message.fromMe) {
      for (const alias of status.aliases) account.takeovers[alias] = this.now();
      this.save();
    } else if (!account.enabled || this.state !== 'ready') { this.trace('drop:paused', message); return; }
    if (!message.fromMe && !['chat', 'image', 'audio', 'ptt', 'document', 'video'].includes(message.type)) return;
    const event = {
      id: messageId, messageId, accountId: this.accountId,
      type: message.fromMe ? 'human' : 'incoming', chatId, timestamp,
      text: typeof message.body === 'string' ? message.body.slice(0, 12000) : '',
    };
    if (!message.fromMe && status.takenOver) event.takenOver = true;
    if (!message.fromMe && message.hasMedia) event.mediaPending = true;
    // Persist the incoming envelope before any network download. A restart keeps
    // the question and marks interrupted media explicitly instead of losing it.
    this.trace('accepted', message);
    this.appendEvent(event);
    if (!message.fromMe && message.hasMedia) {
      const advertisedSize = Number(message._data?.size ?? message._data?.fileSize);
      if (!Number.isFinite(advertisedSize) || advertisedSize <= 0 || advertisedSize > MAX_MEDIA_BYTES) {
        event.mediaUnavailable = 'size_unverified_or_too_large';
      } else if (['image', 'audio', 'ptt'].includes(message.type)) {
        try {
          const media = await this.downloadMediaCompat(message);
          const bytes = media?.data ? Buffer.byteLength(media.data, 'base64') : 0;
          if (bytes > 0 && bytes <= MAX_MEDIA_BYTES && /^(image\/(jpeg|png|webp)|audio\/[a-z0-9.+-]+)$/i.test(String(media.mimetype || "").split(";")[0].trim())) { // voice notes: audio/ogg; codecs=opus
            event.media = { data: media.data, mimeType: String(media.mimetype).split(';')[0].trim().toLowerCase(), filename: media.filename || undefined };
            if (Buffer.byteLength(JSON.stringify(Object.values(account.events).filter(item => !item.ackedAt))) > MAX_EVENT_BYTES) {
              delete event.media; event.mediaUnavailable = 'queue_media_capacity';
            }
          } else { event.mediaUnavailable = 'unsupported_or_too_large'; this.report(new Error('media rejected: bytes=' + bytes + ' mime=' + (media && media.mimetype))); }
        } catch (error) { event.mediaUnavailable = 'download_failed'; this.report(error); }
      } else event.mediaUnavailable = 'unsupported';
    }
    if (this.accountId !== accountId) return;
    delete event.mediaPending;
    this.save();
  }

  appendEvent(event) {
    const account = this.account();
    const now = this.now();
    for (const [id, old] of Object.entries(account.events)) {
      if (old.ackedAt && now - old.timestamp > REPLY_MAX_AGE_MS * 7) delete account.events[id];
    }
    const pending = Object.values(account.events).filter(item => !item.ackedAt);
    if (pending.length >= MAX_PENDING || Buffer.byteLength(JSON.stringify(pending)) + Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
      account.enabled = false; this.state = 'paused'; this.lastError = 'Incoming queue is full; replies paused'; this.save();
      throw failure('Incoming queue capacity exceeded');
    }
    account.events[event.id] = event; this.save();
  }

  events() {
    if (!this.accountId) return { events: [] };
    const events = []; let bytes = 0;
    // One maximum-sized image is ~11 MB as base64. Bound each polling response.
    for (const event of Object.values(this.account().events)) {
      if (event.ackedAt || event.mediaPending) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 12 * 1024 * 1024) break;
      events.push(event); bytes += size;
      if (events.length >= 10) break;
    }
    return { events };
  }

  ack(id) {
    const event = this.account().events[id];
    if (!event) throw failure('Unknown event', 404);
    event.ackedAt = this.now(); delete event.media; this.save(); return { acknowledged: true };
  }

  async send(input) {
    const { operationId, chatId, replyToId, purpose, text, mediaUrl, mediaType, markSeen } = input || {};
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(operationId)
      || !directId(chatId) || typeof replyToId !== 'string' || !['reply', 'verified_receipt_access'].includes(purpose)
      || (typeof text !== 'string' && typeof mediaUrl !== 'string') || (text && text.length > 12000)) throw failure('Invalid send request', 400);
    if (mediaUrl && mediaType === 'audio' && text) throw failure('A voice note cannot carry text; send the text separately', 400);
    const accountId = this.accountId;
    const account = this.account();
    const payloadHash = digest({ chatId, replyToId, purpose, text, mediaUrl, mediaType });
    const previous = account.operations[operationId];
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw failure('Operation payload changed');
      if (previous.status === 'sent') return { operationId, messageId: previous.messageId, status: 'sent' };
      throw failure('Send outcome uncertain; do not retry automatically');
    }
    const previousSend = this.chatChains.get(chatId) || Promise.resolve();
    const task = previousSend.catch(() => {}).then(async () => {
      if (this.accountId !== accountId) throw failure('Account changed');
      const known = account.operations[operationId];
      if (known?.status === 'sent') return { operationId, messageId: known.messageId, status: 'sent' };
      if (known) throw failure('Send outcome uncertain; do not retry automatically');
      const inbound = account.events[replyToId];
      if (!inbound || inbound.type !== 'incoming' || inbound.chatId !== chatId || inbound.accountId !== accountId
        || this.now() - inbound.timestamp > REPLY_MAX_AGE_MS) throw failure('A recent incoming message is required', 403);
      await this.assertSendAllowed(chatId, purpose);
      this.assertWithinLimits(chatId);
      // «Прочитано» только для обычного ответа (не для выдачи доступа по чеку) и если рубильник не выключен
      await this.pace(chatId, (text || '').length, purpose === 'reply' && markSeen !== false, mediaType === 'audio' && Boolean(mediaUrl));
      const content = mediaUrl ? await this.mediaFromUrl(mediaUrl, mediaType) : text;
      // Network/media work may take time. Recheck immediately before dispatch.
      await this.assertSendAllowed(chatId, purpose);
      if (this.accountId !== accountId) throw failure('Account changed');
      const op = { status: 'sending', payloadHash, chatId, replyToId, purpose, createdAt: this.now() };
      account.operations[operationId] = op; this.save();
      let settle;
      const ownSend = new Promise(resolve => { settle = resolve; });
      this.sending.set(chatId, ownSend);
      const echo = (() => {
        // Ждём эхо через this.sleep (подменяется в тестах), а не через голый setTimeout.
        let resolve, done = false; const promise = new Promise((res, rej) => { resolve = res; this.sleep(ECHO_WAIT_MS).then(() => { if (!done) rej(failure('No echo for own send')); }); });
        const matches = m => mediaUrl ? Boolean(m.hasMedia) : (typeof m.body === 'string' && m.body === content);
        const waiter = { matches, resolve: id => { done = true; resolve(id); } };
        (this.echoWaiters ||= new Map()).set(chatId, waiter);
        promise.finally(() => { if (this.echoWaiters.get(chatId) === waiter) this.echoWaiters.delete(chatId); }).catch(() => {});
        return { promise };
      })();
      try {
        // Audio goes out as a real voice note (ptt, waveform bubble), never as a file; voice notes carry no caption.
        const isVoice = Boolean(mediaUrl) && mediaType === 'audio';
        // WA Web 2.3000.x: the library may return undefined OR throw a store error ("Data passed to getter must include an id property")
        // after the message has already left. In both cases the own-message echo is the proof of delivery.
        let sent, sendError;
        try {
          sent = await this.client.sendMessage(chatId, content, { ...(mediaUrl && text && !isVoice ? { caption: text } : {}), ...(isVoice ? { sendAudioAsVoice: true } : {}), sendSeen: false });
        } catch (error) { sendError = error; }
        let messageId = idOf(sent?.id);
        if (!messageId) messageId = await echo.promise.catch(() => undefined);
        if (!messageId && sendError) throw sendError;
        if (!messageId) throw failure(`Transport returned no message ID (sent=${sent ? typeof sent : 'undefined'} id=${sent?.id && typeof sent.id === 'object' ? JSON.stringify(sent.id).slice(0, 200) : typeof sent?.id})`);
        op.status = 'sent'; op.messageId = messageId;
        if (this.pacing) { (account.sendLog ||= []).push({ t: this.now(), chatId }); }
        this.save();
        return { operationId, messageId, status: 'sent' };
      } catch (error) {
        op.status = 'uncertain'; this.save(); this.report(error);
        throw failure('Send outcome uncertain; do not retry automatically');
      } finally { settle(); if (this.sending.get(chatId) === ownSend) this.sending.delete(chatId); }
    });
    this.chatChains.set(chatId, task);
    try { return await task; }
    finally { if (this.chatChains.get(chatId) === task) this.chatChains.delete(chatId); }
  }

  /**
   * Реакция-смайлик на ВХОДЯЩЕЕ сообщение (как ставит живой человек на «спасибо»).
   * Те же замки, что у отправки: свежее входящее в этом чате, контакт не исключён, хозяйка
   * не перехватила разговор. Идемпотентно по operationId. Смайлики — из короткого белого списка.
   */
  async react(input) {
    const { operationId, chatId, replyToId, emoji } = input || {};
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(operationId) || !directId(chatId)
      || typeof replyToId !== 'string' || !REACTION_EMOJI.has(emoji)) throw failure('Invalid reaction request', 400);
    const account = this.account();
    const known = account.operations[operationId];
    if (known?.status === 'sent') return { operationId, status: 'sent' };
    if (known) throw failure('Reaction outcome uncertain; do not retry automatically');
    const inbound = account.events[replyToId];
    if (!inbound || inbound.type !== 'incoming' || inbound.chatId !== chatId || inbound.accountId !== this.accountId
      || this.now() - inbound.timestamp > REPLY_MAX_AGE_MS) throw failure('A recent incoming message is required', 403);
    await this.assertSendAllowed(chatId, 'reply');
    this.assertWithinLimits(chatId); // реакция тоже считается в антибан-лимитах
    account.operations[operationId] = { status: 'sending', chatId, replyToId, purpose: 'reaction', createdAt: this.now() };
    this.save();
    try {
      const message = await this.client.getMessageById(inbound.messageId || replyToId);
      if (!message) throw new Error('Message not found');
      await message.react(emoji);
      account.operations[operationId].status = 'sent';
      if (this.pacing) (account.sendLog ||= []).push({ t: this.now(), chatId });
      this.save();
      return { operationId, status: 'sent' };
    } catch (error) {
      account.operations[operationId].status = 'uncertain'; this.save(); this.report(error);
      throw failure('Reaction outcome uncertain; do not retry automatically');
    }
  }

  assertWithinLimits(chatId) {
    const p = this.pacing; if (!p) return;
    const account = this.account(); const now = this.now();
    account.sendLog = (account.sendLog || []).filter(entry => now - entry.t < DAY_MS);
    if (account.sendLog.length >= p.dayMax) throw failure('Daily send limit reached; hand to a human', 429);
    if (account.sendLog.filter(entry => now - entry.t < HOUR_MS).length >= p.hourMax) throw failure('Hourly send limit reached; hand to a human', 429);
    if (account.sendLog.filter(entry => entry.chatId === chatId && now - entry.t < p.perChatWindowMs).length >= p.perChatMax) throw failure('Chat send limit reached; hand to a human', 429);
  }

  /** Serialises all sends: random gap since the previous send, then a typing indicator sized to the text. */
  pace(chatId, textLength, seen = true, voice = false) {
    const p = this.pacing; if (!p) return Promise.resolve();
    const run = this.paceChain.catch(() => {}).then(async () => {
      const gap = p.minGapMs + this.random() * (p.maxGapMs - p.minGapMs);
      const wait = this.lastSendAt + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      // A voice note shows "recording audio…" for a few seconds, like a person talking into the phone.
      const typingMs = voice
        ? p.recordMinMs + this.random() * (p.recordMaxMs - p.recordMinMs)
        : Math.min(p.typingMaxMs, Math.max(p.typingMinMs, textLength * p.typingMsPerChar)) * (0.8 + this.random() * 0.4);
      // Прочитала → набирает (или записывает голосовое): так делает человек (owner 08.11.2026). Только когда мы отвечаем.
      // WA Web 2.3000.105x: Chat.sendSeen()/sendStateTyping() читают chat.id._serialized, которого больше нет ($1) —
      // поэтому зовём низкоуровневые функции по строковому chatId и не прячем ошибки: каждая — один раз в лог.
      // Пауза «печатает» идёт ВСЕГДА, даже если индикатор не удалось показать: иначе бот отвечает мгновенно.
      if (seen) { try { await this.client.sendSeen(chatId); } catch (error) { this.reportOnce('pace:seen', error); } }
      try { await this.chatState(chatId, voice ? 'recording' : 'typing'); } catch (error) { this.reportOnce('pace:typing', error); }
      await this.sleep(typingMs);
      try { await this.chatState(chatId, 'stop'); } catch { /* cosmetic */ }
      this.lastSendAt = this.now();
    });
    this.paceChain = run;
    return run;
  }

  async assertSendAllowed(chatId, purpose) {
    if (!this.contactsReady || this.state !== 'ready' || !this.account().enabled) throw failure('Replies are paused', 403);
    const status = await this.contactStatus(chatId);
    if (status.blocked || !status.identityResolved) throw failure('Contact is excluded from automation', 403);
    if (status.takenOver && purpose !== 'verified_receipt_access') throw failure('Owner has taken over this chat', 403);
  }
}

module.exports = { Bridge, MAX_MEDIA_BYTES, REPLY_MAX_AGE_MS };
