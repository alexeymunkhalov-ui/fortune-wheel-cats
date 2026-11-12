// Сервер колеса фортуны: раздаёт страницу и синхронизирует комнаты (зрители = коты, общее колесо, общий результат).
// Без зависимостей: node server.js  (порт — переменная PORT, по умолчанию 8765)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 8765, TAU = Math.PI * 2, MIN = 2, MAX = 24, MAX_PLAYERS = 60;
const PAGE = path.join(__dirname, 'fortune-wheel.html');
const HEX = /^#[0-9a-f]{6}$/i, HATS = ['cone', 'top', 'crown', 'none'];
const PALETTE = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#2ec4b6', '#3a86ff', '#8338ec', '#ff006e', '#06d6a0'];
const rooms = new Map();

// Бот: ответ на /start с кнопкой «Открыть». Включается, если задана переменная BOT_TOKEN (токен из @BotFather).
const BOT_TOKEN = process.env.BOT_TOKEN || '', TG_API = process.env.TG_API || 'https://api.telegram.org';
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const HOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update('hook:' + BOT_TOKEN).digest('hex') : '';
const HELLO = 'Привет! Это колесо фортуны с танцующими котами 🎡🐱\n\nЖми «Открыть», настраивай позиции и зови друзей — каждый, кто зайдёт, появится в комнате своим котом.';
let botName = '';
const tg = (method, body) => fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(r => r.json()).catch(() => ({ ok: false }));
function onUpdate(up) {
  const m = up && up.message; if (!m || !m.chat || !/^\/start(@\w+)?(\s|$)/.test(m.text || '')) return;
  // Кнопка web_app работает только в личном чате; в группах даём обычную ссылку на приложение.
  const btn = m.chat.type === 'private' ? { text: '🎡 Открыть', web_app: { url: APP_URL + '/' } } : { text: '🎡 Открыть', url: `https://t.me/${botName}?startapp` };
  tg('sendMessage', { chat_id: m.chat.id, text: HELLO, reply_markup: { inline_keyboard: [[btn]] } });
}
async function startBot() {
  if (!BOT_TOKEN || !APP_URL) return;
  const me = await tg('getMe'); if (!me.ok) return console.log('Бот: токен не подошёл, /start работать не будет');
  botName = me.result.username;
  const r = await tg('setWebhook', { url: APP_URL + '/tg', secret_token: HOOK_SECRET, allowed_updates: ['message'] });
  console.log(r.ok ? `Бот @${botName}: /start подключён` : 'Бот: не удалось подключить /start');
}

// Скрытый режим «караоке»: комнаты с именем на karaoke… — на колесе песни, у каждой могут быть ролик и слова (их присылает ведущий).
const KAR_SONGS = ['Милый ублюдок', 'Я тебя могну', 'Да, я твоя шалава', 'Не бойся ночи, ведь я рядом', 'Ворона', 'Династия', 'Банька-парилка', 'Егор Крид в гей-клубе'];
const karItems = songs => songs.map((x, i) => ({ text: x.title, color: PALETTE[i % PALETTE.length] }));
const cleanSongs = a => Array.isArray(a) && a.length >= MIN && a.length <= MAX
  ? a.map(x => ({ title: String((x && x.title) || '').slice(0, 40) || 'Песня', yt: String((x && x.yt) || '').slice(0, 200), text: String((x && x.text) || '').slice(0, 8000) })) : null;
function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, fresh: true, remove: false, rot: 0, spin: null, game: null, pending: -1, timer: null, gc: null, players: new Map(),
      items: ['Пицца', 'Суши', 'Бургер', 'Паста', 'Шаурма', 'Рамен', 'Плов', 'Салат'].map((text, i) => ({ text, color: PALETTE[i] })) };
    if (/^karaoke/.test(id)) { r.kar = KAR_SONGS.map(title => ({ title, yt: '', text: '' })); r.items = karItems(r.kar); r.remove = true; r.fresh = false; }
    rooms.set(id, r);
  }
  return r;
}
const col = (v, d) => HEX.test(v) ? v : d;
const cleanCat = c => ({
  name: String((c && c.name) || 'Кот').slice(0, 16), fur: col(c && c.fur, '#f2a03d'), belly: col(c && c.belly, '#fff1d6'), hat: col(c && c.hat, '#3df0ff'),
  hatStyle: HATS.includes(c && c.hatStyle) ? c.hatStyle : 'cone', glasses: !!(c && c.glasses), size: Math.min(1.5, Math.max(.5, +(c && c.size) || 1)),
});
const cleanItems = a => Array.isArray(a) && a.length >= MIN && a.length <= MAX
  ? a.map(i => ({ text: String((i && i.text) || '').slice(0, 40), color: col(i && i.color, '#888888') })) : null;
const send = (res, type, data) => res.write(`data: ${JSON.stringify(Object.assign({ type }, data))}\n\n`);
const broadcast = (r, type, data) => { for (const p of r.players.values()) send(p.res, type, data); };
const playerList = r => [...r.players].map(([id, p]) => Object.assign({ id }, p.cat));
const sendPlayers = r => broadcast(r, 'players', { players: playerList(r) });
const sendItems = (r, by) => broadcast(r, 'items', { items: r.items, remove: r.remove, by });

function applyRemove(r) {
  clearTimeout(r.timer);
  if (r.pending >= 0 && r.items.length > MIN) { r.items.splice(r.pending, 1); sendItems(r, null); }
  r.pending = -1;
}
// Мини-игры: исход выбирает сервер, чтобы у всех зрителей он был одинаковый. Длительности совпадают с клиентскими.
const REACTS = ['tomato', 'heart', 'jump', 'meow'];
function startGame(r, kind) {
  const ids = [...r.players.keys()]; if (!ids.length) return;
  let data, dur;
  if (kind === 'race') {
    const runners = ids.map(id => ({ id, t: Math.round(6000 + Math.random() * 3000), k: 1 + Math.floor(Math.random() * 3), s: Math.random() < .5 ? -1 : 1 }));
    data = { runners }; dur = 1500 + Math.max(...runners.map(x => x.t)) + 2500;
  } else {
    data = { order: ids, target: ids[Math.floor(Math.random() * ids.length)], turns: 4 + Math.floor(Math.random() * 3), dur: Math.round(5000 + Math.random() * 1500) };
    dur = 1200 + data.dur + 3000;
  }
  r.game = { kind, data, start: Date.now() };
  broadcast(r, 'game', { kind, data });
  setTimeout(() => { r.game = null; }, dur);
}
function act(r, pid, m) {
  const p = r.players.get(pid); if (!p) return;
  if (m.type === 'cat') {
    const cat = cleanCat(m.cat);
    if (JSON.stringify(cat) !== JSON.stringify(p.cat)) { p.cat = cat; sendPlayers(r); }
  } else if (m.type === 'kar' && r.kar && !r.spin) {
    const songs = cleanSongs(m.songs); if (!songs) return;
    const same = songs.length === r.kar.length && songs.every((x, i) => x.title === r.kar[i].title);
    r.kar = songs; broadcast(r, 'kar', { songs, by: pid });
    if (m.reset || !same) { clearTimeout(r.timer); r.pending = -1; r.items = karItems(songs); sendItems(r, null); }   // список изменился или ведущий вернул все песни
  } else if (m.type === 'items' && !r.spin && !r.kar) {
    const items = cleanItems(m.items); if (!items) return;
    clearTimeout(r.timer); r.pending = -1;
    r.items = items; r.remove = !!m.remove; sendItems(r, pid);
  } else if (m.type === 'spin' && !r.spin && !r.game) {
    applyRemove(r);
    const from = r.rot, to = from + TAU * (5 + Math.floor(Math.random() * 3)) + Math.random() * TAU, dur = 6000 + Math.random() * 1500;
    r.spin = { from, to, dur, start: Date.now() };
    broadcast(r, 'spin', { from, to, dur });
    setTimeout(() => {
      r.rot = to % TAU; r.spin = null;
      if (r.remove && r.items.length > MIN) {
        const th = (((r.rot - Math.PI / 2) % TAU) + TAU) % TAU;
        r.pending = Math.min(r.items.length - 1, Math.floor(th / (TAU / r.items.length)));
        r.timer = setTimeout(() => applyRemove(r), 5000);
      }
    }, dur);
  } else if ((m.type === 'race' || m.type === 'bottle') && !r.spin && !r.game) startGame(r, m.type);
  else if (m.type === 'react' && REACTS.includes(m.kind)) {
    const now = Date.now(); if (now - (p.rt || 0) < 200) return; p.rt = now;
    broadcast(r, 'react', { id: pid, kind: m.kind });
  } else if (m.type === 'hype') {
    p.hype = Math.min(1, Math.max(0, +m.v || 0)); broadcast(r, 'hype', { id: pid, v: p.hype });
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const rid = (u.searchParams.get('room') || 'main').slice(0, 64), pid = (u.searchParams.get('id') || '').slice(0, 40);

  if (req.method === 'GET' && u.pathname.endsWith('/events') && pid) {
    const r = getRoom(rid);
    if (r.players.size >= MAX_PLAYERS && !r.players.has(pid)) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    clearTimeout(r.gc);
    const old = r.players.get(pid); if (old) old.res.end();
    let cat; try { cat = cleanCat(JSON.parse(u.searchParams.get('cat') || '{}')); } catch (e) { cat = cleanCat({}); }
    const me = { res, cat }; r.players.set(pid, me);
    send(res, 'init', { items: r.items, remove: r.remove, rot: r.rot, fresh: r.fresh, players: playerList(r),
      spin: r.spin && { from: r.spin.from, to: r.spin.to, dur: r.spin.dur, elapsed: Date.now() - r.spin.start },
      game: r.game && { kind: r.game.kind, data: r.game.data, elapsed: Date.now() - r.game.start },
      kar: r.kar || null,
      hype: Object.fromEntries([...r.players].filter(([, q]) => q.hype).map(([id, q]) => [id, q.hype])) });
    r.fresh = false;
    for (const [id, p] of r.players) if (id !== pid) send(p.res, 'players', { players: playerList(r) });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      if (r.players.get(pid) !== me) return;
      r.players.delete(pid); sendPlayers(r);
      if (!r.players.size) r.gc = setTimeout(() => rooms.delete(rid), 3600e3);
    });
    return;
  }
  if (req.method === 'POST' && u.pathname.endsWith('/act') && pid) {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 300000) req.destroy(); });
    req.on('end', () => {
      try { const r = rooms.get(rid); if (r) act(r, pid, JSON.parse(body)); } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/tg' && HOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] === HOOK_SECRET) {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 100000) req.destroy(); });
    req.on('end', () => { try { onUpdate(JSON.parse(body)); } catch (e) {} res.writeHead(200); res.end(); });
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/fortune-wheel.html')) {
    return fs.readFile(PAGE, (err, data) => {
      if (err) { res.writeHead(500); return res.end('no page'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => { console.log(`Колесо фортуны: http://localhost:${PORT}`); startBot(); });
