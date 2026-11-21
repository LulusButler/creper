/* Registro CrePer — app del celular.
 * Todo se guarda primero en el celular (funciona sin señal) y se envía a tu Google Sheet cuando hay conexión.
 */
'use strict';

const APP_VERSION = '1.0.0';
const K = {
  cfg: 'creper.cfg', data: 'creper.data', queue: 'creper.queue', failed: 'creper.failed',
  modo: 'creper.modo', drafts: 'creper.drafts', lastSync: 'creper.lastSync'
};
const SUBE = '↗️', IGUAL = '⛔️', BAJA = '↘️';
const ORIGEN_EXCEL = 'Excel original';
const MEDICIONES = ['Peso y reps', 'Solo reps', 'Tiempo'];
const DAY_COLORS = ['#d93025', '#b45f06', '#674ea7', '#bf9000', '#85200c', '#1155cc', '#0b8043', '#c2185b', '#00838f', '#5d4037'];
const EX_FIELDS = ['id', 'dia', 'orden', 'grupo', 'ejercicio', 'medicion', 'mejor', 'series', 'objetivo', 'suplente', 'ajuste', 'suplenteMolestia', 'incremento', 'activo', 'nota'];

const $app = document.getElementById('app');

/* ---------------- almacenamiento local ---------------- */
function load(k, d) {
  try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
}
function store(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) {
    toast('⚠️ No se pudo guardar en el celular (' + e.name + ')', 'error');
    return false;
  }
}

const S = {
  cfg: load(K.cfg, { url: '', token: '' }),
  server: load(K.data, { catalogo: [], historial: [] }),
  queue: load(K.queue, []),
  failed: load(K.failed, []),
  modo: load(K.modo, 'Normal'),
  drafts: load(K.drafts, {}),
  lastSync: load(K.lastSync, 0),
  sync: { running: false, error: null, retry: 0, timer: null },
  route: null
};
let F = null; // formulario de registro de un ejercicio
let E = null; // formulario de edición de ejercicio

/* ---------------- utilidades ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const pad = (n) => String(n).padStart(2, '0');
const key = (exId, v, m) => `${exId}|${v}|${m}`;
const label = (ex) => (ex.grupo ? `${ex.grupo} – ${ex.ejercicio}` : ex.ejercicio);
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtDate(f, long) {
  if (!f) return '';
  const [y, m, d] = f.split('-');
  return long || y !== String(new Date().getFullYear()) ? `${d}/${m}/${y.slice(2)}` : `${d}/${m}`;
}
function relDate(f) {
  const diff = Math.round((Date.parse(today()) - Date.parse(f)) / 86400000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'ayer';
  if (diff > 1 && diff < 7) return `hace ${diff} días`;
  return fmtDate(f);
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(ts).toLocaleDateString('es-AR');
}
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(',', '.').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const fmtNum = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('es-AR', { maximumFractionDigits: 2 }));
const inNum = (v) => (v === null || v === undefined ? '' : String(+(+v).toFixed(2)).replace('.', ','));
function fmtTime(s) {
  if (s === null || s === undefined) return '—';
  const neg = s < 0; s = Math.abs(Math.round(s));
  return (neg ? '-' : '') + Math.floor(s / 60) + ':' + pad(s % 60);
}
const roundTo = (x, step) => +(Math.round(x / (step || 1)) * (step || 1)).toFixed(2);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isEmptySet = (s) => s.reps === null && s.peso === null && s.tiempo === null;

function normEx(e) {
  const med = MEDICIONES.includes(e.medicion) ? e.medicion : 'Peso y reps';
  return {
    ...e,
    id: String(e.id), dia: String(e.dia || 'Sin día').trim(), grupo: String(e.grupo || '').trim(),
    ejercicio: String(e.ejercicio || '').trim(), medicion: med,
    mejor: e.mejor === 'Menos' || e.mejor === 'Más' ? e.mejor : (med === 'Tiempo' ? 'Menos' : 'Más'),
    series: Number(e.series) || 3, orden: Number(e.orden) || 999,
    ajuste: e.ajuste === '' || e.ajuste === null || e.ajuste === undefined || isNaN(Number(e.ajuste)) ? '' : Number(e.ajuste),
    incremento: Number(e.incremento) || (med === 'Tiempo' ? 5 : 2.5), activo: e.activo === 'No' ? 'No' : 'Sí',
    objetivo: e.objetivo || '', suplente: e.suplente || '', suplenteMolestia: e.suplenteMolestia || '', nota: e.nota || ''
  };
}

/* Misma regla que la hoja: ↗️ mejoró, ⛔️ igual, ↘️ bajó; "igual" = mismas reps y misma carga que la sesión anterior */
function comparar(a, b, menosEsMejor) {
  if (a === null || b === null || a === undefined || b === undefined) return '';
  if (a === b) return IGUAL;
  return (menosEsMejor ? a < b : a > b) ? SUBE : BAJA;
}
function tend(ex, a, b) {
  const tr = comparar(a.reps, b.reps, false);
  let tc = '';
  let igual = a.reps === b.reps;
  if (ex.medicion === 'Tiempo') { tc = comparar(a.tiempo, b.tiempo, ex.mejor === 'Menos'); igual = igual && a.tiempo === b.tiempo; }
  else if (ex.medicion === 'Peso y reps') { tc = comparar(a.peso, b.peso, false); igual = igual && a.peso === b.peso; }
  return { reps: tr, carga: tc, igual };
}
function setTxt(ex, s) {
  if (!s) return '—';
  if (ex.medicion === 'Tiempo') return fmtTime(s.tiempo);
  if (ex.medicion === 'Solo reps') return fmtNum(s.reps);
  return `${fmtNum(s.reps)}×${fmtNum(s.peso)}`;
}
function ejecutado(ex, variante, modo) {
  if (variante === 'Titular') return ex.ejercicio;
  return (modo === 'Molestia' && ex.suplenteMolestia) || ex.suplente || 'Suplente';
}

/* ---------------- vista combinada: datos del servidor + lo pendiente en el celular ---------------- */
let cache = null;
const invalidate = () => { cache = null; };
function view() { return cache || (cache = buildView()); }

function buildView() {
  const cat = new Map();
  (S.server.catalogo || []).forEach((e) => cat.set(String(e.id), { ...e }));
  const pendingEx = new Set();
  S.queue.forEach((op) => {
    if (op.type === 'exercise') { cat.set(op.ex.id, { ...(cat.get(op.ex.id) || {}), ...op.ex }); pendingEx.add(op.ex.id); }
  });
  const catalogo = [...cat.values()].map(normEx).filter((e) => e.ejercicio);
  const byId = new Map(catalogo.map((e) => [e.id, e]));

  const h = new Map();
  (S.server.historial || []).forEach((e) => h.set(e.entrada, e));
  const pend = new Set();
  S.queue.forEach((op) => {
    if (op.type === 'entry') { h.set(op.entrada, { ...op, origen: 'App' }); pend.add(op.entrada); }
    else if (op.type === 'deleteEntry') h.delete(op.entrada);
  });

  const groups = new Map();
  [...h.values()].forEach((e) => {
    const k = key(e.exId, e.variante, e.modo);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  const byKey = new Map();
  const historial = [];
  groups.forEach((list, k) => {
    list.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    let prev = null;
    const out = list.map((e) => {
      const ex = byId.get(e.exId) || normEx({ id: e.exId });
      const series = (e.series || []).map((s, i) => {
        const a = { reps: num(s.reps), peso: num(s.peso), tiempo: num(s.tiempo) };
        const r = { ...a, tr: '', tc: '', igual: 1 };
        if (e.origen === ORIGEN_EXCEL) { r.tr = s.tendReps || ''; r.tc = s.tendPeso || ''; r.igual = num(s.igual); }
        else {
          const p = prev && prev.series[i];
          if (p) { const t = tend(ex, a, p); r.tr = t.reps; r.tc = t.carga; r.igual = t.igual ? (p.igual || 1) + 1 : 1; }
        }
        return r;
      });
      const ce = { ...e, series, pendiente: pend.has(e.entrada) };
      prev = ce;
      return ce;
    });
    byKey.set(k, out);
    historial.push(...out);
  });

  const allDays = [];
  catalogo.forEach((e) => { if (!allDays.includes(e.dia)) allDays.push(e.dia); });
  const days = allDays.filter((d) => catalogo.some((e) => e.dia === d && e.activo !== 'No'));
  return { catalogo, byId, historial, byKey, days, allDays, pendingEx };
}

const dayColor = (dia) => DAY_COLORS[Math.max(0, view().allDays.indexOf(dia)) % DAY_COLORS.length];
const exercisesOf = (dia, incluirInactivos) => view().catalogo
  .filter((e) => e.dia === dia && (incluirInactivos || e.activo !== 'No'))
  .sort((a, b) => a.orden - b.orden || a.ejercicio.localeCompare(b.ejercicio));
const entries = (exId, v, m) => view().byKey.get(key(exId, v, m)) || [];
function lastEntry(exId, v, m, before) {
  const l = entries(exId, v, m).filter((e) => !before || e.fecha < before);
  return l.length ? l[l.length - 1] : null;
}
const entryOn = (exId, v, m, fecha) => entries(exId, v, m).find((e) => e.fecha === fecha) || null;
const doneToday = (exId) => view().historial.some((e) => e.exId === exId && e.fecha === today());

/* ---------------- sincronización ---------------- */
class ApiError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

async function api(method, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    let res;
    if (method === 'GET') {
      const q = new URLSearchParams({ ...payload, token: S.cfg.token, t: Date.now() });
      res = await fetch(S.cfg.url + (S.cfg.url.includes('?') ? '&' : '?') + q, { signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
    } else {
      // text/plain evita el "preflight" CORS que Apps Script no admite
      res = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ ...payload, token: S.cfg.token }), signal: ctrl.signal, redirect: 'follow' });
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) {
      throw new ApiError('La URL no respondió como se esperaba. Revisa que sea la de la aplicación web y que el acceso sea "Cualquier usuario".', 'server');
    }
    if (!json.ok) throw new ApiError(json.error || 'Error en la hoja', json.error === 'Clave incorrecta' ? 'auth' : 'server');
    return json;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError('Sin respuesta (señal débil)', 'network');
    throw new ApiError('Sin conexión', 'network');
  } finally {
    clearTimeout(timer);
  }
}

function enqueue(op) {
  const prevQueue = S.queue;
  if (op.type === 'entry' || op.type === 'deleteEntry') {
    S.queue = S.queue.filter((o) => !((o.type === 'entry' || o.type === 'deleteEntry') && o.entrada === op.entrada));
  } else if (op.type === 'exercise') {
    S.queue = S.queue.filter((o) => !(o.type === 'exercise' && o.ex.id === op.ex.id));
  }
  S.queue.push(op);
  if (!store(K.queue, S.queue)) { S.queue = prevQueue; return false; }
  invalidate();
  return true;
}

async function sync() {
  if (S.sync.running) return;
  if (!S.cfg.url || !S.cfg.token) { updatePill(); return; }
  S.sync.running = true;
  clearTimeout(S.sync.timer);
  updatePill();
  try {
    let vueltas = 0;
    do {
      const batch = S.queue.slice(0, 30);
      const res = batch.length ? await api('POST', { action: 'sync', ops: batch }) : await api('GET', { action: 'bootstrap' });
      if (batch.length) {
        const done = new Set(res.done || []);
        (res.failed || []).forEach((f) => {
          done.add(f.opId);
          const op = batch.find((o) => o.opId === f.opId);
          if (op) S.failed.push({ op, error: f.error, at: Date.now() });
        });
        S.queue = S.queue.filter((o) => !done.has(o.opId));
        store(K.queue, S.queue);
        store(K.failed, S.failed);
        if (res.failed && res.failed.length) toast(`⚠️ ${res.failed.length} registro(s) no se pudieron guardar. Mira Ajustes.`, 'error');
        if (!done.size) break;
      }
      if (res.data) { S.server = res.data; store(K.data, res.data); }
    } while (S.queue.length && ++vueltas < 20);
    S.sync.error = null;
    S.sync.retry = 0;
    S.lastSync = Date.now();
    store(K.lastSync, S.lastSync);
  } catch (e) {
    S.sync.error = e;
    if (e.kind !== 'auth' && S.queue.length) {
      S.sync.retry = Math.min(Math.max(S.sync.retry * 2, 5000), 120000);
      S.sync.timer = setTimeout(sync, S.sync.retry);
    }
  } finally {
    S.sync.running = false;
    invalidate();
    softRender();
  }
}

function pillHtml() {
  const n = S.queue.length;
  let cls = 'ok';
  let txt;
  if (!S.cfg.url || !S.cfg.token) { cls = 'warn'; txt = '⚙️ Falta conectar tu hoja de Google · tocar para configurar'; }
  else if (S.sync.running) { cls = 'busy'; txt = n ? `⟳ Enviando ${n} cambio(s)…` : '⟳ Actualizando…'; }
  else if (S.sync.error && S.sync.error.kind === 'auth') { cls = 'bad'; txt = '⚠️ Clave incorrecta · revisa Ajustes'; }
  else if (S.sync.error && S.sync.error.kind === 'server') { cls = 'bad'; txt = '⚠️ ' + S.sync.error.message; }
  else if (n) { cls = 'warn'; txt = `● ${n} cambio(s) guardado(s) en el celular${S.sync.error ? ' · se envían al volver la señal' : ''}`; }
  else if (S.sync.error) { cls = 'warn'; txt = '○ Sin señal · trabajando con lo guardado en el celular'; }
  else txt = `✓ Todo guardado en tu hoja${S.lastSync ? ' · ' + ago(S.lastSync) : ''}`;
  return `<button id="sync" class="pill ${cls}" data-act="pill">${esc(txt)}</button>`;
}
function updatePill() { const el = document.getElementById('sync'); if (el) el.outerHTML = pillHtml(); }

/* ---------------- piezas de interfaz ---------------- */
function topbar(title, back, right) {
  return `<header class="bar">${back ? `<a class="icon-btn" href="${back}" aria-label="Volver">‹</a>` : ''}<h1>${esc(title)}</h1>${right || ''}</header>`;
}
function nav(active) {
  const items = [['', '🏋️', 'Entrenar'], ['progreso', '📈', 'Progreso'], ['ejercicios', '🗂️', 'Ejercicios'], ['ajustes', '⚙️', 'Ajustes']];
  return `<nav class="nav">${items.map(([r, i, t]) => `<a href="#/${r}" class="${active === r ? 'on' : ''}"><span>${i}</span>${t}</a>`).join('')}</nav>`;
}
function modoSeg(actual, act, extra) {
  return `<div class="seg" role="group" aria-label="Modo">
    <button class="${actual === 'Normal' ? 'on' : ''}" data-act="${act}" data-v="Normal" ${extra || ''}>Normal</button>
    <button class="${actual === 'Molestia' ? 'on molestia' : ''}" data-act="${act}" data-v="Molestia" ${extra || ''}>🩹 Con molestia</button>
  </div>`;
}
function chipsHtml(ex, e, conFlechas) {
  return `<div class="chips">${e.series.map((s) => {
    const fl = conFlechas ? [ex.medicion !== 'Tiempo' ? s.tr : '', s.tc].filter(Boolean).join('') : '';
    return `<span class="chip">${esc(setTxt(ex, s))}${fl ? ` <small>${fl}</small>` : ''}</span>`;
  }).join('')}</div>`;
}
function maxIgual(e) { return e ? Math.max(0, ...e.series.map((s) => s.igual || 0)) : 0; }

/* ---------------- pantallas ---------------- */
function viewHome() {
  const V = view();
  let body = '';
  if (!S.cfg.url || !S.cfg.token) {
    body += `<div class="card"><div class="title">Conecta tu hoja de Google</div>
      <p class="sub">Pega la URL de la aplicación web y la clave (las sacas de Apps Script y de la pestaña Configuración de tu hoja).</p>
      <a class="btn primary block" href="#/ajustes">Configurar conexión</a></div>`;
  }
  if (!V.days.length) {
    body += `<div class="empty">${S.cfg.url ? 'Todavía no hay ejercicios. Toca el indicador de arriba para traerlos de tu hoja, o crea uno en 🗂️ Ejercicios.' : ''}</div>`;
  } else {
    body += V.days.map((d) => {
      const exs = exercisesOf(d);
      const ids = new Set(exs.map((e) => e.id));
      const fechas = V.historial.filter((e) => ids.has(e.exId)).map((e) => e.fecha).sort();
      const ultima = fechas.length ? fechas[fechas.length - 1] : null;
      const hechos = exs.filter((e) => doneToday(e.id)).length;
      return `<a class="card day" style="--c:${dayColor(d)}" href="#/dia/${enc(d)}">
        <div class="row"><div class="title">${esc(d)}</div><span class="spacer"></span>${hechos ? `<span class="badge ok">${hechos}/${exs.length} hoy</span>` : ''}</div>
        <div class="sub">${exs.length} ejercicio${exs.length === 1 ? '' : 's'}${ultima ? ` · última vez ${relDate(ultima)}` : ''}</div>
        ${hechos ? `<div class="progress"><i style="width:${Math.round((hechos / exs.length) * 100)}%"></i></div>` : ''}
      </a>`;
    }).join('');
  }
  return topbar('Registro CrePer') + `<div class="wrap stack">${pillHtml()}${modoSeg(S.modo, 'modoGlobal')}
    ${S.modo === 'Molestia' ? '<div class="banner molestia">🩹 Modo molestia: verás y guardarás las cargas reducidas, separadas de tu progreso normal.</div>' : ''}
    ${body}</div>` + nav('');
}

function viewDia(dia) {
  const exs = exercisesOf(dia);
  if (!exs.length) return topbar(dia, '#/') + `<div class="empty">No hay ejercicios activos en este día.</div>` + nav('');
  const hechos = exs.filter((e) => doneToday(e.id)).length;
  const cards = exs.map((ex) => {
    const hoy = entryOn(ex.id, 'Titular', S.modo, today()) || entryOn(ex.id, 'Suplente', S.modo, today());
    const hoyOtro = hoy || view().historial.find((e) => e.exId === ex.id && e.fecha === today());
    let ref = hoy || lastEntry(ex.id, 'Titular', S.modo) || lastEntry(ex.id, 'Suplente', S.modo);
    let deNormal = false;
    if (!ref && S.modo === 'Molestia') { ref = lastEntry(ex.id, 'Titular', 'Normal'); deNormal = !!ref; }
    const est = maxIgual(lastEntry(ex.id, 'Titular', S.modo, hoy ? today() : null));
    const sub = [ex.grupo, ex.suplente ? `Suplente: ${ex.suplente}` : '', ex.medicion !== 'Peso y reps' ? ex.medicion : ''].filter(Boolean).join(' · ');
    const badgeHoy = hoyOtro
      ? `<span class="badge ok">✓ Hoy${hoyOtro.variante === 'Suplente' ? ' (suplente)' : ''}${hoyOtro.modo !== S.modo ? (hoyOtro.modo === 'Molestia' ? ' 🩹' : ' (normal)') : ''}${hoyOtro.pendiente ? ' ⏳' : ''}</span>`
      : '';
    return `<a class="card ex" style="--c:${dayColor(dia)}" href="#/ej/${enc(ex.id)}?m=${S.modo}">
      <div class="row"><div class="title">${esc(ex.ejercicio)}</div><span class="spacer"></span>${badgeHoy}</div>
      <div class="sub">${esc(sub)}</div>
      ${ref ? chipsHtml(ex, ref, false) : '<div class="sub">Sin registros todavía</div>'}
      <div class="row small" style="margin-top:6px">${ref ? `<span class="muted">${deNormal ? 'Sin datos con molestia · cargas normales (' + relDate(ref.fecha) + ')' : hoy ? 'Hoy' : 'Última: ' + relDate(ref.fecha)}${ref.variante === 'Suplente' ? ' · suplente' : ''}</span>` : ''}
        ${est >= 3 && !hoy ? `<span class="badge warn">🔁 ${est} sesiones igual</span>` : ''}</div>
    </a>`;
  }).join('');
  return topbar(dia, '#/') + `<div class="wrap stack">${pillHtml()}${modoSeg(S.modo, 'modoGlobal')}
    <div class="row small muted">Hoy: ${hechos} de ${exs.length} ejercicios</div>
    <div class="progress" style="margin-top:4px"><i style="width:${Math.round((hechos / exs.length) * 100)}%"></i></div>
    ${cards}</div>` + nav('');
}

function prefill(ex, variante, modo, fecha) {
  const toForm = (s) => ({ reps: inNum(s.reps), peso: inNum(s.peso), tiempo: s.tiempo === null || s.tiempo === undefined ? '' : String(s.tiempo) });
  const ref = lastEntry(ex.id, variante, modo, fecha);
  const hoy = entryOn(ex.id, variante, modo, fecha);
  if (hoy) return { series: hoy.series.map(toForm), nota: hoy.nota || '', ref, fuente: 'editando', existing: hoy };
  if (ref) return { series: ref.series.map(toForm), nota: '', ref, fuente: 'ultima' };
  if (variante === 'Suplente') {
    const base = lastEntry(ex.id, 'Titular', modo, fecha) || lastEntry(ex.id, 'Titular', 'Normal', fecha);
    if (base) {
      const f = 1 + (Number(ex.ajuste) || 0) / 100;
      return {
        series: base.series.map((s) => ({ ...toForm(s), peso: s.peso === null ? '' : inNum(roundTo(s.peso * f, ex.incremento)) })),
        nota: '', ref: null, fuente: ex.ajuste ? 'ajuste' : 'titular'
      };
    }
  }
  if (modo === 'Molestia') {
    const base = lastEntry(ex.id, variante, 'Normal', fecha);
    if (base) return { series: base.series.map(toForm), nota: '', ref: null, fuente: 'normal' };
  }
  return { series: Array.from({ length: ex.series }, () => ({ reps: '', peso: '', tiempo: '' })), nota: '', ref: null, fuente: 'nuevo' };
}

function initForm(ex, variante, modo, fecha) {
  const entrada = `${fecha}|${ex.id}|${variante}|${modo}`;
  const p = prefill(ex, variante, modo, fecha);
  const d = S.drafts[entrada];
  return {
    exId: ex.id, variante, modo, fecha, entrada,
    series: d ? d.series.map((s) => ({ ...s })) : p.series, nota: d ? d.nota : p.nota,
    ref: p.ref, fuente: p.fuente, existing: p.existing || null, fromDraft: !!d
  };
}
function saveDraft() {
  if (!F) return;
  S.drafts[F.entrada] = { series: F.series, nota: F.nota, ts: Date.now() };
  store(K.drafts, S.drafts);
}
function fieldsFor(ex) {
  if (ex.medicion === 'Tiempo') return [['tiempo', 'Segundos']];
  if (ex.medicion === 'Solo reps') return [['reps', 'Reps']];
  return [['reps', 'Reps'], ['peso', 'Kg']];
}
function indHtml(ex, i) {
  const s = F.series[i];
  const a = { reps: num(s.reps), peso: num(s.peso), tiempo: num(s.tiempo) };
  const p = F.ref && F.ref.series[i];
  if (!p) return `<span class="muted">${F.ref ? 'Serie nueva (no estaba la vez anterior)' : ''}</span>`;
  const antes = `<span class="muted">antes ${esc(setTxt(ex, p))}</span>`;
  if (isEmptySet(a)) return antes;
  const t = tend(ex, a, p);
  const flechas = [ex.medicion !== 'Tiempo' ? t.reps : '', t.carga].filter(Boolean).join(' ');
  const igual = t.igual ? (p.igual || 1) + 1 : 1;
  const badge = t.igual ? ` <span class="badge ${igual >= 3 ? 'warn' : ''}">🔁 ${igual}ª sesión igual${igual >= 3 ? ' · ¿subimos?' : ''}</span>` : '';
  return `<span class="arrows">${flechas}</span> ${antes}${badge}`;
}

function viewEj(id, q) {
  const V = view();
  const ex = V.byId.get(id);
  if (!ex) return topbar('Ejercicio', '#/') + '<div class="empty">No encontré este ejercicio.</div>';
  const variante = q.get('v') === 'Suplente' && ex.suplente ? 'Suplente' : 'Titular';
  const modo = q.get('m') === 'Molestia' ? 'Molestia' : q.get('m') === 'Normal' ? 'Normal' : S.modo;
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(q.get('f') || '') ? q.get('f') : today();
  const entrada = `${fecha}|${ex.id}|${variante}|${modo}`;
  if (!F || F.entrada !== entrada) F = initForm(ex, variante, modo, fecha);
  const url = (v, m, f) => `#/ej/${enc(id)}?v=${v}&m=${m}&f=${f}`;

  const fuente = {
    editando: `✏️ Estás editando lo que guardaste el ${fmtDate(fecha, true)}.`,
    ultima: F.ref ? `Precargado con tu última vez (${relDate(F.ref.fecha)}). Cambia lo que hiciste distinto.` : '',
    ajuste: `Primera vez con el suplente: pesos sugeridos = titular +${ex.ajuste}%. Ajústalos si hace falta.`,
    titular: 'Primera vez con el suplente: se copiaron los valores del titular. Ajústalos.',
    normal: 'Sin registros con molestia: se copiaron tus cargas normales. Bájalas según te indicó tu entrenador.',
    nuevo: 'Primera vez: carga tus series.'
  }[F.fuente];

  const campos = fieldsFor(ex);
  const series = F.series.map((s, i) => `
    <div class="serie">
      <div class="serie-n">${i + 1}</div>
      <div class="fields">${campos.map(([f, lab]) => `
        <div class="field"><label for="f-${f}-${i}">${lab}</label>
          <div class="stepper">
            <button type="button" data-act="step" data-i="${i}" data-f="${f}" data-d="-1" aria-label="Restar ${lab}">−</button>
            <input id="f-${f}-${i}" type="text" inputmode="${f === 'reps' || f === 'tiempo' ? 'numeric' : 'decimal'}" autocomplete="off" data-sf="${f}" data-i="${i}" value="${esc(s[f])}">
            <button type="button" data-act="step" data-i="${i}" data-f="${f}" data-d="1" aria-label="Sumar ${lab}">+</button>
          </div>
          ${f === 'tiempo' ? `<div class="hint" id="h-${i}">${num(s.tiempo) !== null ? '= ' + fmtTime(num(s.tiempo)) : 'm:ss'}</div>` : ''}
        </div>`).join('')}
      </div>
      <div class="ind" id="ind-${i}">${indHtml(ex, i)}</div>
    </div>`).join('');

  const info = [ex.objetivo ? `🎯 ${esc(ex.objetivo)}` : '', ex.nota ? esc(ex.nota) : ''].filter(Boolean).join(' · ');
  document.body.classList.toggle('molestia', modo === 'Molestia');
  return topbar(ex.ejercicio, `#/dia/${enc(ex.dia)}`) + `<div class="wrap stack">
    <div class="small muted">${esc(ex.grupo)}${info ? ' · ' + info : ''}</div>
    ${ex.suplente ? `<div class="seg" role="group" aria-label="Variante">
      <button class="${variante === 'Titular' ? 'on' : ''}" data-act="go" data-url="${url('Titular', modo, fecha)}">Titular<small>${esc(ex.ejercicio)}</small></button>
      <button class="${variante === 'Suplente' ? 'on' : ''}" data-act="go" data-url="${url('Suplente', modo, fecha)}">Suplente<small>${esc(ejecutado(ex, 'Suplente', modo))}</small></button>
    </div>` : ''}
    ${modoSeg(modo, 'modoEj')}
    <div class="row"><label for="fecha" class="small muted">Fecha</label><input id="fecha" type="date" value="${fecha}" max="${today()}" style="flex:1"></div>
    ${F.fromDraft ? '<div class="banner warn">Recuperé lo que estabas cargando y no habías guardado. <button class="linkbtn" data-act="discardDraft">Descartar</button></div>' : ''}
    ${fuente ? `<div class="banner info">${fuente}</div>` : ''}
    ${F.ref ? `<div class="small muted">Última vez (${fmtDate(F.ref.fecha)}): ${F.ref.series.map((s) => esc(setTxt(ex, s))).join(' · ')}</div>` : ''}
    ${series}
    <div class="row"><button class="btn small" data-act="addSerie">+ Serie</button><button class="btn small" data-act="delSerie" ${F.series.length <= 1 ? 'disabled' : ''}>− Quitar última</button></div>
    <label class="small muted" for="nota">Nota (opcional)</label>
    <textarea id="nota" placeholder="Ej.: la máquina estaba ocupada, molestia en la rodilla…">${esc(F.nota)}</textarea>
    ${F.existing ? '<button class="linkbtn" data-act="delEntry">Eliminar este registro</button>' : ''}
  </div>
  <div class="footer-bar"><div><button class="btn primary block" data-act="saveEj">${F.existing ? 'Guardar cambios' : 'Guardar'}</button></div></div>`;
}

function metricsFor(ex) {
  const vals = (e, f) => e.series.map((s) => s[f]).filter((x) => x !== null && x !== undefined);
  const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
  if (ex.medicion === 'Tiempo') {
    const menos = ex.mejor === 'Menos';
    return [
      { k: 'tbest', name: menos ? 'Mejor tiempo (mín.)' : 'Mejor tiempo (máx.)', fmt: fmtTime, invert: menos, fn: (e) => { const v = vals(e, 'tiempo'); return v.length ? (menos ? Math.min(...v) : Math.max(...v)) : null; } },
      { k: 'tavg', name: 'Promedio', fmt: fmtTime, invert: menos, fn: (e) => { const v = vals(e, 'tiempo'); return v.length ? sum(v) / v.length : null; } }
    ];
  }
  if (ex.medicion === 'Solo reps') {
    return [
      { k: 'reps', name: 'Reps totales', fmt: fmtNum, fn: (e) => sum(vals(e, 'reps')) },
      { k: 'rmax', name: 'Reps máx.', fmt: fmtNum, fn: (e) => { const v = vals(e, 'reps'); return v.length ? Math.max(...v) : null; } }
    ];
  }
  return [
    { k: 'pmax', name: 'Peso máx.', unit: ' kg', fmt: fmtNum, fn: (e) => { const v = vals(e, 'peso'); return v.length ? Math.max(...v) : null; } },
    { k: 'vol', name: 'Volumen', unit: ' kg', fmt: (v) => fmtNum(Math.round(v)), fn: (e) => sum(e.series.filter((s) => s.reps !== null && s.peso !== null && s.peso > 0).map((s) => s.reps * s.peso)) },
    { k: 'reps', name: 'Reps totales', fmt: fmtNum, fn: (e) => sum(vals(e, 'reps')) }
  ];
}

function chartSvg(points, m) {
  if (!points.length) return '<div class="empty">Sin datos para graficar.</div>';
  const W = 340, H = 190, P = { l: 44, r: 14, t: 14, b: 26 };
  const xs = points.map((p) => Date.parse(p.x));
  const ys = points.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 86400000; x1 += 86400000; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const padY = (y1 - y0) * 0.12; y0 -= padY; y1 += padY;
  const X = (v) => P.l + ((v - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - ((v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const ticks = [y0 + padY, (y0 + y1) / 2, y1 - padY];
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de ${esc(m.name)}">
    ${ticks.map((t) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text x="${P.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${esc(m.fmt(t))}</text>`).join('')}
    <path class="line" d="${path}"/>
    ${points.map((p, i) => `<circle class="dot" cx="${X(xs[i]).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4"><title>${fmtDate(p.x)}: ${esc(m.fmt(p.y))}</title></circle>`).join('')}
    <text x="${P.l}" y="${H - 6}">${fmtDate(points[0].x)}</text>
    ${points.length > 1 ? `<text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtDate(points[points.length - 1].x)}</text>` : ''}
  </svg>`;
}

function viewProgreso() {
  const V = view();
  const dias = V.allDays.filter((d) => exercisesOf(d, true).some((ex) => V.historial.some((e) => e.exId === ex.id)));
  if (!dias.length) return topbar('Progreso') + '<div class="empty">Cuando registres sesiones vas a ver acá tu evolución.</div>' + nav('progreso');
  const body = dias.map((d) => `<h2>${esc(d)}</h2><div class="list">${exercisesOf(d, true).map((ex) => {
    const l = entries(ex.id, 'Titular', 'Normal');
    const m = metricsFor(ex)[0];
    const vals = l.map((e) => m.fn(e)).filter((v) => v !== null);
    let cambio = '';
    if (vals.length > 1) {
      const a = vals[0], b = vals[vals.length - 1];
      const mejor = m.invert ? b < a : b > a;
      cambio = b === a ? '<span class="muted">=</span>' : `<span class="${mejor ? 'up' : 'down'}">${mejor ? '▲' : '▼'} ${esc(m.fmt(a))} → ${esc(m.fmt(b))}</span>`;
    }
    const total = ['Titular|Normal', 'Suplente|Normal', 'Titular|Molestia', 'Suplente|Molestia'].reduce((n, vm) => n + (V.byKey.get(`${ex.id}|${vm}`) || []).length, 0);
    return `<a href="#/progreso/${enc(ex.id)}"><div class="grow"><div class="name">${esc(ex.ejercicio)}</div>
      <div class="small muted">${total} sesión(es)${l.length ? ' · última ' + relDate(l[l.length - 1].fecha) : ''}</div></div><div class="small">${cambio}</div></a>`;
  }).join('')}</div>`).join('');
  return topbar('Progreso') + `<div class="wrap">${body}</div>` + nav('progreso');
}

function viewProgresoEj(id, q) {
  const V = view();
  const ex = V.byId.get(id);
  if (!ex) return topbar('Progreso', '#/progreso') + '<div class="empty">No encontré este ejercicio.</div>' + nav('progreso');
  const combos = [['Titular', 'Normal'], ['Suplente', 'Normal'], ['Titular', 'Molestia'], ['Suplente', 'Molestia']]
    .filter(([v, m]) => entries(id, v, m).length);
  if (!combos.length) return topbar(ex.ejercicio, '#/progreso') + '<div class="empty">Sin sesiones todavía.</div>' + nav('progreso');
  let v = q.get('v'), m = q.get('m');
  if (!combos.some((c) => c[0] === v && c[1] === m)) [v, m] = combos[0];
  const metrics = metricsFor(ex);
  const met = metrics.find((x) => x.k === q.get('k')) || metrics[0];
  const list = entries(id, v, m);
  const pts = list.map((e) => ({ x: e.fecha, y: met.fn(e) })).filter((p) => p.y !== null);
  const url = (vv, mm, kk) => `#/progreso/${enc(id)}?v=${vv}&m=${mm}&k=${kk}`;

  let stats = '';
  if (pts.length) {
    const a = pts[0].y, b = pts[pts.length - 1].y;
    const pct = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
    const mejor = met.invert ? b < a : b > a;
    stats = `<div class="stats">
      <div class="stat"><b>${list.length}</b><span>sesiones</span></div>
      <div class="stat"><b>${esc(met.fmt(b))}${met.unit || ''}</b><span>última (${fmtDate(pts[pts.length - 1].x)})</span></div>
      <div class="stat"><b class="${b === a ? '' : mejor ? 'up' : 'down'}">${b === a ? '=' : (pct > 0 ? '+' : '') + pct.toFixed(0) + '%'}</b><span>desde ${fmtDate(pts[0].x)}</span></div>
    </div>`;
  }
  const last = list[list.length - 1];
  const est = last ? last.series.map((s, i) => (s.igual >= 2 ? `serie ${i + 1}: ${s.igual}` : '')).filter(Boolean) : [];
  const etiquetaCombo = (c) => `${c[0] === 'Titular' ? 'Titular' : 'Suplente'}${c[1] === 'Molestia' ? ' 🩹' : ''}`;
  return topbar(ex.ejercicio, '#/progreso') + `<div class="wrap stack">
    <div class="small muted">${esc(ex.dia)} · ${esc(ex.grupo)}</div>
    ${combos.length > 1 ? `<div class="seg${combos.length > 2 ? ' grid2' : ''}">${combos.map((c) => `<a class="${c[0] === v && c[1] === m ? 'on' : ''}" href="${url(c[0], c[1], met.k)}">${etiquetaCombo(c)}</a>`).join('')}</div>` : ''}
    <div class="seg">${metrics.map((x) => `<a class="${x.k === met.k ? 'on' : ''}" href="${url(v, m, x.k)}">${esc(x.name)}</a>`).join('')}</div>
    <div class="card">${chartSvg(pts, met)}</div>
    ${stats}
    ${est.length ? `<div class="banner ${est.some((t) => +t.split(': ')[1] >= 3) ? 'warn' : 'info'}">🔁 Sesiones iguales seguidas — ${est.join(' · ')}</div>` : ''}
    <h2>Sesiones</h2>
    <div class="list">${list.slice().reverse().map((e) => `<div class="sess"><div class="date">${fmtDate(e.fecha)}</div>
      <div class="grow">${chipsHtml(ex, e, true)}${e.nota ? `<div class="small muted" style="margin-top:4px">${esc(e.nota)}</div>` : ''}</div>
      ${e.pendiente ? '<span title="Pendiente de enviar">⏳</span>' : ''}</div>`).join('')}</div>
  </div>` + nav('progreso');
}

function viewEjercicios() {
  const V = view();
  const body = V.allDays.map((d) => `<h2>${esc(d)}</h2><div class="list">${exercisesOf(d, true).map((ex) => `
    <a href="#/editar/${enc(ex.id)}" class="${ex.activo === 'No' ? 'inactive' : ''}"><div class="grow"><div class="name">${esc(ex.ejercicio)} ${V.pendingEx.has(ex.id) ? '⏳' : ''}</div>
    <div class="small muted">${esc([ex.grupo, ex.medicion, ex.suplente ? 'Suplente: ' + ex.suplente : '', ex.activo === 'No' ? 'inactivo' : ''].filter(Boolean).join(' · '))}</div></div><span class="muted">›</span></a>`).join('')}
    <a href="#/editar/nuevo?dia=${enc(d)}"><div class="grow muted">+ Agregar ejercicio a ${esc(d)}</div></a></div>`).join('');
  return topbar('Ejercicios') + `<div class="wrap">
    <p class="small muted">Agrega, edita o desactiva ejercicios. También puedes hacerlo en la pestaña "Ejercicios" de tu hoja.</p>
    <a class="btn primary block" href="#/editar/nuevo?dia=__nuevo">+ Nuevo día de entrenamiento</a>
    ${body || '<div class="empty">Sin ejercicios todavía.</div>'}</div>` + nav('ejercicios');
}

function viewEditar(id, q) {
  const V = view();
  const isNew = id === 'nuevo';
  const marca = isNew ? 'nuevo:' + (q.get('dia') || '') : id;
  if (!E || E._marca !== marca) {
    let base;
    if (isNew) {
      const dia = q.get('dia') && q.get('dia') !== '__nuevo' ? q.get('dia') : '';
      base = normEx({ id: 'X' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), dia, medicion: 'Peso y reps', series: 3, activo: 'Sí', orden: '' });
      base.dia = dia;
      base.orden = '';
      base._diaNuevo = !dia;
    } else {
      base = V.byId.get(id);
      if (!base) return topbar('Ejercicio', '#/ejercicios') + '<div class="empty">No encontré este ejercicio.</div>';
      base = { ...base, _diaNuevo: false };
    }
    E = { ...base, _marca: marca, _isNew: isNew };
  }
  const grupos = [...new Set(V.catalogo.map((e) => e.grupo).filter(Boolean))];
  const tiempo = E.medicion === 'Tiempo';
  const input = (f, lab, extra, help) => `<label class="lbl" for="e-${f}">${lab}</label><input id="e-${f}" type="text" data-e="${f}" value="${esc(E[f])}" ${extra || ''}>${help ? `<div class="help">${help}</div>` : ''}`;
  return topbar(isNew ? 'Nuevo ejercicio' : 'Editar ejercicio', '#/ejercicios') + `<div class="wrap form">
    <label class="lbl" for="e-dia">Día</label>
    <select id="e-dia" data-e="dia">
      ${V.allDays.map((d) => `<option value="${esc(d)}" ${!E._diaNuevo && E.dia === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
      <option value="__nuevo" ${E._diaNuevo ? 'selected' : ''}>➕ Nuevo día…</option>
    </select>
    ${E._diaNuevo ? input('dia', 'Nombre del nuevo día', 'placeholder="Ej.: Abdominales y pasadas"') : ''}
    ${input('grupo', 'Grupo muscular', 'list="grupos" placeholder="Ej.: Bíceps"')}
    <datalist id="grupos">${grupos.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    ${input('ejercicio', 'Ejercicio', 'placeholder="Ej.: Curl martillo"')}
    <label class="lbl" for="e-medicion">Cómo se mide</label>
    <select id="e-medicion" data-e="medicion">${MEDICIONES.map((m) => `<option ${E.medicion === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    ${tiempo ? `<label class="lbl" for="e-mejor">¿Qué es mejorar?</label>
      <select id="e-mejor" data-e="mejor"><option value="Menos" ${E.mejor === 'Menos' ? 'selected' : ''}>Menos tiempo (pasadas, carreras)</option><option value="Más" ${E.mejor === 'Más' ? 'selected' : ''}>Más tiempo (plancha, isométricos)</option></select>` : ''}
    <div class="two"><div>${input('series', 'Series', 'inputmode="numeric"')}</div><div>${input('incremento', tiempo ? 'Botones +/− (seg)' : 'Botones +/− (kg)', 'inputmode="decimal"')}</div></div>
    ${input('objetivo', 'Objetivo (opcional)', 'placeholder="Ej.: Al fallo (8-10)"')}
    ${tiempo ? '' : `${input('suplente', 'Ejercicio suplente (opcional)', 'placeholder="Si la máquina está ocupada"')}
    <div class="two"><div>${input('ajuste', 'Suplente: % más de peso', 'inputmode="numeric" placeholder="20"')}</div><div>${input('orden', 'Orden en el día', 'inputmode="numeric"')}</div></div>
    ${input('suplenteMolestia', 'Suplente cuando hay molestia (opcional)', 'placeholder="Ej.: Hack 2 (una pierna)"')}`}
    ${tiempo ? input('orden', 'Orden en el día', 'inputmode="numeric"') : ''}
    ${input('nota', 'Nota (opcional)')}
    <label class="check"><input type="checkbox" data-e="activo" ${E.activo !== 'No' ? 'checked' : ''}> Activo (si lo desactivas, se oculta pero conserva su historial)</label>
  </div>
  <div class="footer-bar"><div><a class="btn" href="#/ejercicios">Cancelar</a><button class="btn primary block" data-act="saveEx">Guardar</button></div></div>`;
}

function viewAjustes() {
  const fallidos = S.failed.map((f, i) => `<div><div class="grow"><div class="name">${esc(f.op.type === 'entry' ? `${fmtDate(f.op.fecha)} · ${f.op.ejercicio}` : f.op.type === 'exercise' ? `Ejercicio: ${f.op.ex.ejercicio}` : 'Borrado')}</div>
    <div class="small" style="color:var(--bad)">${esc(f.error)}</div></div>
    <button class="btn small" data-act="retryFailed" data-i="${i}">Reintentar</button><button class="btn small danger" data-act="dropFailed" data-i="${i}">Descartar</button></div>`).join('');
  const pendientes = S.queue.map((op) => `<div><div class="grow small">${esc(op.type === 'entry' ? `${fmtDate(op.fecha)} · ${op.ejercicio}${op.variante === 'Suplente' ? ' (suplente)' : ''}${op.modo === 'Molestia' ? ' 🩹' : ''}` : op.type === 'exercise' ? `Ejercicio: ${op.ex.ejercicio}` : 'Eliminar registro ' + op.entrada.split('|')[0])}</div></div>`).join('');
  return topbar('Ajustes') + `<div class="wrap form">
    ${pillHtml()}
    <h2>Conexión con tu hoja</h2>
    <label class="lbl" for="cfg-url">URL de la aplicación web</label>
    <input id="cfg-url" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(S.cfg.url)}">
    <div class="help">Apps Script → Implementar → Gestionar implementaciones → copiar la URL que termina en <code>/exec</code>.</div>
    <label class="lbl" for="cfg-token">Clave</label>
    <input id="cfg-token" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="La ves en la pestaña Configuración de la hoja" value="${esc(S.cfg.token)}">
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="saveCfg">Guardar y probar</button><button class="btn" data-act="syncNow">Sincronizar ahora</button></div>

    <h2>Pendientes de enviar (${S.queue.length})</h2>
    ${S.queue.length ? `<div class="list">${pendientes}</div><p class="help">Se envían solos cuando vuelve la señal. No borres los datos de la app mientras haya pendientes.</p>` : '<p class="small muted">Nada pendiente. Todo está en tu hoja.</p>'}
    ${S.failed.length ? `<h2>Con error (${S.failed.length})</h2><div class="list">${fallidos}</div>` : ''}

    <h2>Respaldo</h2>
    <p class="small muted">Descarga un archivo con todo lo que tiene el celular (incluye lo no enviado).</p>
    <button class="btn" data-act="exportar">Descargar respaldo</button>

    <h2>Instalar en el celular</h2>
    <p class="small muted"><b>Android (Chrome):</b> menú ⋮ → <i>Instalar app</i> o <i>Agregar a pantalla de inicio</i>.<br>
    <b>iPhone (Safari):</b> botón Compartir → <i>Agregar a inicio</i>.<br>Después ábrela siempre desde ese ícono: funciona sin señal.</p>

    <h2>Avanzado</h2>
    <div class="row"><button class="btn small" data-act="update">Buscar actualización</button><button class="btn small danger" data-act="reset">Borrar datos del celular</button></div>
    <p class="help">Versión ${APP_VERSION}</p>
  </div>` + nav('ajustes');
}

/* ---------------- enrutado y render ---------------- */
function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', arg: parts[1], q: new URLSearchParams(qs || '') };
}

function render() {
  const r = route();
  const prev = S.route;
  S.route = r;
  if (r.name !== 'ej') F = null;
  if (r.name !== 'editar') E = null;
  document.body.classList.remove('molestia');
  if (r.name === '' || r.name === 'dia') document.body.classList.toggle('molestia', S.modo === 'Molestia');
  document.body.classList.toggle('sin-nav', r.name === 'ej' || r.name === 'editar');
  let html;
  switch (r.name) {
    case 'dia': html = viewDia(r.arg); break;
    case 'ej': html = viewEj(r.arg, r.q); break;
    case 'progreso': html = r.arg ? viewProgresoEj(r.arg, r.q) : viewProgreso(); break;
    case 'ejercicios': html = viewEjercicios(); break;
    case 'editar': html = viewEditar(r.arg, r.q); break;
    case 'ajustes': html = viewAjustes(); break;
    default: html = viewHome();
  }
  $app.innerHTML = html;
  if (!prev || prev.name !== r.name || prev.arg !== r.arg) window.scrollTo(0, 0);
}

// Tras sincronizar no se redibuja un formulario a medio cargar (se perdería el foco): solo el indicador.
function softRender() {
  const r = S.route || route();
  if (r.name === 'ej' || r.name === 'editar' || (r.name === 'ajustes' && document.activeElement && document.activeElement.tagName === 'INPUT')) updatePill();
  else render();
}

let toastTimer;
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

/* ---------------- acciones ---------------- */
const ACT = {
  pill() { if (!S.cfg.url || !S.cfg.token) location.hash = '#/ajustes'; else sync(); },
  syncNow() { if (!S.cfg.url) return toast('Primero guarda la URL y la clave', 'error'); sync(); },
  go(t) { location.replace(t.dataset.url); },
  modoGlobal(t) { S.modo = t.dataset.v; store(K.modo, S.modo); render(); },
  modoEj(t) {
    S.modo = t.dataset.v; store(K.modo, S.modo);
    location.replace(`#/ej/${enc(F.exId)}?v=${F.variante}&m=${S.modo}&f=${F.fecha}`);
  },
  step(t) {
    const i = +t.dataset.i, f = t.dataset.f, d = +t.dataset.d;
    const ex = view().byId.get(F.exId);
    const inc = f === 'reps' ? 1 : ex.incremento;
    let v = num(F.series[i][f]);
    if (v === null) {
      const desdeArriba = i > 0 ? num(F.series[i - 1][f]) : null;
      const ref = F.ref && F.ref.series[i] ? F.ref.series[i][f] : null;
      v = desdeArriba ?? ref ?? 0;
    } else v = roundTo(v + d * inc, 0.01);
    if ((f === 'reps' || f === 'tiempo') && v < 0) v = 0;
    F.series[i][f] = f === 'tiempo' ? String(Math.round(v)) : inNum(v);
    const input = document.getElementById(`f-${f}-${i}`);
    if (input) input.value = F.series[i][f];
    afterSerieChange(ex, i);
  },
  addSerie() {
    const last = F.series[F.series.length - 1] || { reps: '', peso: '', tiempo: '' };
    F.series.push({ ...last });
    saveDraft();
    render();
  },
  delSerie() { if (F.series.length > 1) { F.series.pop(); saveDraft(); render(); } },
  discardDraft() {
    delete S.drafts[F.entrada]; store(K.drafts, S.drafts);
    F = null; render();
  },
  saveEj() {
    const ex = view().byId.get(F.exId);
    const series = F.series.map((s) => ({ reps: num(s.reps), peso: num(s.peso), tiempo: num(s.tiempo) }));
    while (series.length && isEmptySet(series[series.length - 1])) series.pop();
    if (!series.length) return toast('Carga al menos una serie', 'error');
    const op = {
      type: 'entry', opId: uid(), entrada: F.entrada, fecha: F.fecha, dia: ex.dia, exId: ex.id, ejercicio: label(ex),
      ejecutado: ejecutado(ex, F.variante, F.modo), variante: F.variante, modo: F.modo, series, nota: (F.nota || '').trim(), ts: Date.now()
    };
    if (!enqueue(op)) return;
    delete S.drafts[F.entrada]; store(K.drafts, S.drafts);
    F = null;
    toast(navigator.onLine ? 'Guardado ✓' : 'Guardado en el celular ✓ Se envía cuando haya señal');
    location.hash = `#/dia/${enc(ex.dia)}`;
    sync();
  },
  delEntry() {
    if (!confirm('¿Eliminar el registro de este ejercicio en esta fecha?')) return;
    const entrada = F.entrada;
    const enServidor = (S.server.historial || []).some((e) => e.entrada === entrada);
    S.queue = S.queue.filter((o) => !((o.type === 'entry' || o.type === 'deleteEntry') && o.entrada === entrada));
    if (enServidor) S.queue.push({ type: 'deleteEntry', opId: uid(), entrada });
    store(K.queue, S.queue); invalidate();
    delete S.drafts[entrada]; store(K.drafts, S.drafts);
    const dia = view().byId.get(F.exId).dia;
    F = null;
    toast('Registro eliminado');
    location.hash = `#/dia/${enc(dia)}`;
    sync();
  },
  saveEx() {
    const V = view();
    const ex = {};
    EX_FIELDS.forEach((f) => { ex[f] = E[f]; });
    ex.dia = String(ex.dia || '').trim();
    ex.ejercicio = String(ex.ejercicio || '').trim();
    ex.grupo = String(ex.grupo || '').trim();
    if (!ex.dia || ex.dia === '__nuevo') return toast('Escribe el nombre del día', 'error');
    if (!ex.ejercicio) return toast('Escribe el nombre del ejercicio', 'error');
    ex.series = Math.max(1, Math.round(num(ex.series) || 3));
    ex.incremento = num(ex.incremento) || (ex.medicion === 'Tiempo' ? 5 : 2.5);
    ex.ajuste = num(ex.ajuste) ?? '';
    if (ex.medicion !== 'Tiempo' && ex.mejor !== 'Más') ex.mejor = 'Más';
    if (ex.medicion === 'Tiempo') { ex.suplente = ''; ex.ajuste = ''; ex.suplenteMolestia = ''; }
    let orden = num(ex.orden);
    if (orden === null) orden = Math.max(0, ...V.catalogo.filter((e) => e.dia === ex.dia && e.id !== ex.id).map((e) => e.orden)) + 1;
    ex.orden = orden;
    EX_FIELDS.forEach((f) => { if (ex[f] === undefined || ex[f] === null) ex[f] = ''; });
    if (!enqueue({ type: 'exercise', opId: uid(), ex })) return;
    E = null;
    toast('Ejercicio guardado ✓');
    location.hash = '#/ejercicios';
    sync();
  },
  async saveCfg() {
    const url = document.getElementById('cfg-url').value.trim();
    const token = document.getElementById('cfg-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      if (!confirm('La URL no parece de Google Apps Script (debería empezar con https://script.google.com/). ¿Guardarla igual?')) return;
    }
    S.cfg = { url, token };
    store(K.cfg, S.cfg);
    toast('Probando conexión…');
    try {
      await api('GET', { action: 'ping' });
      toast('Conexión OK ✓');
      S.sync.error = null;
      sync();
    } catch (e) {
      S.sync.error = e;
      toast('No se pudo conectar: ' + e.message, 'error');
      render();
    }
  },
  exportar() {
    const data = { app: 'Registro CrePer', version: APP_VERSION, exportado: new Date().toISOString(), servidor: S.server, pendientes: S.queue, conError: S.failed };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `creper-respaldo-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  },
  retryFailed(t) {
    const f = S.failed.splice(+t.dataset.i, 1)[0];
    store(K.failed, S.failed);
    if (f) enqueue({ ...f.op, opId: uid() });
    render(); sync();
  },
  dropFailed(t) {
    if (!confirm('¿Descartar este cambio? No se enviará a la hoja.')) return;
    S.failed.splice(+t.dataset.i, 1); store(K.failed, S.failed); render();
  },
  async update() {
    try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) await reg.update(); } catch (e) { /* sin señal */ }
    location.reload();
  },
  reset() {
    const n = S.queue.length;
    if (!confirm(n ? `Hay ${n} cambio(s) SIN ENVIAR que se perderán. ¿Borrar igual los datos del celular?` : '¿Borrar los datos guardados en el celular? Tu hoja de Google no se toca y la conexión se conserva.')) return;
    [K.data, K.queue, K.failed, K.drafts, K.lastSync].forEach((k) => localStorage.removeItem(k));
    S.server = { catalogo: [], historial: [] }; S.queue = []; S.failed = []; S.drafts = {}; S.lastSync = 0;
    invalidate(); render(); sync();
  }
};

function afterSerieChange(ex, i) {
  const ind = document.getElementById(`ind-${i}`);
  if (ind) ind.innerHTML = indHtml(ex, i);
  const h = document.getElementById(`h-${i}`);
  if (h) { const t = num(F.series[i].tiempo); h.textContent = t !== null ? '= ' + fmtTime(t) : 'm:ss'; }
  saveDraft();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = ACT[t.dataset.act];
  if (fn) { e.preventDefault(); fn(t, e); }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.sf && F) {
    F.series[+t.dataset.i][t.dataset.sf] = t.value;
    afterSerieChange(view().byId.get(F.exId), +t.dataset.i);
  } else if (t.id === 'nota' && F) {
    F.nota = t.value; saveDraft();
  } else if (t.dataset.e && E && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
    E[t.dataset.e] = t.value;
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'fecha' && F && /^\d{4}-\d{2}-\d{2}$/.test(t.value)) {
    location.replace(`#/ej/${enc(F.exId)}?v=${F.variante}&m=${F.modo}&f=${t.value}`);
  } else if (t.dataset.e && E) {
    if (t.type === 'checkbox') { E.activo = t.checked ? 'Sí' : 'No'; return; }
    if (t.dataset.e === 'dia' && t.tagName === 'SELECT') {
      E._diaNuevo = t.value === '__nuevo';
      E.dia = E._diaNuevo ? '' : t.value;
      render();
    } else if (t.dataset.e === 'medicion') {
      const antes = E.medicion;
      E.medicion = t.value;
      if (t.value === 'Tiempo' && antes !== 'Tiempo') { E.mejor = 'Menos'; if (Number(E.incremento) === 2.5) E.incremento = 5; }
      if (t.value !== 'Tiempo' && antes === 'Tiempo') { E.mejor = 'Más'; if (Number(E.incremento) === 5) E.incremento = 2.5; }
      render();
    } else if (t.tagName === 'SELECT') {
      E[t.dataset.e] = t.value;
    }
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { S.sync.error = new ApiError('Sin conexión', 'network'); updatePill(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (S.queue.length || Date.now() - S.lastSync > 5 * 60000) sync(); else updatePill();
}, 45000);

/* ---------------- arranque ---------------- */
(function start() {
  // limpiar borradores viejos (más de 7 días)
  const limite = Date.now() - 7 * 86400000;
  Object.keys(S.drafts).forEach((k) => { if (!S.drafts[k] || (S.drafts[k].ts || 0) < limite) delete S.drafts[k]; });
  store(K.drafts, S.drafts);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  render();
  sync();
})();
