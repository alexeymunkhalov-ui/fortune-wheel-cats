// Сервер колеса фортуны: раздаёт страницу и синхронизирует комнаты (зрители = коты, общее колесо, общий результат).
// Без зависимостей: node server.js  (порт — переменная PORT, по умолчанию 8765)
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 8765, TAU = Math.PI * 2, MIN = 2, MAX = 24, MAX_PLAYERS = 60;
const PAGE = path.join(__dirname, 'fortune-wheel.html');
const HEX = /^#[0-9a-f]{6}$/i, HATS = ['cone', 'top', 'crown', 'none'];
const PALETTE = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#2ec4b6', '#3a86ff', '#8338ec', '#ff006e', '#06d6a0'];
const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, fresh: true, remove: false, rot: 0, spin: null, pending: -1, timer: null, gc: null, players: new Map(),
      items: ['Пицца', 'Суши', 'Бургер', 'Паста', 'Шаурма', 'Рамен', 'Плов', 'Салат'].map((text, i) => ({ text, color: PALETTE[i] })) };
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
function act(r, pid, m) {
  const p = r.players.get(pid); if (!p) return;
  if (m.type === 'cat') {
    const cat = cleanCat(m.cat);
    if (JSON.stringify(cat) !== JSON.stringify(p.cat)) { p.cat = cat; sendPlayers(r); }
  } else if (m.type === 'items' && !r.spin) {
    const items = cleanItems(m.items); if (!items) return;
    clearTimeout(r.timer); r.pending = -1;
    r.items = items; r.remove = !!m.remove; sendItems(r, pid);
  } else if (m.type === 'spin' && !r.spin) {
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
      spin: r.spin && { from: r.spin.from, to: r.spin.to, dur: r.spin.dur, elapsed: Date.now() - r.spin.start } });
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
    req.on('data', d => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try { const r = rooms.get(rid); if (r) act(r, pid, JSON.parse(body)); } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/fortune-wheel.html')) {
    return fs.readFile(PAGE, (err, data) => {
      if (err) { res.writeHead(500); return res.end('no page'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Колесо фортуны: http://localhost:${PORT}`));
