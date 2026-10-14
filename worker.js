const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const MENU = [
  [['➕ افزودن کانال', 'add'], ['🗑 حذف کانال', 'del']],
  [['📋 لیست کانال‌ها', 'list'], ['🔴🟢 فعال/غیرفعال', 'tog']],
  [['🎯 تنظیم کانال مقصد', 'dest'], ['⚙️ تنظیمات', 'set']],
  [['📊 وضعیت آخرین بررسی', 'stat']],
];

async function bale(env, method, body) {
  const r = await fetch(`https://tapi.bale.ai/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'پاسخ نامعتبر از بله' }));
  if (!j.ok) throw new Error(j.description || 'HTTP ' + r.status);
  return j.result;
}

const kv = async (env, k, d) => (await env.DB.get(k, 'json')) ?? d;
const save = (env, k, v, o) => env.DB.put(k, JSON.stringify(v), o);
const getCfg = async (env) => ({ footer: true, media: true, ...(await kv(env, 'cfg', {})) });
const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) });
const say = (env, chat, text, rows) => bale(env, 'sendMessage', { chat_id: chat, text, ...(rows ? { reply_markup: kb(rows) } : {}) });
const menu = (env, chat, t = '🤖 پنل مدیریت') => say(env, chat, t, MENU);
const fmt = (t) => new Date(t).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
const chunks = (t, n = 4000) => { const a = []; for (let i = 0; i < t.length; i += n) a.push(t.slice(i, i + n)); return a; };

function dec(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

const txt = (h) => dec(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')).trim();

async function page(name) {
  const r = await fetch('https://t.me/s/' + name, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
  if (!r.ok) throw new Error('خطای تلگرام ' + r.status);
  return r.text();
}

function parse(html, name) {
  const map = new Map();
  for (const p of html.split('data-post="').slice(1)) {
    const m = p.match(/^([^"\/]+)\/(\d+)"/);
    if (!m || m[1].toLowerCase() !== name.toLowerCase()) continue;
    const id = +m[2];
    const t = p.match(/js-message_text[^>]*>([\s\S]*?)<\/div>/);
    const ph = p.match(/tgme_widget_message_photo_wrap[^>]*url\('([^']+)'\)/);
    const vd = p.match(/<video[^>]*src="([^"]+)"/);
    let text = t ? txt(t[1]) : '';
    if (!vd && /tgme_widget_message_video/.test(p)) text += `\n\nhttps://t.me/${name}/${id}`;
    map.set(id, { id, text: text.trim(), photo: ph ? dec(ph[1]) : '', video: vd ? dec(vd[1]) : '' });
  }
  return [...map.values()].sort((a, b) => a.id - b.id);
}

async function send(env, dest, cfg, p, name) {
  const text = (p.text + (cfg.footer ? `\n\n📌 منبع: @${name}` : '')).trim();
  if (!p.text && !p.photo && !p.video) return;
  let sent = false;
  const cap = text.length <= 1000 ? text : '';
  if (cfg.media && (p.photo || p.video)) {
    try {
      const v = !!p.video;
      await bale(env, v ? 'sendVideo' : 'sendPhoto', { chat_id: dest, [v ? 'video' : 'photo']: v ? p.video : p.photo, caption: cap });
      sent = true;
    } catch (e) {
      if (!text) throw e;
    }
  }
  if (sent && cap) return;
  if (!text) return;
  for (const c of chunks(text)) await bale(env, 'sendMessage', { chat_id: dest, text: c });
}

async function run(env) {
  const cfg = await getCfg(env);
  const dest = cfg.dest || env.DEST_CHAT;
  const prev = await kv(env, 'status', {});
  const chans = await kv(env, 'chans', {});
  const res = {};
  const upd = {};
  if (!dest) {
    res._ = { sent: 0, err: 'کانال مقصد تنظیم نشده' };
  } else {
    for (const n of Object.keys(chans).filter((x) => chans[x].on)) {
      const c = { ...chans[n] };
      let sent = 0;
      let err = '';
      try {
        const posts = parse(await page(n), n).filter((p) => p.id > c.last).slice(0, 10);
        for (const p of posts) {
          if (await env.DB.get(`sent:${n}:${p.id}`)) { c.last = p.id; continue; }
          try {
            await send(env, dest, cfg, p, n);
            await env.DB.put(`sent:${n}:${p.id}`, '1', { expirationTtl: 604800 });
            c.last = p.id;
            c.fail = 0;
            sent++;
          } catch (e) {
            c.fail = (c.fail || 0) + 1;
            err = `پست ${p.id}: ${e.message}`;
            if (c.fail >= 3) { c.last = p.id; c.fail = 0; err += ' (رد شد)'; }
            break;
          }
        }
      } catch (e) {
        err = e.message;
      }
      res[n] = { sent, err };
      if (c.last !== chans[n].last || (c.fail || 0) !== (chans[n].fail || 0)) upd[n] = c;
    }
  }
  if (Object.keys(upd).length) {
    const cur = await kv(env, 'chans', {});
    for (const n in upd) if (cur[n]) { cur[n].last = upd[n].last; cur[n].fail = upd[n].fail; }
    await save(env, 'chans', cur);
  }
  if (JSON.stringify(res) !== JSON.stringify(prev.res) || Date.now() - (prev.t || 0) > 600000) {
    await save(env, 'status', { t: Date.now(), res });
  }
}

function normName(s) {
  return s.trim().replace(/^(https?:\/\/)?(t\.me\/(s\/)?)?@?/i, '').split(/[\/?#\s]/)[0].toLowerCase();
}

async function addChan(env, chat, input) {
  const n = normName(input);
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(n)) return say(env, chat, '❌ username نامعتبر است. مثال: @channelname');
  const chans = await kv(env, 'chans', {});
  if (chans[n]) return menu(env, chat, '⚠️ این کانال قبلاً اضافه شده است.');
  let posts;
  try { posts = parse(await page(n), n); } catch (e) { return say(env, chat, '❌ ' + e.message); }
  if (!posts.length) return say(env, chat, '❌ پستی پیدا نشد. کانال باید عمومی باشد و پیش‌نمایش وب (t.me/s) داشته باشد.');
  chans[n] = { on: true, last: posts[posts.length - 1].id, fail: 0 };
  await save(env, 'chans', chans);
  await env.DB.delete('st:' + chat);
  return menu(env, chat, `✅ @${n} اضافه شد.\nفقط پست‌های بعد از شماره ${chans[n].last} ارسال می‌شوند.`);
}

async function setDest(env, chat, input) {
  const d = input.trim();
  if (!/^(@[A-Za-z0-9_]{3,}|-?\d+)$/.test(d)) return say(env, chat, '❌ شناسه نامعتبر. @username یا شناسه عددی کانال را بفرستید.');
  try {
    await bale(env, 'sendMessage', { chat_id: d, text: '✅ اتصال ربات به این کانال برقرار شد.' });
  } catch (e) {
    return say(env, chat, `❌ ارسال به این کانال ممکن نیست: ${e.message}\nربات را در کانال بله ادمین کنید و دوباره تلاش کنید.`);
  }
  const cfg = await kv(env, 'cfg', {});
  cfg.dest = d;
  await save(env, 'cfg', cfg);
  await env.DB.delete('st:' + chat);
  return menu(env, chat, '✅ کانال مقصد ذخیره شد: ' + d);
}

async function togScreen(env, chat) {
  const chans = await kv(env, 'chans', {});
  const names = Object.keys(chans);
  if (!names.length) return menu(env, chat, 'هنوز کانالی اضافه نشده است.');
  const rows = names.map((n) => [[`${chans[n].on ? '🟢' : '🔴'} @${n}`, 'tg:' + n]]);
  rows.push([['🔙 منو', 'menu']]);
  return say(env, chat, 'برای تغییر وضعیت، روی کانال بزنید:', rows);
}

async function setScreen(env, chat) {
  const c = await getCfg(env);
  return say(env, chat, '⚙️ تنظیمات', [
    [[`📌 درج منبع: ${c.footer ? 'روشن' : 'خاموش'}`, 'st:footer']],
    [[`🖼 ارسال مدیا: ${c.media ? 'روشن' : 'خاموش'}`, 'st:media']],
    [['🔙 منو', 'menu']],
  ]);
}

async function action(env, chat, d) {
  const chans = await kv(env, 'chans', {});
  const names = Object.keys(chans);
  if (d === 'menu') { await env.DB.delete('st:' + chat); return menu(env, chat); }
  if (d === 'add') { await save(env, 'st:' + chat, { a: 'add' }, { expirationTtl: 600 }); return say(env, chat, 'username کانال تلگرام را بفرستید. مثال:\n@channelname'); }
  if (d === 'dest') {
    const cfg = await getCfg(env);
    await save(env, 'st:' + chat, { a: 'dest' }, { expirationTtl: 600 });
    return say(env, chat, `مقصد فعلی: ${cfg.dest || env.DEST_CHAT || 'تنظیم نشده'}\n\nشناسه کانال بله را بفرستید (@username یا عدد). ربات باید ادمین کانال باشد.`);
  }
  if (d === 'list') {
    if (!names.length) return menu(env, chat, 'هنوز کانالی اضافه نشده است.');
    return menu(env, chat, names.map((n) => `${chans[n].on ? '🟢' : '🔴'} @${n} — آخرین پست: ${chans[n].last}`).join('\n'));
  }
  if (d === 'del') {
    if (!names.length) return menu(env, chat, 'هنوز کانالی اضافه نشده است.');
    const rows = names.map((n) => [['🗑 @' + n, 'rm:' + n]]);
    rows.push([['🔙 منو', 'menu']]);
    return say(env, chat, 'کدام کانال حذف شود؟', rows);
  }
  if (d.startsWith('rm:')) {
    delete chans[d.slice(3)];
    await save(env, 'chans', chans);
    return menu(env, chat, '✅ حذف شد.');
  }
  if (d === 'tog') return togScreen(env, chat);
  if (d.startsWith('tg:')) {
    const n = d.slice(3);
    if (chans[n]) { chans[n].on = !chans[n].on; await save(env, 'chans', chans); }
    return togScreen(env, chat);
  }
  if (d === 'set') return setScreen(env, chat);
  if (d.startsWith('st:')) {
    const cfg = await getCfg(env);
    const k = d.slice(3);
    if (k in cfg) { cfg[k] = !cfg[k]; await save(env, 'cfg', cfg); }
    return setScreen(env, chat);
  }
  if (d === 'stat') {
    const s = await kv(env, 'status', null);
    if (!s) return menu(env, chat, 'هنوز بررسی انجام نشده است.');
    const lines = Object.entries(s.res).map(([n, r]) => `${r.err ? '⚠️' : '✅'} ${n === '_' ? '' : '@' + n} ارسال: ${r.sent}${r.err ? '\n   ' + r.err : ''}`);
    return menu(env, chat, `📊 آخرین بررسی: ${fmt(s.t)}\n\n${lines.join('\n') || 'کانال فعالی وجود ندارد.'}`);
  }
}

async function handle(env, u) {
  const m = u.message;
  const cb = u.callback_query;
  const from = (m || cb)?.from?.id;
  const chat = m ? m.chat.id : cb?.message?.chat?.id;
  if (!from || !chat) return;
  const admins = (env.ADMIN_IDS || '').split(',').map((x) => x.trim());
  if (!admins.includes(String(from))) {
    if (m) await say(env, chat, '⛔ دسترسی ندارید.');
    return;
  }
  if (cb) {
    await bale(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    return action(env, chat, cb.data || 'menu');
  }
  const t = (m.text || '').trim();
  if (!t || t === '/start' || t === '/menu') { await env.DB.delete('st:' + chat); return menu(env, chat); }
  const st = await kv(env, 'st:' + chat, null);
  if (st?.a === 'add') return addChan(env, chat, t);
  if (st?.a === 'dest') return setDest(env, chat, t);
  return menu(env, chat);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const sec = env.WEBHOOK_SECRET;
    if (u.pathname === '/hook/' + sec && req.method === 'POST') {
      try { await handle(env, await req.json()); } catch (e) {}
      return new Response('ok');
    }
    if (u.pathname === '/setup/' + sec) {
      try {
        const r = await bale(env, 'setWebhook', { url: u.origin + '/hook/' + sec });
        return new Response('webhook set: ' + JSON.stringify(r));
      } catch (e) {
        return new Response('error: ' + e.message, { status: 500 });
      }
    }
    if (u.pathname === '/run/' + sec) {
      await run(env);
      return new Response('done');
    }
    return new Response('ok');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
