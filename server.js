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
    r = { id, fresh: true, remove: false, rot: 0, spin: null, game: null, slots: new Map(), pending: -1, timer: null, gc: null, players: new Map(),
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
// Кото-слоты на игровых «рыбках» (никаких денег): у каждого 1000 рыбок и 20 вращений, побеждает тот, у кого рыбок больше.
// SLOT — [вес символа, множитель за три одинаковых]; любая пара даёт ×PAIR. Порядок символов тот же, что на странице.
const SLOT = [[5, 5], [4, 8], [3, 12], [3, 12], [2, 25], [1, 100]], SLOT_W = 18, PAIR = 1.4, FISH = 1000, SPINS = 20;
const rollSym = () => { let x = Math.random() * SLOT_W; for (let i = 0; i < SLOT.length; i++) if ((x -= SLOT[i][0]) < 0) return i; return 0; };
const HANDS = 10;   // раздач блекджека на игру; рыбки у слотов и блекджека общие
const slotTable = r => [...r.slots].map(([id, x]) => ({ id, name: x.name, fish: x.fish, spins: x.spins, hands: x.hands }));
function wallet(r, pid, p) {
  let st = r.slots.get(pid);
  if (!st) { if (r.slots.size >= 200) return null; st = { fish: FISH, spins: SPINS, hands: HANDS, t: 0 }; r.slots.set(pid, st); }
  st.name = p.cat.name; return st;
}
const topFish = live => { const [id, x] = live.reduce((m, y) => y[1].fish > m[1].fish ? y : m); return { id, name: x.name, fish: x.fish }; };
function slotSpin(r, pid, p, bet) {
  const now = Date.now(); bet = Math.floor(+bet);
  const st = wallet(r, pid, p); if (!st) return false;
  if (!(bet >= 1) || bet > st.fish || st.spins <= 0 || now - st.t < 1200) return false;
  st.t = now;
  const reels = [rollSym(), rollSym(), rollSym()], [a, b, c] = reels;
  const mult = a === b && b === c ? SLOT[a][1] : a === b || b === c || a === c ? PAIR : 0, win = Math.floor(bet * mult);
  st.fish += win - bet; st.spins--;
  // игра окончена, когда у всех, кто играл и ещё в комнате, кончились вращения или рыбки
  const live = [...r.slots].filter(([id, x]) => r.players.has(id) && x.spins < SPINS);
  const winner = live.every(([, x]) => x.spins <= 0 || x.fish <= 0) ? topFish(live) : null;
  broadcast(r, 'slot', { id: pid, reels, bet, win, mult, table: slotTable(r), winner });
  return true;
}
// Блекджек: каждый играет свою раздачу против дилера-сервера. Карта — число 0…51: достоинство c % 13 (0 — туз, 10–12 — валет, дама, король).
// Дилер берёт до 17, блекджек с раздачи платит 3:2, можно удвоить на первых двух картах; сплита и страховки нет.
const cardVal = c => { const k = c % 13; return k === 0 ? 11 : k >= 9 ? 10 : k + 1; };
const total = cs => { let t = 0, a = 0; for (const c of cs) { t += cardVal(c); if (c % 13 === 0) a++; } while (t > 21 && a) { t -= 10; a--; } return t; };
const bjView = (h, st) => h ? { player: h.player, dealer: h.state === 'play' ? [h.dealer[0]] : h.dealer, bet: h.bet, state: h.state, delta: h.delta || 0,
  canDouble: h.state === 'play' && h.player.length === 2 && st.fish >= h.bet } : null;
function bjEnd(r, pid, p, st) {
  const h = st.bj, pt = total(h.player), natural = pt === 21 && h.player.length === 2;
  if (pt <= 21 && !natural) while (total(h.dealer) < 17) h.dealer.push(h.deck.pop());
  const dt = total(h.dealer), dn = dt === 21 && h.dealer.length === 2;
  let pay = 0, state = 'lose';
  if (pt > 21) state = 'bust';
  else if (natural && !dn) { pay = Math.floor(h.bet * 2.5); state = 'bj'; }
  else if (dn && !natural) state = 'lose';
  else if (dt > 21 || pt > dt) { pay = h.bet * 2; state = 'win'; }
  else if (pt === dt) { pay = h.bet; state = 'push'; }
  st.fish += pay; st.hands--; h.state = state; h.delta = pay - h.bet; delete h.deck;
  const live = [...r.slots].filter(([id, x]) => r.players.has(id) && x.hands < HANDS);
  const winner = live.every(([, x]) => x.hands <= 0 || x.fish <= 0) ? topFish(live) : null;
  send(p.res, 'bj', { hand: bjView(h, st), fish: st.fish });
  broadcast(r, 'bjend', { id: pid, delta: h.delta, state, table: slotTable(r), winner });
}
function bjAct(r, pid, p, m) {
  const st = wallet(r, pid, p); if (!st) return;
  let h = st.bj;
  const no = () => send(p.res, 'bj', { hand: bjView(h, st), fish: st.fish, no: true });
  if (m.a === 'deal') {
    const bet = Math.floor(+m.bet);
    if ((h && h.state === 'play') || !(bet >= 1) || bet > st.fish || st.hands <= 0) return no();
    const deck = [...Array(52).keys()];
    for (let i = 51; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    st.fish -= bet;   // ставка списывается сразу, выигрыш возвращается в конце раздачи
    h = st.bj = { bet, deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], state: 'play' };
    if (total(h.player) === 21 || total(h.dealer) === 21) return bjEnd(r, pid, p, st);
  } else if (!h || h.state !== 'play') return no();
  else if (m.a === 'hit') { h.player.push(h.deck.pop()); if (total(h.player) >= 21) return bjEnd(r, pid, p, st); }
  else if (m.a === 'double' && h.player.length === 2 && st.fish >= h.bet) { st.fish -= h.bet; h.bet *= 2; h.player.push(h.deck.pop()); return bjEnd(r, pid, p, st); }
  else if (m.a === 'stand') return bjEnd(r, pid, p, st);
  else return no();
  send(p.res, 'bj', { hand: bjView(h, st), fish: st.fish });
}
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
  } else if (m.type === 'slot') { if (!slotSpin(r, pid, p, m.bet)) send(p.res, 'slotno', {}); }
  else if (m.type === 'bj') bjAct(r, pid, p, m);
  else if (m.type === 'slotreset') { r.slots.clear(); broadcast(r, 'slots', { table: [] }); }
  else if (m.type === 'hype') {
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
      kar: r.kar || null, slots: slotTable(r), bj: r.slots.has(pid) ? bjView(r.slots.get(pid).bj, r.slots.get(pid)) : null,
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
