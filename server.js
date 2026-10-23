'use strict';
/* =====================================================================
   DH4X STORE — servidor (Node 18+)
   - Serve o site (index.html) e a API na mesma URL
   - Gera Pix no Mercado Pago (QR Code + copia e cola)
   - Webhook aprova o pedido sozinho quando o Pix cai e entrega as keys
   - Painel admin protegido por senha (ADMIN_PASSWORD, padrão "GK")
   Variáveis de ambiente: veja o README.md
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = process.env;
const PORT = +ENV.PORT || 3000;
const MP_TOKEN = (ENV.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
const MP_API = (ENV.MERCADO_PAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
const ADMIN_PW = (ENV.ADMIN_PASSWORD || 'GK').trim().toLowerCase();
const PUBLIC_URL = (ENV.PUBLIC_URL || ENV.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const WH_SECRET = (ENV.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();
const EXPIRE_MIN = Math.max(30, +ENV.PIX_EXPIRE_MIN || 30);
const MANUAL_HOLD_MIN = 120; // tempo que as keys ficam reservadas no modo Pix manual
const DATABASE_URL = ENV.DATABASE_URL || '';
const DATA_FILE = ENV.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const CORS = (ENV.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

/* ------------------------------ utilitários ------------------------------ */
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const round2 = v => Math.round((+v + Number.EPSILON) * 100) / 100;
const rid = n => crypto.randomBytes(n).toString('base64url');
const IMG_RE = /^(https:\/\/[^\s"'()<>\\]{4,2000}|data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+\/=]+)$/;
const img = v => { v = String(v == null ? '' : v).trim(); return v.length <= 3e6 && IMG_RE.test(v) ? v : ''; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------ armazenamento ----------------------------- */
function fileStore() {
  return {
    async load() {
      try { return JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async save(parts) {
      await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(parts));
      await fs.promises.rename(tmp, DATA_FILE);
    }
  };
}
function pgStore() {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
  return {
    async load() {
      await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL)');
      const r = await pool.query('SELECT k, v FROM kv');
      if (!r.rows.length) return null;
      const o = {};
      r.rows.forEach(x => { o[x.k] = x.v; });
      return o;
    },
    async save(parts, which) {
      for (const k of which) {
        await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, JSON.stringify(parts[k])]);
      }
    }
  };
}

let store, S; // S = { catalog, core }
const dirty = new Set();
let saveQ = Promise.resolve();
function persist(...which) {
  which.forEach(w => dirty.add(w));
  saveQ = saveQ.then(async () => {
    if (!dirty.size) return;
    const w = [...dirty]; dirty.clear();
    try { await store.save(S, w); }
    catch (e) { w.forEach(x => dirty.add(x)); console.error('FALHA AO SALVAR:', e.message); }
  });
  return saveQ;
}

/* ------------------------------ catálogo ---------------------------------- */
const LOJA_FIELDS = ['nome', 'aviso', 'heroT', 'heroP', 'heroImg', 'logo', 'discord', 'whats', 'email', 'pix', 'pixNome', 'pixCidade', 'pixInfo', 'link', 'cor', 'fx', 'fxq', 'fxc', 'selo'];
function cleanCatalog(c) {
  c = c && typeof c === 'object' ? c : {};
  const out = { loja: {}, cats: [], prods: [], cupons: {}, faq: [], termos: str(c.termos, 20000), priv: str(c.priv, 20000) };
  const L = c.loja || {};
  LOJA_FIELDS.forEach(k => { if (L[k] != null) out.loja[k] = /logo|Img/.test(k) ? img(L[k]) : str(L[k], 600); });
  if (out.loja.nome == null) out.loja.nome = '';
  const ids = new Set();
  (Array.isArray(c.cats) ? c.cats : []).slice(0, 100).forEach(x => {
    if (!x || !x.id || ids.has(String(x.id))) return;
    ids.add(String(x.id));
    const o = { id: str(x.id, 40), nome: str(x.nome, 60) || 'Categoria', desc: str(x.desc, 300), on: x.on !== false };
    if (img(x.img)) o.img = img(x.img);
    out.cats.push(o);
  });
  const pids = new Set();
  (Array.isArray(c.prods) ? c.prods : []).slice(0, 500).forEach(x => {
    if (!x || !x.id || pids.has(String(x.id))) return;
    pids.add(String(x.id));
    const o = { id: str(x.id, 40), c: str(x.c, 40), n: str(x.n, 120) || 'Produto', p: Math.max(0, round2(num(x.p))), d: str(x.d, 6000), on: x.on !== false };
    if (x.de != null && x.de !== '' && num(x.de) > 0) o.de = round2(num(x.de));
    if (x.tag) o.tag = str(x.tag, 30);
    if (img(x.img)) o.img = img(x.img);
    if (x.e != null && x.e !== '' && Number.isFinite(+x.e)) o.e = Math.max(0, Math.floor(+x.e));
    o.f = (Array.isArray(x.f) ? x.f : []).slice(0, 20).map(v => str(v, 200)).filter(Boolean);
    o.ops = (Array.isArray(x.ops) ? x.ops : []).slice(0, 30).filter(z => z && z.k).map(z => {
      const r = { k: str(z.k, 40), n: str(z.n, 80) || 'Opção', p: Math.max(0, round2(num(z.p))) };
      if (z.e != null && z.e !== '' && Number.isFinite(+z.e)) r.e = Math.max(0, Math.floor(+z.e));
      return r;
    });
    out.prods.push(o);
  });
  if (c.cupons && typeof c.cupons === 'object') {
    Object.keys(c.cupons).slice(0, 100).forEach(k => {
      const code = k.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20), v = num(c.cupons[k]);
      if (code && v > 0 && v <= 100) out.cupons[code] = v;
    });
  }
  out.faq = (Array.isArray(c.faq) ? c.faq : []).slice(0, 50).filter(f => Array.isArray(f) && f[0]).map(f => [str(f[0], 200), str(f[1], 1000)]);
  return out;
}
function seedCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    return cleanCatalog(raw);
  } catch (e) { /* tenta o index.html */ }
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const m = html.match(/<script id="dbd" type="application\/json">([\s\S]*?)<\/script>/);
    const raw = JSON.parse(m[1]);
    const c = cleanCatalog(raw);
    if (c.prods.length) return c;
    throw new Error('index.html sem produtos');
  } catch (e) {
    return cleanCatalog({
      loja: { nome: 'DH4X STORE', aviso: '', heroT: 'Produtos digitais com entrega imediata', heroP: 'Pague com Pix e receba na hora.', whats: 'https://wa.me/5500000000000', discord: 'https://discord.gg/' },
      cats: [{ id: 'cat1', nome: 'Categoria 1' }], prods: [], cupons: {}, faq: [], termos: 'Edite os termos no painel admin.', priv: 'Edite a política de privacidade no painel admin.'
    });
  }
}

/* ------------------------------ estoque (keys) ---------------------------- */
const keyRec = pid => (S.core.keys[pid] = S.core.keys[pid] || { t: '', track: {}, k: {} });
const tracked = (pid, opt) => !!(S.core.keys[pid] && S.core.keys[pid].track && S.core.keys[pid].track[opt || '']);
const poolRef = (pid, opt) => { const r = keyRec(pid); return (r.k[opt || ''] = r.k[opt || ''] || []); };
const poolLen = (pid, opt) => ((S.core.keys[pid] && S.core.keys[pid].k && S.core.keys[pid].k[opt || '']) || []).length;
const prodById = id => S.catalog.prods.find(p => p.id === id);

function inUseKeys(pid) {
  const set = new Set();
  Object.values(S.core.orders).forEach(o => {
    if (!['pending', 'approved', 'nostock'].includes(o.status)) return;
    o.items.forEach(it => { if (it.id === pid) it.keys.forEach(k => set.add(k)); });
  });
  return set;
}
function allocate(o) {
  const need = new Map();
  for (const it of o.items) {
    if (!tracked(it.id, it.o) || it.keys.length >= it.q) continue;
    const k = it.id + '\u0001' + (it.o || '');
    need.set(k, (need.get(k) || 0) + (it.q - it.keys.length));
  }
  for (const [k, n] of need) {
    const [pid, opt] = k.split('\u0001');
    if (poolLen(pid, opt) < n) return 'Estoque insuficiente para ' + ((o.items.find(i => i.id === pid) || {}).n || 'o produto');
  }
  for (const it of o.items) {
    if (!tracked(it.id, it.o) || it.keys.length >= it.q) continue;
    it.keys.push(...poolRef(it.id, it.o).splice(0, it.q - it.keys.length));
  }
  return null;
}
function releaseItem(it) {
  if (tracked(it.id, it.o) && it.keys.length) {
    const pl = poolRef(it.id, it.o);
    it.keys.forEach(k => { if (!pl.includes(k)) pl.unshift(k); });
  }
  it.keys = [];
}
const release = o => o.items.forEach(releaseItem);

/* ------------------------------ Mercado Pago ------------------------------ */
async function mp(method, pathname, body, idem) {
  const r = await fetch(MP_API + pathname, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' }, idem ? { 'X-Idempotency-Key': idem } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 300) }; }
  if (!r.ok) { const e = new Error('Mercado Pago ' + r.status + ': ' + (j.message || j.error || j.raw || '')); e.status = r.status; throw e; }
  return j;
}
const mpDate = ms => new Date(ms - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const h = req.headers['x-forwarded-host'] || req.headers.host || '';
  const p = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return h ? p + '://' + h : '';
}
async function createPix(o, req) {
  const parts = o.nome.split(/\s+/);
  const body = {
    transaction_amount: o.total,
    description: ('Pedido #' + o.n + ' - ' + (S.catalog.loja.nome || 'Loja')).slice(0, 200),
    payment_method_id: 'pix',
    external_reference: 'DH4X-' + o.n,
    date_of_expiration: mpDate(o.expiresAt),
    payer: { email: o.email, first_name: parts[0], last_name: parts.slice(1).join(' ') || parts[0] }
  };
  const base = baseUrl(req);
  if (/^https:\/\//.test(base)) body.notification_url = base + '/api/webhook/mercadopago';
  const r = await mp('POST', '/v1/payments', body, 'dh4x-' + o.n + '-' + o.token.slice(0, 10));
  const td = (r.point_of_interaction && r.point_of_interaction.transaction_data) || {};
  if (!td.qr_code) throw new Error('Mercado Pago não devolveu o código Pix');
  o.mp = { id: String(r.id), status: r.status, code: td.qr_code, qr: td.qr_code_base64 || '', ticket: td.ticket_url || '' };
}
async function cancelMp(o) {
  if (!MP_TOKEN || !o.mp || !o.mp.id) return;
  try { await mp('PUT', '/v1/payments/' + encodeURIComponent(o.mp.id), { status: 'cancelled' }); } catch (e) { /* ignora */ }
}

/* ------------------------------ pedidos ----------------------------------- */
const orderByToken = t => Object.values(S.core.orders).find(o => o.token === t);

async function approveOrder(o, via, manualItems) {
  if (o.status === 'approved') return { ok: true };
  if (['pending', 'expired', 'rejected', 'nostock'].includes(o.status)) {
    const err = allocate(o);
    if (err) {
      o.status = 'nostock'; o.flag = 'Pago, mas sem keys em estoque'; o.paidAt = o.paidAt || now();
      await persist('core');
      return { ok: false, error: err };
    }
  }
  if (Array.isArray(manualItems)) {
    manualItems.forEach((m, i) => {
      const it = o.items[i];
      if (!it || !m || !Array.isArray(m.keys)) return;
      const ks = [...new Set(m.keys.map(k => str(k, 500)).filter(Boolean))].slice(0, 50);
      if (!ks.length) return;
      releaseItem(it);
      if (tracked(it.id, it.o)) { const pl = poolRef(it.id, it.o); ks.forEach(k => { const ix = pl.indexOf(k); if (ix > -1) pl.splice(ix, 1); }); }
      it.keys = ks;
    });
  }
  o.status = 'approved'; o.paidAt = o.paidAt || now(); o.approvedBy = via; o.flag = '';
  await persist('core');
  return { ok: true };
}
async function expireOrder(o, reason) {
  if (o.status !== 'pending') return;
  release(o); o.status = 'expired'; o.flag = reason || '';
  await persist('core');
}
async function syncPayment(id) {
  const p = await mp('GET', '/v1/payments/' + encodeURIComponent(id));
  const m = String(p.external_reference || '').match(/^DH4X-(\d+)$/);
  if (!m) return null;
  const o = S.core.orders[m[1]];
  if (!o || !o.mp || String(o.mp.id) !== String(p.id)) return null;
  o.mp.status = p.status;
  if (p.status === 'approved') {
    if (Math.abs(num(p.transaction_amount) - o.total) > 0.01) { o.flag = 'Valor pago diferente do valor do pedido'; await persist('core'); return o; }
    await approveOrder(o, 'mercadopago');
  } else if (['cancelled', 'rejected'].includes(p.status) && o.status === 'pending') {
    await expireOrder(o, 'Pagamento ' + p.status);
  } else if (['refunded', 'charged_back'].includes(p.status)) {
    o.flag = p.status === 'refunded' ? 'Pagamento estornado' : 'Pagamento contestado (chargeback)';
    await persist('core');
  } else { await persist('core'); }
  return o;
}
const lastCheck = new Map();

async function createOrder(b, req) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  if (!items.length) throw httpErr(400, 'Carrinho vazio');
  const nome = str(b.nome, 80), email = str(b.email, 120).toLowerCase(), dc = str(b.dc, 40);
  if (nome.length < 3) throw httpErr(400, 'Informe seu nome completo');
  if (!EMAIL_RE.test(email)) throw httpErr(400, 'Informe um e-mail válido');
  const list = [];
  for (const x of items) {
    const p = prodById(str(x && x.id, 40)), q = Math.floor(num(x && x.q));
    const cat = p && S.catalog.cats.find(c => c.id === p.c);
    if (!p || p.on === false || !cat || cat.on === false) throw httpErr(400, 'Produto indisponível');
    if (q < 1 || q > 20) throw httpErr(400, 'Quantidade inválida');
    let unit = p.p, nm = p.n, ok = '';
    if (p.ops && p.ops.length) {
      const o = p.ops.find(z => z.k === str(x.o, 40));
      if (!o) throw httpErr(400, 'Escolha uma opção do produto: ' + p.n);
      unit = o.p; nm = p.n + ' – ' + o.n; ok = o.k;
    }
    if (!(unit > 0)) throw httpErr(400, 'Produto sem preço: ' + p.n);
    const ex = list.find(i => i.id === p.id && i.o === ok);
    if (ex) { ex.q += q; if (ex.q > 20) throw httpErr(400, 'Quantidade inválida'); continue; }
    list.push({ id: p.id, o: ok, n: nm, q, p: round2(unit), keys: [], t: (S.core.keys[p.id] && S.core.keys[p.id].t) || '' });
  }
  const sub = round2(list.reduce((s, i) => s + i.p * i.q, 0));
  let pct = 0, cupom = '';
  if (b.cupom) {
    const code = str(b.cupom, 30).toUpperCase();
    if (!S.catalog.cupons[code]) throw httpErr(400, 'Cupom inválido');
    pct = S.catalog.cupons[code]; cupom = code;
  }
  const desc = round2(sub * pct / 100), total = round2(sub - desc);
  if (total < 1) throw httpErr(400, 'O valor mínimo do pedido é R$ 1,00');
  const o = {
    n: S.core.seq + 1, token: rid(18), status: 'pending', createdAt: now(), nome, email, dc,
    items: list, sub, desc, total, cupom, pct, mp: null, manual: false, flag: '', reviewed: false
  };
  const err = allocate(o);
  if (err) throw httpErr(409, err);
  S.core.seq = o.n;
  S.core.orders[o.n] = o;
  o.expiresAt = now() + EXPIRE_MIN * 60000;
  if (MP_TOKEN) {
    try { await createPix(o, req); }
    catch (e) { log('Pix indisponível no pedido', o.n, '-', e.message); o.manual = true; o.flag = 'Pix automático indisponível: ' + e.message.slice(0, 120); }
  } else { o.manual = true; }
  if (o.manual) o.expiresAt = now() + MANUAL_HOLD_MIN * 60000;
  await persist('core');
  return o;
}
function viewOrder(o) {
  const ok = o.status === 'approved';
  return {
    n: o.n, status: o.status, createdAt: o.createdAt, expiresAt: o.expiresAt, paidAt: o.paidAt || null,
    nome: o.nome, email: o.email, dc: o.dc, sub: o.sub, desc: o.desc, total: o.total, cupom: o.cupom,
    manual: !!o.manual, reviewed: !!o.reviewed,
    items: o.items.map(i => ({ id: i.id, o: i.o, n: i.n, q: i.q, p: i.p, keys: ok ? i.keys : [], t: ok ? i.t : '' })),
    pix: o.status === 'pending' && o.mp ? { code: o.mp.code, qr: o.mp.qr } : null
  };
}
const adminOrder = o => { const c = JSON.parse(JSON.stringify(o)); if (c.mp) delete c.mp.qr; return c; };

/* ------------------------------ imagens por link -------------------------- */
const IMG_HOSTS = (ENV.IMG_RESOLVE_HOSTS || 'ibb.co,www.ibb.co,imgbb.com,www.imgbb.com').split(',').map(x => x.trim()).filter(Boolean);
async function resolveImage(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw httpErr(400, 'Link inválido'); }
  if (u.protocol !== 'https:' && !(ENV.IMG_RESOLVE_ALLOW_HTTP && u.protocol === 'http:')) throw httpErr(400, 'Use um link que comece com https://');
  if (u.hostname === 'i.ibb.co' || /\.(png|jpe?g|webp|gif)$/i.test(u.pathname) || !IMG_HOSTS.includes(u.hostname)) {
    if (!img(u.href)) throw httpErr(400, 'Link de imagem inválido');
    return u.href;
  }
  const r = await fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DH4XStore/1.0)', Accept: 'text/html' }, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!r.ok) throw httpErr(400, 'Não consegui abrir esse link (' + r.status + ')');
  const html = (await r.text()).slice(0, 400000);
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
  const out = m && m[1].replace(/&amp;/g, '&');
  if (!out || !img(out)) throw httpErr(400, 'Não encontrei a imagem nesse link. Copie o "Link direto" do imgbb (começa com https://i.ibb.co/).');
  return out;
}

/* ------------------------------ avaliações -------------------------------- */
const publicReviews = () => S.core.reviews.filter(r => r.ok).sort((a, b) => b.d - a.d).slice(0, 30).map(r => ({ n: r.n, s: r.s, t: r.t, p: r.p, d: r.d }));

/* ------------------------------ segurança --------------------------------- */
const sessions = new Map();
const fails = [];
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + '|' + ip, t = now(), arr = (hits.get(k) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(t); hits.set(k, arr); return false;
}
setInterval(() => {
  const t = now();
  for (const [k, v] of sessions) if (v < t) sessions.delete(k);
  for (const [k, v] of hits) { const a = v.filter(x => t - x < 3600000); if (a.length) hits.set(k, a); else hits.delete(k); }
}, 600000).unref();
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function adminLogin(pw) {
  const t = now();
  while (fails.length && t - fails[0] > 15 * 60000) fails.shift();
  if (fails.length >= 10) throw httpErr(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
  if (!safeEq(String(pw || '').trim().toLowerCase(), ADMIN_PW)) { fails.push(t); throw httpErr(401, 'Senha incorreta'); }
  fails.length = 0;
  const tok = crypto.randomBytes(32).toString('hex');
  sessions.set(tok, t + 12 * 3600000);
  return tok;
}
function adminTok(req) {
  return (String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-admin-token'] || '')).trim();
}
function needAdmin(req) {
  const tok = adminTok(req), exp = sessions.get(tok);
  if (!tok || !exp || exp < now()) throw httpErr(401, 'Sessão expirada. Entre novamente.');
}
function verifyWebhookSig(req, dataId) {
  if (!WH_SECRET) return true;
  const sig = String(req.headers['x-signature'] || ''), rid2 = String(req.headers['x-request-id'] || '');
  const ts = (sig.match(/ts=([^,]+)/) || [])[1], v1 = (sig.match(/v1=([^,]+)/) || [])[1];
  if (!ts || !v1) return false;
  let manifest = '';
  if (dataId) manifest += 'id:' + (/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId) + ';';
  if (rid2) manifest += 'request-id:' + rid2 + ';';
  manifest += 'ts:' + ts + ';';
  const h = crypto.createHmac('sha256', WH_SECRET).update(manifest).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(v1)); } catch (e) { return false; }
}

/* ------------------------------ HTTP -------------------------------------- */
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function send(res, status, data, extra) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  }, extra || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(httpErr(413, 'Conteúdo muito grande')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(httpErr(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function api(req, res, u) {
  const m = req.method, p = u.pathname, ip = clientIp(req);

  /* ----- público ----- */
  if (m === 'GET' && p === '/api/catalog') {
    const c = S.catalog;
    const prods = c.prods.map(x => {
      const q = Object.assign({}, x);
      if (!(x.ops && x.ops.length) && tracked(x.id, '')) q.e = poolLen(x.id, '');
      q.ops = (x.ops || []).map(o => { const r = Object.assign({}, o); if (tracked(x.id, o.k)) r.e = poolLen(x.id, o.k); return r; });
      return q;
    });
    return send(res, 200, { loja: c.loja, cats: c.cats, prods, faq: c.faq, termos: c.termos, priv: c.priv, revs: publicReviews(), pixAuto: !!MP_TOKEN });
  }
  if (m === 'POST' && p === '/api/coupon') {
    if (limited(ip, 'coupon', 30, 600000)) throw httpErr(429, 'Muitas tentativas');
    const b = await readBody(req, 5000), code = str(b.code, 30).toUpperCase();
    if (!S.catalog.cupons[code]) throw httpErr(404, 'Cupom inválido');
    return send(res, 200, { code, pct: S.catalog.cupons[code] });
  }
  if (m === 'POST' && (p === '/api/orders' || p === '/api/pix')) {
    if (limited(ip, 'order', 10, 600000)) throw httpErr(429, 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.');
    const o = await createOrder(await readBody(req, 50000), req);
    const out = Object.assign({ token: o.token }, viewOrder(o));
    if (p === '/api/pix') Object.assign(out, { payment_id: o.mp ? o.mp.id : null, qr_code: o.mp ? o.mp.code : null, qr_code_base64: o.mp ? o.mp.qr : null, copia_e_cola: o.mp ? o.mp.code : null });
    return send(res, 201, out);
  }
  if (m === 'POST' && p === '/api/orders/find') {
    if (limited(ip, 'find', 10, 600000)) throw httpErr(429, 'Muitas tentativas');
    const b = await readBody(req, 5000), o = S.core.orders[Math.floor(num(b.n))];
    if (!o || o.email !== str(b.email, 120).toLowerCase()) throw httpErr(404, 'Pedido não encontrado');
    return send(res, 200, { token: o.token });
  }
  let mm;
  if (m === 'GET' && (mm = p.match(/^\/api\/orders\/([A-Za-z0-9_-]{20,40})$/))) {
    const o = orderByToken(mm[1]);
    if (!o) throw httpErr(404, 'Pedido não encontrado');
    if (o.status === 'pending' && o.mp && MP_TOKEN && now() - (lastCheck.get(o.n) || 0) > 6000) {
      lastCheck.set(o.n, now());
      try { await syncPayment(o.mp.id); } catch (e) { log('Falha ao consultar pagamento', o.n, e.message); }
    }
    return send(res, 200, viewOrder(o));
  }
  if (m === 'POST' && p === '/api/reviews') {
    if (limited(ip, 'review', 10, 600000)) throw httpErr(429, 'Muitas tentativas');
    const b = await readBody(req, 10000), o = orderByToken(str(b.token, 60));
    if (!o || o.status !== 'approved') throw httpErr(400, 'Só é possível avaliar pedidos aprovados');
    if (o.reviewed) throw httpErr(409, 'Este pedido já foi avaliado');
    const g = v => Math.min(5, Math.max(1, Math.floor(num(v, 5)))), t = str(b.t, 400), n = str(b.nome, 30);
    if (t.length < 10) throw httpErr(400, 'Escreva pelo menos 10 caracteres');
    if (n.length < 2) throw httpErr(400, 'Informe seu nome');
    S.core.reviews.push({ id: rid(6), n, s: g(b.s), e: g(b.e), a: g(b.a), q: g(b.q), rec: b.rec ? 1 : 0, t, p: o.items[0].n, d: now(), ok: false, on: o.n });
    o.reviewed = true;
    await persist('core');
    return send(res, 201, { ok: true });
  }
  if ((m === 'POST' || m === 'GET') && p === '/api/webhook/mercadopago') {
    let b = {};
    if (m === 'POST') { try { b = await readBody(req, 100000); } catch (e) { b = {}; } }
    const id = u.searchParams.get('data.id') || (b.data && b.data.id) || ((u.searchParams.get('topic') === 'payment' || b.type === 'payment') ? (u.searchParams.get('id') || b.id) : '');
    const type = u.searchParams.get('type') || u.searchParams.get('topic') || b.type || '';
    if (!id || (type && !/payment/.test(type))) return send(res, 200, { ok: true });
    if (!verifyWebhookSig(req, String(u.searchParams.get('data.id') || (b.data && b.data.id) || ''))) { log('Webhook com assinatura inválida'); return send(res, 401, { error: 'assinatura inválida' }); }
    if (!MP_TOKEN) return send(res, 200, { ok: true });
    try { await syncPayment(String(id)); } catch (e) { log('Webhook: falha ao consultar pagamento', id, e.message); return send(res, 500, { error: 'tente novamente' }); }
    return send(res, 200, { ok: true });
  }

  /* ----- admin ----- */
  if (m === 'POST' && p === '/api/admin/login') {
    const b = await readBody(req, 2000);
    return send(res, 200, { token: adminLogin(b.password) });
  }
  if (p.startsWith('/api/admin/')) {
    needAdmin(req);
    if (m === 'POST' && p === '/api/admin/logout') { sessions.delete(adminTok(req)); return send(res, 200, { ok: true }); }
    if (m === 'GET' && p === '/api/admin/catalog') return send(res, 200, Object.assign({}, S.catalog, { pixAuto: !!MP_TOKEN }));
    if (m === 'PUT' && p === '/api/admin/catalog') {
      S.catalog = cleanCatalog(await readBody(req, 25e6));
      await persist('catalog');
      return send(res, 200, { ok: true, catalog: S.catalog });
    }
    if (m === 'POST' && p === '/api/admin/resolve-image') { const b = await readBody(req, 5000); return send(res, 200, { url: await resolveImage(b.url) }); }
    if (m === 'GET' && p === '/api/admin/keys') return send(res, 200, S.core.keys);
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/keys\/([^/]{1,40})$/))) {
      const pid = decodeURIComponent(mm[1]);
      if (!prodById(pid)) throw httpErr(404, 'Produto não encontrado');
      const b = await readBody(req, 2e6), r = keyRec(pid), used = inUseKeys(pid);
      if (b.t != null) r.t = str(b.t, 6000);
      if (b.track && typeof b.track === 'object') Object.keys(b.track).forEach(k => { r.track[k] = !!b.track[k]; });
      if (b.k && typeof b.k === 'object') {
        Object.keys(b.k).forEach(opt => {
          const lines = (Array.isArray(b.k[opt]) ? b.k[opt] : []).map(x => str(x, 500)).filter(Boolean);
          r.k[opt] = [...new Set(lines)].filter(x => !used.has(x)).slice(0, 5000);
        });
      }
      await persist('core');
      return send(res, 200, { ok: true, rec: r });
    }
    if (m === 'GET' && p === '/api/admin/orders') {
      return send(res, 200, Object.values(S.core.orders).sort((a, b) => b.n - a.n).map(adminOrder));
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/orders\/(\d+)\/approve$/))) {
      const o = S.core.orders[mm[1]]; if (!o) throw httpErr(404, 'Pedido não encontrado');
      const b = await readBody(req, 100000), r = await approveOrder(o, 'admin', b.items);
      if (!r.ok) throw httpErr(409, r.error + '. O pedido ficou marcado como "pago sem estoque".');
      return send(res, 200, adminOrder(o));
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/orders\/(\d+)\/reject$/))) {
      const o = S.core.orders[mm[1]]; if (!o) throw httpErr(404, 'Pedido não encontrado');
      if (o.status === 'approved') throw httpErr(409, 'Pedido já aprovado e entregue');
      release(o); o.status = 'rejected'; o.flag = ''; await persist('core'); cancelMp(o);
      return send(res, 200, adminOrder(o));
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/orders\/(\d+)$/))) {
      const o = S.core.orders[mm[1]]; if (!o) throw httpErr(404, 'Pedido não encontrado');
      if (o.status === 'pending') { release(o); cancelMp(o); }
      delete S.core.orders[o.n]; await persist('core');
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/reviews') return send(res, 200, S.core.reviews.slice().sort((a, b) => b.d - a.d));
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/reviews\/([A-Za-z0-9_-]{4,12})$/))) {
      const r = S.core.reviews.find(x => x.id === mm[1]); if (!r) throw httpErr(404, 'Avaliação não encontrada');
      const b = await readBody(req, 2000);
      if (b.action === 'approve') r.ok = true; else if (b.action === 'hide') r.ok = false;
      else if (b.action === 'delete') S.core.reviews = S.core.reviews.filter(x => x !== r);
      else throw httpErr(400, 'Ação inválida');
      await persist('core');
      return send(res, 200, { ok: true });
    }
    throw httpErr(404, 'Rota não encontrada');
  }
  throw httpErr(404, 'Rota não encontrada');
}

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (u.pathname.startsWith('/api/') && (!CORS.length || (origin && CORS.includes(origin)))) {
      res.setHeader('Access-Control-Allow-Origin', CORS.length ? origin : '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/healthz') return send(res, 200, { ok: true });
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método não permitido' });
    if (u.pathname === '/' || u.pathname === '/admin' || u.pathname === '/index.html') {
      return send(res, 200, await fs.promises.readFile(INDEX, 'utf8'));
    }
    return send(res, 404, { error: 'Não encontrado' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('ERRO:', e && e.stack || e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Erro interno. Tente novamente.' : e.message });
  }
});

/* ------------------------------ rotinas ----------------------------------- */
setInterval(async () => {
  try {
    for (const o of Object.values(S.core.orders)) {
      if (o.status !== 'pending' || now() <= o.expiresAt + 60000) continue;
      if (o.mp && MP_TOKEN) { try { await syncPayment(o.mp.id); } catch (e) { /* tenta de novo no próximo ciclo */ } }
      if (o.status === 'pending') { await expireOrder(o, 'Tempo esgotado'); cancelMp(o); }
    }
  } catch (e) { console.error('Rotina de expiração:', e.message); }
}, 60000).unref();

process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e && e.message || e));
process.on('uncaughtException', e => console.error('Exceção:', e && e.stack || e));

(async () => {
  store = DATABASE_URL ? pgStore() : fileStore();
  const loaded = await store.load();
  S = loaded && loaded.catalog && loaded.core ? loaded : { catalog: seedCatalog(), core: { seq: 0, keys: {}, orders: {}, reviews: [] } };
  S.core.keys = S.core.keys || {}; S.core.orders = S.core.orders || {}; S.core.reviews = S.core.reviews || []; S.core.seq = S.core.seq || 0;
  if (loaded && S.catalog && (!S.catalog.prods || !S.catalog.prods.length) && (!S.catalog.cats || S.catalog.cats.length <= 1)) {
    const sd = seedCatalog();
    if (sd.prods.length) { S.catalog = sd; await persist('catalog'); }
  }
  if (!loaded) await persist('catalog', 'core');
  if (!DATABASE_URL && ENV.RENDER) console.warn('ATENÇÃO: sem DATABASE_URL os dados (pedidos e keys) se perdem a cada reinício no Render. Configure um Postgres (veja o README).');
  if (!MP_TOKEN) console.warn('ATENÇÃO: MERCADO_PAGO_ACCESS_TOKEN não configurado — o site funcionará só com Pix manual.');
  server.listen(PORT, '0.0.0.0', () => log('DH4X STORE rodando na porta', PORT, '| Pix automático:', MP_TOKEN ? 'ligado' : 'desligado', '| banco:', DATABASE_URL ? 'Postgres' : 'arquivo'));
})().catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });
