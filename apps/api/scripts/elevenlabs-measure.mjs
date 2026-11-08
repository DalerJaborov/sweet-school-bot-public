#!/usr/bin/env node
/**
 * Замер ElevenLabs TTS на таджикских фразах (Node 20+, без зависимостей).
 *
 * Ключ читается ТОЛЬКО из переменной окружения ELEVENLABS_API_KEY.
 * Ключ не печатается и не записывается в файлы.
 *
 * Пример (PowerShell):
 *   $env:ELEVENLABS_API_KEY = "..."   # вводится самим владельцем
 *   node apps/api/scripts/elevenlabs-measure.mjs --voice <id1> --voice <id2> --out ./tg-out
 *
 * Аргументы:
 *   --voice <id>         голос (можно повторять или перечислять через запятую)
 *   --models a,b,c       модели (по умолчанию eleven_v4,eleven_v4_turbo,eleven_v3)
 *   --out <папка>        куда писать mp3 и report.md (по умолчанию ./elevenlabs-measure-out)
 *   --phrases <файл>     файл с фразами (по умолчанию tajik-test-phrases.txt рядом со скриптом)
 *   --price-per-1k <n>   цена за 1000 знаков, USD (по умолчанию 0.08, цена со слов владельца)
 *   --pls <файл.pls>     загрузить словарь произношений и применить
 *   --stability <0..1>   необязательно, переопределяет voice_settings.stability
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elevenlabs.io';
const DEFAULT_MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3'];
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_PRICE = 0.08;
const here = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    voices: [],
    models: DEFAULT_MODELS,
    out: './elevenlabs-measure-out',
    phrases: path.join(here, 'tajik-test-phrases.txt'),
    price: DEFAULT_PRICE,
    priceGiven: false,
    pls: null,
    stability: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Не хватает значения для ${a}`);
      return v;
    };
    switch (a) {
      case '--voice':
        opts.voices.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--models':
        opts.models = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--out':
        opts.out = next();
        break;
      case '--phrases':
        opts.phrases = next();
        break;
      case '--price-per-1k': {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) fail('--price-per-1k должен быть числом');
        opts.price = n;
        opts.priceGiven = true;
        break;
      }
      case '--pls':
        opts.pls = next();
        break;
      case '--stability': {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0 || n > 1) fail('--stability должен быть от 0 до 1');
        opts.stability = n;
        break;
      }
      case '-h':
      case '--help':
        console.log('См. комментарий в начале файла скрипта.');
        process.exit(0);
        break;
      default:
        fail(`Неизвестный аргумент: ${a}`);
    }
  }
  return opts;
}

async function errorText(res) {
  const t = await res.text().catch(() => '');
  return `HTTP ${res.status} ${t.slice(0, 300)}`;
}

async function uploadPls(apiKey, file) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append('name', `measure-${Date.now()}`);
  form.append('file', new Blob([buf], { type: 'application/pls+xml' }), path.basename(file));
  const res = await fetch(`${API}/v1/pronunciation-dictionaries/add-from-file`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  if (!res.ok) fail(`Не удалось загрузить PLS: ${await errorText(res)}`);
  const j = await res.json();
  return { id: j.id, versionId: j.version_id };
}

async function tts(apiKey, { voice, model, text, locators, stability }) {
  const body = { text, model_id: model };
  if (locators) {
    body.pronunciation_dictionary_locators = [
      { pronunciation_dictionary_id: locators.id, version_id: locators.versionId },
    ];
  }
  if (stability !== null) body.voice_settings = { stability };
  const url = `${API}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return Buffer.from(await res.arrayBuffer());
}

const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    fail(
      'Не задана переменная окружения ELEVENLABS_API_KEY. Задайте её в текущем окне терминала и запустите снова (ключ в файлы не пишется).',
    );
  }
  const opts = parseArgs(process.argv.slice(2));
  if (opts.voices.length === 0) fail('Укажите хотя бы один голос: --voice <id>');
  if (opts.models.length === 0) fail('Список моделей пуст');

  const phrases = (await readFile(opts.phrases, 'utf8'))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (phrases.length === 0) fail(`В ${opts.phrases} нет фраз`);

  await mkdir(opts.out, { recursive: true });
  const locators = opts.pls ? await uploadPls(apiKey, opts.pls) : null;

  const rows = [];
  for (const model of opts.models) {
    for (const voice of opts.voices) {
      for (let i = 0; i < phrases.length; i++) {
        const text = phrases[i];
        const chars = [...text].length;
        const file = `${safe(model)}__${safe(voice)}__${String(i + 1).padStart(2, '0')}.mp3`;
        const row = { model, voice, n: i + 1, chars, file, ok: false, ms: 0, bytes: 0, error: '' };
        const t0 = Date.now();
        try {
          const audio = await tts(apiKey, { voice, model, text, locators, stability: opts.stability });
          await writeFile(path.join(opts.out, file), audio);
          row.ok = true;
          row.bytes = audio.length;
        } catch (e) {
          row.error = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 200);
        }
        row.ms = Date.now() - t0;
        rows.push(row);
        console.log(
          `${row.ok ? 'OK ' : 'ERR'} ${model} ${voice} #${row.n} ${row.ok ? `${row.bytes} B, ${row.ms} ms` : row.error}`,
        );
      }
    }
  }

  const cost = (c) => ((c / 1000) * opts.price).toFixed(4);
  const priceNote = opts.priceGiven ? '(задана параметром)' : '(цена со слов владельца, не проверена по счёту)';
  const lines = [
    '# Замер ElevenLabs, таджикский',
    '',
    `Дата: ${new Date().toISOString()}`,
    `Формат: ${OUTPUT_FORMAT}. Словарь произношений: ${opts.pls ? path.basename(opts.pls) : 'нет'}. Stability: ${opts.stability ?? 'по умолчанию голоса'}.`,
    `Цена за 1000 знаков: $${opts.price} ${priceNote}.`,
    '',
    '| Модель | Голос | Фраза | Знаков | Оценка цены, $ | Время, мс | Статус | Файл |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const status = r.ok ? 'OK' : `ошибка: ${r.error.replace(/\|/g, '/')}`;
    lines.push(`| ${r.model} | ${r.voice} | ${r.n} | ${r.chars} | ${cost(r.chars)} | ${r.ms} | ${status} | ${r.ok ? r.file : '-'} |`);
  }
  lines.push('', '## Итого по моделям', '', '| Модель | Успешных | Знаков | Оценка цены, $ |', '|---|---|---|---|');
  let total = 0;
  for (const model of opts.models) {
    const all = rows.filter((r) => r.model === model);
    const ok = all.filter((r) => r.ok);
    const c = ok.reduce((s, r) => s + r.chars, 0);
    total += c;
    lines.push(`| ${model} | ${ok.length}/${all.length} | ${c} | ${cost(c)} |`);
  }
  lines.push('', `Всего знаков (успешные): ${total}, оценка: $${cost(total)}.`, '', 'Оценка качества (на слух носителем): заполнить вручную.');
  await writeFile(path.join(opts.out, 'report.md'), lines.join('\n') + '\n', 'utf8');
  console.log(`Готово. Отчёт: ${path.join(opts.out, 'report.md')}`);
  if (rows.every((r) => !r.ok)) process.exit(2);
}

main().catch((e) => fail(`Сбой: ${String((e && e.message) || e)}`));
