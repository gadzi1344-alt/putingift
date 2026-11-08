const PRICE = 100;
const PAYLOAD = 'putingift:case:v1:100';

// Rejection sampling avoids modulo bias: every result from 0 to 99 is equally likely.
function roll() {
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= 4294967200);
  return a[0] % 100;
}
function prizes(env) {
  return [env.PRIZE_HEART, env.PRIZE_CRYSTAL, env.PRIZE_CHAMPAGNE, env.PRIZE_NFT];
}
function configured(env) {
  return env.PURCHASES_ENABLED === 'true' && /^@[A-Za-z0-9_]{5,32}$/.test(env.SUPPORT_USERNAME || '') && prizes(env).every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 120);
}
function support(env) { return env.SUPPORT_USERNAME || 'администратору'; }
function details(env) {
  const p = prizes(env);
  return `🎁 PutinGift\n\nОткрытие кейса: ${PRICE} ⭐\n\nВозможные призы:\n• ${p[0] || 'Сердце'} — 33%\n• ${p[1] || 'Кристалл'} — 33%\n• ${p[2] || 'Шампанское'} — 33%\n• ${p[3] || 'NFT-подарок (будет указан перед запуском)'} — 1%\n\nКаждый приз выдаёт администратор вручную. После выигрыша напишите ${support(env)} и укажите номер выигрыша. Выдача не автоматическая.`;
}
async function telegram(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  return result.result;
}
async function send(env, chatId, text, extra = {}) {
  return telegram(env, 'sendMessage', {chat_id: chatId, text, ...extra});
}
function button(env) {
  return configured(env) ? {reply_markup: {inline_keyboard: [[{text: '🎁 Открыть кейс за 100 ⭐', callback_data: 'open_case'}]]}} : {};
}
async function invoice(env, chatId) {
  if (!configured(env)) return send(env, chatId, 'Оплата пока отключена: администратор ещё настраивает выдачу призов.');
  return telegram(env, 'sendInvoice', {
    chat_id: chatId, title: 'Кейс PutinGift',
    description: 'Один случайный приз. Шанс NFT — 1%. Выдача администратором вручную. Подробности — /start.',
    payload: PAYLOAD, currency: 'XTR', prices: [{label: 'Кейс', amount: PRICE}]
  });
}
async function handle(env, update) {
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = configured(env) && q.currency === 'XTR' && q.total_amount === PRICE && q.invoice_payload === PAYLOAD;
    await telegram(env, 'answerPreCheckoutQuery', {pre_checkout_query_id: q.id, ok, ...(!ok ? {error_message: 'Оплата недоступна. Обратитесь в поддержку: /paysupport'} : {})});
    return;
  }
  if (update.callback_query) {
    const q = update.callback_query;
    await telegram(env, 'answerCallbackQuery', {callback_query_id: q.id});
    if (q.data === 'open_case' && q.message?.chat?.type === 'private') await invoice(env, q.message.chat.id);
    return;
  }
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  if (m.successful_payment) {
    const p = m.successful_payment;
    // Once a payment succeeds, record it even if sales were disabled in the meantime.
    if (p.currency !== 'XTR' || p.total_amount !== PRICE || p.invoice_payload !== PAYLOAD || !p.telegram_payment_charge_id || !m.from?.id) {
      console.error('Unexpected successful payment; investigate manually', p.telegram_payment_charge_id || 'unknown');
      return;
    }
    const n = roll();
    const idx = n < 33 ? 0 : n < 66 ? 1 : n < 99 ? 2 : 3;
    const prize = prizes(env)[idx] || ['Сердце', 'Кристалл', 'Шампанское', 'NFT-подарок'][idx];
    const charge = p.telegram_payment_charge_id;
    const orderId = crypto.randomUUID();
    await env.DB.prepare(`INSERT OR IGNORE INTO wins (charge_id, order_id, user_id, username, prize, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(charge, orderId, String(m.from.id), m.from.username || '', prize, new Date().toISOString()).run();
    // If Telegram retries the update, the stored prize is reused, never rerolled.
    const win = await env.DB.prepare('SELECT order_id, prize, user_id FROM wins WHERE charge_id = ?').bind(charge).first();
    if (!win || win.user_id !== String(m.from.id)) throw new Error('Payment record missing or user mismatch');
    await send(env, m.chat.id, `🎉 Выигрыш: ${win.prize}\n\nНомер выигрыша: ${win.order_id}\n\nДля выдачи напишите ${support(env)} и отправьте этот номер. Приз выдаётся вручную.\n\nВаши выигрыши: /prizes`);
    return;
  }
  const text = (m.text || '').trim();
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (command === '/start' || command === '/terms') {
    await send(env, m.chat.id, details(env) + (configured(env) ? '' : '\n\n⚠️ Покупка временно отключена.'), button(env));
  } else if (command === '/open') {
    await invoice(env, m.chat.id);
  } else if (command === '/paysupport') {
    await send(env, m.chat.id, `По вопросам оплаты и выдачи напишите ${support(env)}. Укажите номер выигрыша из /prizes.`);
  } else if (command === '/prizes') {
    const rows = await env.DB.prepare('SELECT order_id, prize, created_at FROM wins WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(String(m.from.id)).all();
    const list = rows.results || [];
    await send(env, m.chat.id, list.length ? 'Ваши последние выигрыши:\n\n' + list.map(x => `${x.prize}\nНомер: ${x.order_id}\nДата: ${x.created_at.slice(0, 10)}`).join('\n\n') + `\n\nДля выдачи: ${support(env)}` : 'Выигрышей пока нет. Открыть кейс: /open');
  } else {
    await send(env, m.chat.id, 'Команды: /start — кейс и шансы, /open — открыть кейс, /prizes — мои выигрыши, /paysupport — помощь.');
  }
}
const setupPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PutinGift — настройка</title><style>body{font-family:system-ui;max-width:540px;margin:60px auto;padding:0 20px;line-height:1.5}input,button{font-size:16px;padding:12px;width:100%;box-sizing:border-box}button{margin-top:12px;cursor:pointer}#result{white-space:pre-wrap}</style><h1>Подключение PutinGift</h1><p>Введите SETUP_PASSWORD из секретов Cloudflare. Токен бота сюда вводить не нужно.</p><form id="form"><input id="password" type="password" required autocomplete="off" placeholder="SETUP_PASSWORD"><button>Подключить бота</button></form><p id="result" role="status"></p><script>document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();const out=document.getElementById('result');out.textContent='Подключаем…';try{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});const x=await r.json();out.textContent=x.message;document.getElementById('password').value='';}catch{out.textContent='Ошибка подключения. Проверьте настройки и повторите.'}})</script></html>`;
async function setup(request, env) {
  const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'};
  if (!env.SETUP_PASSWORD || env.SETUP_PASSWORD.length < 32) return new Response('Not found', {status:404, headers});
  if (request.method === 'GET') return new Response(setupPage, {headers: {...headers, 'Content-Type':'text/html; charset=utf-8'}});
  if (request.method !== 'POST') return new Response('Method not allowed', {status:405, headers});
  const json = (message, status=200) => new Response(JSON.stringify({message}), {status, headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
  try {
    if (request.headers.get('content-type') !== 'application/json' || Number(request.headers.get('content-length') || 0) > 4096) return json('Неверный запрос.', 400);
    const {password} = await request.json();
    // Limit length and avoid early exit during the comparison.
    if (typeof password !== 'string' || password.length !== env.SETUP_PASSWORD.length || password.length > 256) return json('Неверный пароль.', 403);
    let difference = 0;
    for (let i=0; i<password.length; i++) difference |= password.charCodeAt(i) ^ env.SETUP_PASSWORD.charCodeAt(i);
    if (difference !== 0) return json('Неверный пароль.', 403);
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.DB) return json('Проверьте секреты BOT_TOKEN, WEBHOOK_SECRET и привязку базы DB.', 400);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wins (charge_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', prize TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS wins_user_created ON wins (user_id, created_at DESC)').run();
    const url = new URL('/', request.url);
    if (url.protocol !== 'https:') return json('Для подключения требуется HTTPS.', 400);
    await telegram(env, 'setWebhook', {url:url.toString(), secret_token:env.WEBHOOK_SECRET, allowed_updates:['message','callback_query','pre_checkout_query']});
    return json('Готово! Бот подключён. Теперь удалите секрет SETUP_PASSWORD в Cloudflare и отправьте боту /start.');
  } catch (e) {
    console.error('Setup failed:', e?.message || 'unknown error');
    return json('Не удалось подключить бота. Проверьте токен, WEBHOOK_SECRET и базу D1.', 500);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/setup') return setup(request, env);
    if (path !== '/') return new Response('Not found', {status:404});
    if (request.method !== 'POST') return new Response('Not found', {status: 404});
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', {status: 403});
    try {
      const update = await request.json();
      await handle(env, update);
      return new Response('OK');
    } catch (err) {
      // Do not log the bot token or complete Telegram request URLs.
      console.error('Update processing failed', err?.message || 'unknown error');
      return new Response('Temporary error', {status: 500});
    }
  }
};
export {roll, configured};
