/* Registro CrePer — app del celular.
 * Todo se guarda primero en el celular (funciona sin señal) y se envía a tu Google Sheet cuando hay conexión.
 */
'use strict';

const APP_VERSION = '1.1.0';
const K = {
  cfg: 'creper.cfg', data: 'creper.data', queue: 'creper.queue', failed: 'creper.failed',
  modo: 'creper.modo', drafts: 'creper.drafts', lastSync: 'creper.lastSync',
  fecha: 'creper.fecha', descarga: 'creper.descarga'
};
const SUBE = '↗️', IGUAL = '⛔️', BAJA = '↘️';
const ORIGEN_EXCEL = 'Excel original';
const MEDICIONES = ['Peso y reps', 'Solo reps', 'Tiempo'];
const MODOS = ['Normal', 'Molestia', 'Descarga'];
const MODO_ICONO = { Normal: '', Molestia: '🩹', Descarga: '🔋' };
const COMBOS = [['Titular', 'Normal'], ['Suplente', 'Normal'], ['Titular', 'Molestia'], ['Suplente', 'Molestia'], ['Titular', 'Descarga'], ['Suplente', 'Descarga']];
const FECHA_TTL = 2 * 3600000; // una fecha pasada elegida se recuerda 2 h desde el último uso
const DIAS_SEM = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
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
  modo: MODOS.includes(load(K.modo, 'Normal')) ? load(K.modo, 'Normal') : 'Normal',
  drafts: load(K.drafts, {}),
  lastSync: load(K.lastSync, 0),
  fecha: load(K.fecha, null),
  descargaPct: Number(load(K.descarga, 60)) || 60,
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
function fmtDia(f) {
  if (!f) return '';
  const [y, m, d] = f.split('-').map(Number);
  return `${DIAS_SEM[new Date(y, m - 1, d).getDay()]} ${fmtDate(f)}`;
}
const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
// "volver" solo acepta pantallas propias de la app
const safeVolver = (v) => (typeof v === 'string' && /^#\/(dia|progreso|ej|ejercicios)(\/|\?|$)/.test(v) ? v : null);
function ejUrl(exId, v, m, f, volver) {
  return `#/ej/${enc(exId)}?v=${v}&m=${m}&f=${f}${volver ? '&volver=' + enc(volver) : ''}`;
}

/* Fecha del entrenamiento: se elige una vez (en la pantalla del día) y vale para todos los ejercicios */
function fechaSesion() {
  const f = S.fecha;
  if (f && esFecha(f.f) && f.f < today() && Date.now() - (f.ts || 0) < FECHA_TTL) return f.f;
  return today();
}
function setFechaSesion(f) {
  S.fecha = esFecha(f) && f < today() ? { f, ts: Date.now() } : null;
  store(K.fecha, S.fecha);
}
function tocarFechaSesion(f) {
  if (S.fecha && S.fecha.f === f) { S.fecha.ts = Date.now(); store(K.fecha, S.fecha); }
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

/* Semana de descarga: cargas al X% de la última sesión normal. Solo se reduce el peso (o las reps si no hay peso). */
function escalarDescarga(ex, s, f) {
  const out = { reps: num(s.reps), peso: num(s.peso), tiempo: num(s.tiempo) };
  if (ex.medicion === 'Peso y reps' && out.peso !== null) out.peso = roundTo(out.peso * f, ex.incremento);
  else if (ex.medicion === 'Solo reps' && out.reps !== null) out.reps = Math.max(1, Math.round(out.reps * f));
  return out;
}
function baseDescarga(ex, variante, fecha) {
  const pct = S.descargaPct / 100;
  let base = lastEntry(ex.id, variante, 'Normal', fecha);
  if (base) return { base, f: pct, desdeTitular: false };
  if (variante === 'Suplente') {
    base = lastEntry(ex.id, 'Titular', 'Normal', fecha);
    if (base) return { base, f: pct * (1 + (Number(ex.ajuste) || 0) / 100), desdeTitular: true };
  }
  return null;
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
        const r = { ...a, tr: '', tc: '', igual: 1, excel: false };
        // Series migradas del Excel (y no modificadas desde entonces): se respetan sus flechas y "sesiones igual"
        const x = s.excel || ((s.origen || e.origen) === ORIGEN_EXCEL ? { tendReps: s.tendReps, tendPeso: s.tendPeso, igual: s.igual } : null);
        if (x) { r.tr = x.tendReps || ''; r.tc = x.tendPeso || ''; r.igual = num(x.igual); r.excel = true; }
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
const doneOn = (exId, fecha) => view().historial.some((e) => e.exId === exId && e.fecha === fecha);

/* ---------------- sincronización ---------------- */
class ApiError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

// Todo va por POST: la clave viaja dentro del mensaje, nunca en la dirección (URL).
async function api(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    // text/plain evita el "preflight" CORS que Apps Script no admite
    const res = await fetch(S.cfg.url, {
      method: 'POST', body: JSON.stringify({ ...payload, token: S.cfg.token }),
      signal: ctrl.signal, redirect: 'follow', cache: 'no-store'
    });
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

// Agrega uno o varios cambios a la cola en un solo guardado (todo o nada).
// Un cambio nuevo reemplaza a uno pendiente sobre el mismo registro o ejercicio.
function enqueue(...ops) {
  let q = S.queue;
  ops.forEach((op) => {
    if (op.type === 'entry' || op.type === 'deleteEntry') {
      q = q.filter((o) => !((o.type === 'entry' || o.type === 'deleteEntry') && o.entrada === op.entrada));
    } else if (op.type === 'exercise') {
      q = q.filter((o) => !(o.type === 'exercise' && o.ex.id === op.ex.id));
    }
    q = [...q, op];
  });
  if (!store(K.queue, q)) return false;
  S.queue = q;
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
      const res = await api(batch.length ? { action: 'sync', ops: batch } : { action: 'bootstrap', ops: [] });
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
  return `<header class="bar">${back ? `<a class="icon-btn" href="${esc(back)}" aria-label="Volver">‹</a>` : ''}<h1>${esc(title)}</h1>${right || ''}</header>`;
}
function nav(active) {
  const items = [['', '🏋️', 'Entrenar'], ['progreso', '📈', 'Progreso'], ['ejercicios', '🗂️', 'Ejercicios'], ['ajustes', '⚙️', 'Ajustes']];
  return `<nav class="nav">${items.map(([r, i, t]) => `<a href="#/${r}" class="${active === r ? 'on' : ''}"><span>${i}</span>${t}</a>`).join('')}</nav>`;
}
function modoSeg(actual, act) {
  const b = (v, txt, cls) => `<button class="${actual === v ? 'on ' + cls : ''}" data-act="${act}" data-v="${v}">${txt}</button>`;
  return `<div class="seg modos" role="group" aria-label="Modo">${b('Normal', 'Normal', '')}${b('Molestia', '🩹 Molestia', 'molestia')}${b('Descarga', '🔋 Descarga', 'descarga')}</div>`;
}
const modoClase = (m) => (m === 'Molestia' ? 'molestia' : m === 'Descarga' ? 'descarga' : '');
const modoTxt = (m) => (m === 'Normal' ? 'normal' : m === 'Molestia' ? 'con molestia 🩹' : 'en descarga 🔋');
function bannerModo(modo) {
  if (modo === 'Molestia') return '<div class="banner molestia">🩹 Modo molestia: verás y guardarás las cargas reducidas, separadas de tu progreso normal.</div>';
  if (modo === 'Descarga') return `<div class="banner descarga">🔋 Semana de descarga: tus pesos se precargan al ${S.descargaPct}% de lo normal y lo que guardes no cuenta en tu progreso. Al terminar la semana, vuelve a Normal.</div>`;
  return '';
}
function fechaBar(fecha) {
  const hoy = fecha === today();
  return `<div class="fecha-bar${hoy ? '' : ' pasada'}">
    <label for="fechaSesion">${hoy ? '📅 Entrenamiento de <b>hoy</b>' : `⚠️ Entrenamiento del <b>${fmtDia(fecha)}</b> (no es hoy)`}</label>
    <input id="fechaSesion" type="date" value="${fecha}" max="${today()}">
    ${hoy ? '' : '<button class="btn small" data-act="fechaHoy">Volver a hoy</button>'}
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
  const fecha = fechaSesion();
  const esHoy = fecha === today();
  if (!V.days.length) {
    body += `<div class="empty">${S.cfg.url ? 'Todavía no hay ejercicios. Toca el indicador de arriba para traerlos de tu hoja, o crea uno en 🗂️ Ejercicios.' : ''}</div>`;
  } else {
    body += V.days.map((d) => {
      const exs = exercisesOf(d);
      const ids = new Set(exs.map((e) => e.id));
      const fechas = V.historial.filter((e) => ids.has(e.exId)).map((e) => e.fecha).sort();
      const ultima = fechas.length ? fechas[fechas.length - 1] : null;
      const hechos = exs.filter((e) => doneOn(e.id, fecha)).length;
      return `<a class="card day" style="--c:${dayColor(d)}" href="#/dia/${enc(d)}">
        <div class="row"><div class="title">${esc(d)}</div><span class="spacer"></span>${hechos ? `<span class="badge ok">${hechos}/${exs.length} ${esHoy ? 'hoy' : fmtDate(fecha)}</span>` : ''}</div>
        <div class="sub">${exs.length} ejercicio${exs.length === 1 ? '' : 's'}${ultima ? ` · última vez ${relDate(ultima)}` : ''}</div>
        ${hechos ? `<div class="progress"><i style="width:${Math.round((hechos / exs.length) * 100)}%"></i></div>` : ''}
      </a>`;
    }).join('');
  }
  const avisoFecha = esHoy ? '' : `<div class="banner warn row"><span class="grow">📅 Estás cargando el entrenamiento del <b>${fmtDia(fecha)}</b>.</span><button class="btn small" data-act="fechaHoy">Volver a hoy</button></div>`;
  return topbar('Registro CrePer') + `<div class="wrap stack">${pillHtml()}${modoSeg(S.modo, 'modoGlobal')}
    ${bannerModo(S.modo)}${avisoFecha}
    ${body}</div>` + nav('');
}

function viewDia(dia) {
  const exs = exercisesOf(dia);
  if (!exs.length) return topbar(dia, '#/') + `<div class="empty">No hay ejercicios activos en este día.</div>` + nav('');
  const fecha = fechaSesion();
  const esHoy = fecha === today();
  const modo = S.modo;
  const hechos = exs.filter((e) => doneOn(e.id, fecha)).length;
  const cards = exs.map((ex) => {
    const hoy = entryOn(ex.id, 'Titular', modo, fecha) || entryOn(ex.id, 'Suplente', modo, fecha);
    const hoyOtro = hoy || view().historial.find((e) => e.exId === ex.id && e.fecha === fecha);
    // Qué series mostrar: lo cargado en esa fecha o, si no hay, la referencia para hoy
    let chips = null;
    let txt = '';
    if (hoy) {
      chips = hoy;
      txt = (esHoy ? 'Hoy' : fmtDia(fecha)) + (hoy.variante === 'Suplente' ? ' · suplente' : '');
    } else if (modo === 'Descarga') {
      const bd = baseDescarga(ex, 'Titular', fecha);
      if (bd) {
        chips = { series: bd.base.series.map((s) => escalarDescarga(ex, s, bd.f)) };
        txt = ex.medicion === 'Tiempo' ? `Tu última sesión normal (${relDate(bd.base.fecha)})` : `Al ${S.descargaPct}% de tu última sesión normal (${relDate(bd.base.fecha)})`;
      } else {
        const pd = lastEntry(ex.id, 'Titular', 'Descarga', fecha) || lastEntry(ex.id, 'Suplente', 'Descarga', fecha);
        if (pd) { chips = pd; txt = 'Última descarga: ' + relDate(pd.fecha); }
      }
    } else {
      const ref = lastEntry(ex.id, 'Titular', modo, fecha) || lastEntry(ex.id, 'Suplente', modo, fecha);
      if (ref) {
        chips = ref;
        txt = 'Última: ' + relDate(ref.fecha) + (ref.variante === 'Suplente' ? ' · suplente' : '');
      } else if (modo === 'Molestia') {
        const n = lastEntry(ex.id, 'Titular', 'Normal', fecha);
        if (n) { chips = n; txt = 'Sin datos con molestia · cargas normales (' + relDate(n.fecha) + ')'; }
      }
    }
    const est = hoy || modo === 'Descarga' ? 0 : maxIgual(lastEntry(ex.id, 'Titular', modo, fecha));
    const sub = [ex.grupo, ex.suplente ? `Suplente: ${ex.suplente}` : '', ex.medicion !== 'Peso y reps' ? ex.medicion : ''].filter(Boolean).join(' · ');
    const badgeHoy = hoyOtro
      ? `<span class="badge ok">✓ ${esHoy ? 'Hoy' : 'Cargado'}${hoyOtro.variante === 'Suplente' ? ' (suplente)' : ''}${hoyOtro.modo !== modo ? (hoyOtro.modo === 'Normal' ? ' (normal)' : ' ' + MODO_ICONO[hoyOtro.modo]) : ''}${hoyOtro.pendiente ? ' ⏳' : ''}</span>`
      : '';
    return `<a class="card ex" style="--c:${dayColor(dia)}" href="${esc(ejUrl(ex.id, 'Titular', modo, fecha))}">
      <div class="row"><div class="title">${esc(ex.ejercicio)}</div><span class="spacer"></span>${badgeHoy}</div>
      <div class="sub">${esc(sub)}</div>
      ${chips ? chipsHtml(ex, chips, false) : '<div class="sub">Sin registros todavía</div>'}
      <div class="row small" style="margin-top:6px">${txt ? `<span class="muted">${esc(txt)}</span>` : ''}
        ${est >= 3 ? `<span class="badge warn">🔁 ${est} sesiones igual</span>` : ''}</div>
    </a>`;
  }).join('');
  return topbar(dia, '#/') + `<div class="wrap stack">${pillHtml()}${modoSeg(modo, 'modoGlobal')}
    ${modo === 'Normal' ? '' : bannerModo(modo)}
    ${fechaBar(fecha)}
    <div class="row small muted">${esHoy ? 'Hoy' : fmtDia(fecha)}: ${hechos} de ${exs.length} ejercicios</div>
    <div class="progress" style="margin-top:4px"><i style="width:${Math.round((hechos / exs.length) * 100)}%"></i></div>
    ${cards}</div>` + nav('');
}

function prefill(ex, variante, modo, fecha) {
  const toForm = (s) => ({ reps: inNum(s.reps), peso: inNum(s.peso), tiempo: s.tiempo === null || s.tiempo === undefined ? '' : String(s.tiempo) });
  const hoy = entryOn(ex.id, variante, modo, fecha);
  if (modo === 'Descarga') {
    // En descarga no se compara con la sesión anterior: se muestra la referencia normal
    const bd = baseDescarga(ex, variante, fecha);
    const normalRef = bd ? bd.base : null;
    if (hoy) return { series: hoy.series.map(toForm), nota: hoy.nota || '', ref: null, normalRef, fuente: 'editando', existing: hoy };
    if (bd) return { series: bd.base.series.map((s) => toForm(escalarDescarga(ex, s, bd.f))), nota: '', ref: null, normalRef, fuente: 'descarga', desdeTitular: bd.desdeTitular };
    const pd = lastEntry(ex.id, variante, 'Descarga', fecha);
    if (pd) return { series: pd.series.map(toForm), nota: '', ref: null, normalRef: null, fuente: 'ultimaDescarga' };
    return { series: Array.from({ length: ex.series }, () => ({ reps: '', peso: '', tiempo: '' })), nota: '', ref: null, fuente: 'nuevo' };
  }
  const ref = lastEntry(ex.id, variante, modo, fecha);
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
    ref: p.ref, normalRef: p.normalRef || null, desdeTitular: !!p.desdeTitular,
    fuente: p.fuente, existing: p.existing || null, fromDraft: !!d,
    nuevaFecha: null, addSup: false, supNombre: '', supAjuste: '', volver: null
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
  if (F.modo === 'Descarga') {
    const n = F.normalRef && F.normalRef.series[i];
    return n ? `<span class="muted">${F.desdeTitular ? 'titular normal' : 'normal'}: ${esc(setTxt(ex, n))}</span>` : '';
  }
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
  const modo = MODOS.includes(q.get('m')) ? q.get('m') : S.modo;
  const fecha = esFecha(q.get('f')) ? q.get('f') : fechaSesion();
  const variante = q.get('v') === 'Suplente' && (ex.suplente || entryOn(ex.id, 'Suplente', modo, fecha)) ? 'Suplente' : 'Titular';
  const volver = safeVolver(q.get('volver'));
  const entrada = `${fecha}|${ex.id}|${variante}|${modo}`;
  if (!F || F.entrada !== entrada) F = initForm(ex, variante, modo, fecha);
  F.volver = volver;
  const url = (v, m, f) => ejUrl(id, v, m, f, volver);

  const pctTxt = F.desdeTitular ? `${S.descargaPct}% de tu última sesión normal del titular (+${ex.ajuste || 0}% por ser suplente)` : `${S.descargaPct}% de tu última sesión normal`;
  const fuente = {
    editando: `✏️ Estás editando lo que guardaste el ${fmtDia(fecha)}.`,
    ultima: F.ref ? `Precargado con tu última vez (${relDate(F.ref.fecha)}). Cambia lo que hiciste distinto.` : '',
    ajuste: `Primera vez con el suplente: pesos sugeridos = titular +${ex.ajuste}%. Ajústalos si hace falta.`,
    titular: 'Primera vez con el suplente: se copiaron los valores del titular. Ajústalos.',
    normal: 'Sin registros con molestia: se copiaron tus cargas normales. Bájalas según te indicó tu entrenador.',
    descarga: ex.medicion === 'Tiempo' ? '🔋 Semana de descarga: se copiaron los tiempos de tu última sesión normal.'
      : `🔋 Semana de descarga: ${ex.medicion === 'Solo reps' ? 'reps' : 'pesos'} al ${pctTxt}. Ajústalos si tu entrenador te indicó otra cosa.`,
    ultimaDescarga: '🔋 Sin sesiones normales para calcular: se copió tu última descarga.',
    nuevo: 'Primera vez: carga tus series.'
  }[F.fuente];

  // Fecha: un registro nuevo usa la del entrenamiento; uno ya guardado se puede mover a otra fecha
  const fechaHtml = F.existing
    ? `<div><label class="small muted" for="fecha">📅 Fecha de este registro</label>
        <input id="fecha" type="date" value="${F.nuevaFecha || fecha}" max="${today()}">
        <div class="small muted" id="fecha-help" style="margin-top:4px">${fechaHelp(fecha)}</div></div>`
    : `<div class="fecha-ej${fecha === today() ? '' : ' pasada'}">📅 ${fecha === today() ? 'Hoy, ' + fmtDia(fecha) : `Entrenamiento del ${fmtDia(fecha)} (no es hoy)`}</div>`;

  const supHtml = ex.suplente || ex.medicion === 'Tiempo' ? '' : F.addSup
    ? `<div class="card form">
        <div class="title" style="font-size:16px">Agregar suplente</div>
        <label class="lbl" for="sup-nombre">Ejercicio suplente</label>
        <input id="sup-nombre" type="text" autocomplete="off" placeholder="Ej.: Hack 2" value="${esc(F.supNombre)}">
        <label class="lbl" for="sup-ajuste">¿Cuánto % más de peso que el titular? (opcional)</label>
        <input id="sup-ajuste" type="text" inputmode="numeric" placeholder="Ej.: 20" value="${esc(F.supAjuste)}">
        <div class="help">Se usa para sugerirte el peso la primera vez que hagas el suplente.</div>
        <div class="row" style="margin-top:12px"><button class="btn small" data-act="cancelSup">Cancelar</button><button class="btn small primary" data-act="saveSup">Guardar suplente</button></div>
      </div>`
    : '<button class="linkbtn plain" data-act="addSup">+ Agregar suplente (por si la máquina está ocupada)</button>';

  const refLinea = modo === 'Descarga'
    ? (F.normalRef ? `<div class="small muted">Última normal${F.desdeTitular ? ' del titular' : ''} (${fmtDate(F.normalRef.fecha)}): ${F.normalRef.series.map((s) => esc(setTxt(ex, s))).join(' · ')}</div>` : '')
    : (F.ref ? `<div class="small muted">Última vez (${fmtDate(F.ref.fecha)}): ${F.ref.series.map((s) => esc(setTxt(ex, s))).join(' · ')}</div>` : '');

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
  document.body.classList.remove('molestia', 'descarga');
  if (modoClase(modo)) document.body.classList.add(modoClase(modo));
  return topbar(ex.ejercicio, volver || `#/dia/${enc(ex.dia)}`) + `<div class="wrap stack">
    <div class="small muted">${esc(ex.grupo)}${info ? ' · ' + info : ''}</div>
    ${ex.suplente || variante === 'Suplente' ? `<div class="seg" role="group" aria-label="Variante">
      <button class="${variante === 'Titular' ? 'on' : ''}" data-act="go" data-url="${esc(url('Titular', modo, fecha))}">Titular<small>${esc(ex.ejercicio)}</small></button>
      <button class="${variante === 'Suplente' ? 'on' : ''}" data-act="go" data-url="${esc(url('Suplente', modo, fecha))}">Suplente<small>${esc(ejecutado(ex, 'Suplente', modo))}</small></button>
    </div>` : ''}
    ${supHtml}
    ${modoSeg(modo, 'modoEj')}
    ${fechaHtml}
    ${F.fromDraft ? '<div class="banner warn">Recuperé lo que estabas cargando y no habías guardado. <button class="linkbtn" data-act="discardDraft">Descartar</button></div>' : ''}
    ${fuente ? `<div class="banner ${F.fuente === 'descarga' || F.fuente === 'ultimaDescarga' ? 'descarga' : 'info'}">${fuente}</div>` : ''}
    ${refLinea}
    ${series}
    <div class="row"><button class="btn small" data-act="addSerie">+ Serie</button><button class="btn small" data-act="delSerie" ${F.series.length <= 1 ? 'disabled' : ''}>− Quitar última</button></div>
    <label class="small muted" for="nota">Nota (opcional)</label>
    <textarea id="nota" placeholder="Ej.: la máquina estaba ocupada, molestia en la rodilla…">${esc(F.nota)}</textarea>
    <div class="row">
      ${F.existing ? '<button class="linkbtn" data-act="delEntry">Eliminar este registro</button><span class="spacer"></span>' : ''}
      <a class="linkbtn plain" href="#/editar/${enc(ex.id)}?volver=${enc(location.hash)}">✏️ Editar ejercicio</a>
    </div>
  </div>
  <div class="footer-bar"><div><button class="btn primary block" data-act="saveEj">${F.existing ? (F.nuevaFecha && F.nuevaFecha !== fecha ? 'Guardar y mover' : 'Guardar cambios') : 'Guardar'}</button></div></div>`;
}

function fechaHelp(fecha) {
  if (F && F.nuevaFecha && F.nuevaFecha !== fecha) return `Al guardar, este registro <b>se mueve</b> del ${fmtDia(fecha)} al <b>${fmtDia(F.nuevaFecha)}</b> (no se duplica).`;
  return 'Si te equivocaste de día, cámbiala acá: el registro se mueve, no se duplica.';
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
    const total = COMBOS.reduce((n, [cv, cm]) => n + entries(ex.id, cv, cm).length, 0);
    return `<a href="#/progreso/${enc(ex.id)}"><div class="grow"><div class="name">${esc(ex.ejercicio)}</div>
      <div class="small muted">${total} sesión(es)${l.length ? ' · última ' + relDate(l[l.length - 1].fecha) : ''}</div></div><div class="small">${cambio}</div></a>`;
  }).join('')}</div>`).join('');
  return topbar('Progreso') + `<div class="wrap">${body}</div>` + nav('progreso');
}

function viewProgresoEj(id, q) {
  const V = view();
  const ex = V.byId.get(id);
  if (!ex) return topbar('Progreso', '#/progreso') + '<div class="empty">No encontré este ejercicio.</div>' + nav('progreso');
  const combos = COMBOS.filter(([v, m]) => entries(id, v, m).length);
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
  const est = last && m !== 'Descarga' ? last.series.map((s, i) => (s.igual >= 2 ? `serie ${i + 1}: ${s.igual}` : '')).filter(Boolean) : [];
  const etiquetaCombo = (c) => `${c[0]}${MODO_ICONO[c[1]] ? ' ' + MODO_ICONO[c[1]] : ''}`;
  const aqui = url(v, m, met.k);
  return topbar(ex.ejercicio, '#/progreso') + `<div class="wrap stack">
    <div class="small muted">${esc(ex.dia)} · ${esc(ex.grupo)}</div>
    ${combos.length > 1 ? `<div class="seg${combos.length > 2 ? ' grid2' : ''}">${combos.map((c) => `<a class="${c[0] === v && c[1] === m ? 'on' : ''}" href="${url(c[0], c[1], met.k)}">${etiquetaCombo(c)}</a>`).join('')}</div>` : ''}
    <div class="seg">${metrics.map((x) => `<a class="${x.k === met.k ? 'on' : ''}" href="${url(v, m, x.k)}">${esc(x.name)}</a>`).join('')}</div>
    <div class="card">${chartSvg(pts, met)}</div>
    ${stats}
    ${est.length ? `<div class="banner ${est.some((t) => +t.split(': ')[1] >= 3) ? 'warn' : 'info'}">🔁 Sesiones iguales seguidas — ${est.join(' · ')}</div>` : ''}
    ${m === 'Descarga' ? '<div class="banner descarga">🔋 Sesiones de descarga: se guardan aparte y no cuentan en tu progreso ni en las "sesiones igual".</div>' : ''}
    <h2>Sesiones</h2>
    <p class="small muted" style="margin:-4px 0 8px">Toca una sesión para corregirla, cambiarle la fecha o borrarla.</p>
    <div class="list">${list.slice().reverse().map((e) => `<a class="sess" href="${esc(ejUrl(id, v, m, e.fecha, aqui))}"><div class="date">${fmtDate(e.fecha)}</div>
      <div class="grow">${chipsHtml(ex, e, m !== 'Descarga')}${e.nota ? `<div class="small muted" style="margin-top:4px">${esc(e.nota)}</div>` : ''}</div>
      ${e.pendiente ? '<span title="Pendiente de enviar">⏳</span>' : ''}<span class="muted">›</span></a>`).join('')}</div>
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
  E._volver = safeVolver(q.get('volver'));
  const volver = E._volver || '#/ejercicios';
  const grupos = [...new Set(V.catalogo.map((e) => e.grupo).filter(Boolean))];
  const tiempo = E.medicion === 'Tiempo';
  const input = (f, lab, extra, help) => `<label class="lbl" for="e-${f}">${lab}</label><input id="e-${f}" type="text" data-e="${f}" value="${esc(E[f])}" ${extra || ''}>${help ? `<div class="help">${help}</div>` : ''}`;
  return topbar(isNew ? 'Nuevo ejercicio' : 'Editar ejercicio', volver) + `<div class="wrap form">
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
  <div class="footer-bar"><div><a class="btn" href="${esc(volver)}">Cancelar</a><button class="btn primary block" data-act="saveEx">Guardar</button></div></div>`;
}

function viewAjustes() {
  const fallidos = S.failed.map((f, i) => `<div><div class="grow"><div class="name">${esc(f.op.type === 'entry' ? `${fmtDate(f.op.fecha)} · ${f.op.ejercicio}` : f.op.type === 'exercise' ? `Ejercicio: ${f.op.ex.ejercicio}` : 'Borrado')}</div>
    <div class="small" style="color:var(--bad)">${esc(f.error)}</div></div>
    <button class="btn small" data-act="retryFailed" data-i="${i}">Reintentar</button><button class="btn small danger" data-act="dropFailed" data-i="${i}">Descartar</button></div>`).join('');
  const pendientes = S.queue.map((op) => `<div><div class="grow small">${esc(op.type === 'entry' ? `${fmtDate(op.fecha)} · ${op.ejercicio}${op.variante === 'Suplente' ? ' (suplente)' : ''}${MODO_ICONO[op.modo] ? ' ' + MODO_ICONO[op.modo] : ''}` : op.type === 'exercise' ? `Ejercicio: ${op.ex.ejercicio}` : 'Eliminar registro del ' + fmtDate(op.entrada.split('|')[0]))}</div></div>`).join('');
  const vHoja = S.server && S.server.version ? String(S.server.version) : '';
  const hojaVieja = vHoja && parseFloat(vHoja) < 1.1;
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

    <h2>Semana de descarga</h2>
    <label class="lbl" for="cfg-desc">En modo 🔋 Descarga, precargar los pesos al</label>
    <select id="cfg-desc">${[40, 50, 55, 60, 65, 70, 75, 80].map((p) => `<option value="${p}" ${p === S.descargaPct ? 'selected' : ''}>${p}% de tu carga normal</option>`).join('')}</select>
    <div class="help">Lo que guardes en modo Descarga queda aparte: no cuenta en tu progreso ni en las "sesiones igual".</div>

    <h2>Respaldo</h2>
    <p class="small muted">Descarga un archivo con todo lo que tiene el celular (incluye lo no enviado).</p>
    <button class="btn" data-act="exportar">Descargar respaldo</button>

    <h2>Instalar en el celular</h2>
    <p class="small muted"><b>Android (Chrome):</b> menú ⋮ → <i>Instalar app</i> o <i>Agregar a pantalla de inicio</i>.<br>
    <b>iPhone (Safari):</b> botón Compartir → <i>Agregar a inicio</i>.<br>Después ábrela siempre desde ese ícono: funciona sin señal.</p>

    <h2>Avanzado</h2>
    <div class="row"><button class="btn small" data-act="update">Buscar actualización</button><button class="btn small danger" data-act="reset">Borrar datos del celular</button></div>
    <p class="help">Versión de la app ${APP_VERSION}${vHoja ? ' · hoja ' + esc(vHoja) : ''}</p>
    ${hojaVieja ? '<div class="banner warn">Falta actualizar el script de tu hoja (Apps Script) a la versión 1.1. La app funciona igual, pero conviene hacerlo: mira la guía de actualización.</div>' : ''}
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
  document.body.classList.remove('molestia', 'descarga');
  if ((r.name === '' || r.name === 'dia') && modoClase(S.modo)) document.body.classList.add(modoClase(S.modo));
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
    location.replace(ejUrl(F.exId, F.variante, S.modo, F.fecha, F.volver));
  },
  fechaHoy() { setFechaSesion(null); render(); },
  addSup() { F.addSup = true; render(); const el = document.getElementById('sup-nombre'); if (el) el.focus(); },
  cancelSup() { F.addSup = false; F.supNombre = ''; F.supAjuste = ''; render(); },
  saveSup() {
    const ex = view().byId.get(F.exId);
    const nombre = String(F.supNombre || '').trim();
    if (!nombre) return toast('Escribe el nombre del suplente', 'error');
    const ajuste = num(F.supAjuste);
    const exOp = {};
    EX_FIELDS.forEach((f) => { exOp[f] = ex[f] === undefined || ex[f] === null ? '' : ex[f]; });
    exOp.suplente = nombre;
    exOp.ajuste = ajuste === null ? '' : ajuste;
    if (!enqueue({ type: 'exercise', opId: uid(), ex: exOp })) return;
    const { exId, modo, fecha, volver } = F;
    F = null;
    toast('Suplente agregado ✓');
    location.replace(ejUrl(exId, 'Suplente', modo, fecha, volver));
    sync();
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
    // Las series migradas del Excel que no cambiaste conservan sus flechas y "sesiones igual"
    if (F.existing) {
      series.forEach((s, i) => {
        const o = F.existing.series[i];
        if (o && o.excel && o.reps === s.reps && o.peso === s.peso && o.tiempo === s.tiempo) {
          s.excel = { tendReps: o.tr || '', tendPeso: o.tc || '', igual: o.igual };
        }
      });
    }
    // Mover a otra fecha = borrar el registro de la fecha vieja y guardarlo en la nueva (en un solo paso)
    const destino = F.existing && esFecha(F.nuevaFecha) && F.nuevaFecha !== F.fecha ? F.nuevaFecha : F.fecha;
    const ops = [];
    if (destino !== F.fecha) {
      if (destino > today()) return toast('No se puede mover a una fecha futura', 'error');
      const choque = entryOn(ex.id, F.variante, F.modo, destino);
      if (choque && !confirm(`Ya hay un registro de este ejercicio (${F.variante.toLowerCase()}, ${modoTxt(F.modo)}) el ${fmtDia(destino)}: ${choque.series.map((s) => setTxt(ex, s)).join(' · ')}.\n\n¿Reemplazarlo por este?`)) return;
      ops.push({ type: 'deleteEntry', opId: uid(), entrada: F.entrada });
    }
    ops.push({
      type: 'entry', opId: uid(), entrada: `${destino}|${ex.id}|${F.variante}|${F.modo}`, fecha: destino, dia: ex.dia, exId: ex.id, ejercicio: label(ex),
      ejecutado: ejecutado(ex, F.variante, F.modo), variante: F.variante, modo: F.modo, series, nota: (F.nota || '').trim(), ts: Date.now()
    });
    if (!enqueue(...ops)) return;
    delete S.drafts[F.entrada]; store(K.drafts, S.drafts);
    tocarFechaSesion(F.fecha);
    const movido = destino !== F.fecha;
    const volver = F.volver;
    F = null;
    toast(movido ? `Movido al ${fmtDia(destino)} ✓` : navigator.onLine ? 'Guardado ✓' : 'Guardado en el celular ✓ Se envía cuando haya señal');
    location.hash = volver || `#/dia/${enc(ex.dia)}`;
    sync();
  },
  delEntry() {
    if (!confirm(`¿Eliminar el registro de este ejercicio del ${fmtDia(F.fecha)}?`)) return;
    const entrada = F.entrada;
    if (!enqueue({ type: 'deleteEntry', opId: uid(), entrada })) return;
    delete S.drafts[entrada]; store(K.drafts, S.drafts);
    const dia = view().byId.get(F.exId).dia;
    const volver = F.volver;
    F = null;
    toast('Registro eliminado');
    location.hash = volver || `#/dia/${enc(dia)}`;
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
    const volver = E._volver;
    E = null;
    toast('Ejercicio guardado ✓');
    location.hash = volver || '#/ejercicios';
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
      await api({ action: 'ping' });
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
    toast('Buscando actualización…');
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        // Si hay una versión nueva, se espera a que quede activa antes de recargar (máx. 10 s)
        if (reg.installing || reg.waiting) {
          await new Promise((res) => {
            navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
            setTimeout(res, 10000);
          });
        }
      }
    } catch (e) { /* sin señal */ }
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
  } else if (t.id === 'sup-nombre' && F) {
    F.supNombre = t.value;
  } else if (t.id === 'sup-ajuste' && F) {
    F.supAjuste = t.value;
  } else if (t.dataset.e && E && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
    E[t.dataset.e] = t.value;
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'fechaSesion') {
    if (t.value && !esFecha(t.value)) return;
    if (t.value > today()) { toast('No se puede elegir una fecha futura', 'error'); t.value = fechaSesion(); return; }
    setFechaSesion(t.value || null);
    render();
  } else if (t.id === 'fecha' && F && F.existing) {
    // Solo se marca: el registro se mueve recién al tocar "Guardar y mover"
    if (t.value > today()) { toast('No se puede mover a una fecha futura', 'error'); t.value = F.nuevaFecha || F.fecha; return; }
    F.nuevaFecha = esFecha(t.value) && t.value !== F.fecha ? t.value : null;
    const help = document.getElementById('fecha-help');
    if (help) help.innerHTML = fechaHelp(F.fecha);
    const btn = document.querySelector('[data-act="saveEj"]');
    if (btn) btn.textContent = F.nuevaFecha ? 'Guardar y mover' : 'Guardar cambios';
  } else if (t.id === 'cfg-desc') {
    S.descargaPct = Number(t.value) || 60;
    store(K.descarga, S.descargaPct);
    toast(`Descarga al ${S.descargaPct}% ✓`);
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
