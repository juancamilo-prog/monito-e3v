/* UI del dashboard: carga /data/news.json y /data/alerts.json (generados por Actions),
   aplica filtros, ordena, pagina y actualiza métricas. Persistencia de "revisadas" en localStorage. */

const state = {
  rawNews: [],
  news: [],
  alerts: [],
  page: 1,
  perPage: 10,
  filters: { q: "", region: "all", from: null, to: null, sort: "date_desc" },
  reviewed: new Set(JSON.parse(localStorage.getItem("reviewed") || "[]")),
  meta: { generated_at: null, uptime_started: null, avg_relevance: null }
};

const els = {
  list: document.getElementById("news-list"),
  alerts: document.getElementById("alerts-list"),
  q: document.getElementById("q"),
  region: document.getElementById("region"),
  from: document.getElementById("from"),
  to: document.getElementById("to"),
  sort: document.getElementById("sort"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  pageInfo: document.getElementById("page-info"),
  mNewsToday: document.getElementById("m-news-today"),
  mUptime: document.getElementById("m-uptime"),
  mRelevance: document.getElementById("m-relevance"),
  refresh: document.getElementById("btn-refresh")
};

async function loadData() {
  const [newsRes, alertsRes] = await Promise.all([
    fetch("../data/news.json?" + Date.now()),
    fetch("../data/alerts.json?" + Date.now())
  ]);
  const news = await newsRes.json();
  const alerts = await alertsRes.json();
  state.rawNews = news.items || [];
  state.meta.generated_at = news.generated_at || null;
  state.meta.uptime_started = news.uptime_started || null;
  state.meta.avg_relevance = news.avg_relevance || null;
  state.alerts = alerts.items || [];
  applyFilters();
  renderAlerts();
  renderMetrics();
}

function applyFilters() {
  const { q, region, from, to, sort } = state.filters;
  const qn = q.trim().toLowerCase();
  const fromTs = from ? new Date(from).getTime() : null;
  const toTs = to ? new Date(to).getTime() + 24*3600*1000 - 1 : null;

  let data = state.rawNews.filter(n => {
    const hayQ = !qn || (n.title?.toLowerCase().includes(qn) || n.summary?.toLowerCase().includes(qn) || n.source?.toLowerCase().includes(qn));
    const hayRegion = region === "all" || n.region === region;
    const ts = n.datePublished ? new Date(n.datePublished).getTime() : null;
    const hayFrom = !fromTs || (ts && ts >= fromTs);
    const hayTo = !toTs || (ts && ts <= toTs);
    return hayQ && hayRegion && hayFrom && hayTo;
  });

  data.sort((a,b) => {
    if (sort === "date_asc") return new Date(a.datePublished) - new Date(b.datePublished);
    if (sort === "score_desc") return (b.score||0) - (a.score||0);
    return new Date(b.datePublished) - new Date(a.datePublished);
  });

  state.news = data;
  state.page = 1;
  renderFeed();
}

function paginate(arr) {
  const start = (state.page - 1) * state.perPage;
  return arr.slice(start, start + state.perPage);
}

function renderFeed() {
  const slice = paginate(state.news);
  els.list.innerHTML = slice.map(cardHTML).join("");
  const totalPages = Math.max(1, Math.ceil(state.news.length / state.perPage));
  els.pageInfo.textContent = `${state.page} / ${totalPages}`;
}

function cardHTML(n) {
  const d = n.datePublished ? new Date(n.datePublished) : null;
  const dStr = d ? d.toLocaleString() : "";
  const reviewed = state.reviewed.has(n.id);
  return `
    <li class="card">
      <h3><a class="title" href="${n.url}" target="_blank" rel="noopener">${escapeHTML(n.title)}</a></h3>
      <div class="meta">
        <span class="badge source">${escapeHTML(n.source||"?")}</span>
        <span class="badge region">${escapeHTML(n.region||"?")}</span>
        <span>${dStr}</span>
        <span class="badge score">score: ${n.score ?? 0}</span>
        ${n.topics?.length ? `<span class="badge">${n.topics.join(', ')}</span>` : ''}
      </div>
      ${n.summary ? `<p>${escapeHTML(n.summary)}</p>` : ''}
      <div class="meta">
        <button data-id="${n.id}" class="btn-review">${reviewed ? '✓ Revisada' : 'Marcar como revisada'}</button>
      </div>
    </li>`;
}

function renderAlerts() {
  els.alerts.innerHTML = state.alerts.map(a => `
    <li class="alert ${sevCls(a.severity)}">
      <div><strong>${escapeHTML(a.title)}</strong></div>
      <div class="meta"><span class="sev">${escapeHTML(a.severity||'–')}</span> · <span>${escapeHTML(a.source||'')}</span> · <span>${a.date ? new Date(a.date).toLocaleDateString() : ''}</span></div>
      ${a.description ? `<p>${escapeHTML(a.description)}</p>` : ''}
      ${a.link ? `<a href="${a.link}" target="_blank" rel="noopener">Ver documento oficial →</a>` : ''}
    </li>`).join("");
}

function renderMetrics() {
  // Noticias hoy
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today.getTime() + 24*3600*1000);
  const cToday = state.rawNews.filter(n => {
    const t = n.datePublished ? new Date(n.datePublished) : null;
    return t && t >= today && t < tomorrow;
  }).length;
  els.mNewsToday.textContent = cToday;

  // Uptime
  const start = state.meta.uptime_started ? new Date(state.meta.uptime_started) : null;
  els.mUptime.textContent = start ? humanizeDuration(Date.now() - start.getTime()) : '–';

  // Relevancia promedio (si viene calculada, si no: promedio simple)
  const avg = state.meta.avg_relevance ?? avgOf(state.rawNews.map(n => n.score||0));
  els.mRelevance.textContent = isNaN(avg) ? '–' : `${avg.toFixed(0)}%`;
}

function humanizeDuration(ms){
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor(ms % 3600000 / 60000);
  return `${h}h ${m}m`;
}
function avgOf(arr){ if(!arr.length) return NaN; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function sevCls(s){ s=(s||'').toLowerCase(); if(s.startsWith('alta')) return 'high'; if(s.startsWith('media')) return 'medium'; return 'low'; }
function escapeHTML(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

// Eventos UI
els.q.addEventListener('input', e => { state.filters.q = e.target.value; applyFilters(); });
els.region.addEventListener('change', e => { state.filters.region = e.target.value; applyFilters(); });
els.from.addEventListener('change', e => { state.filters.from = e.target.value || null; applyFilters(); });
els.to.addEventListener('change', e => { state.filters.to = e.target.value || null; applyFilters(); });
els.sort.addEventListener('change', e => { state.filters.sort = e.target.value; applyFilters(); });
els.prev.addEventListener('click', () => { if(state.page>1){ state.page--; renderFeed(); } });
els.next.addEventListener('click', () => { const total = Math.max(1, Math.ceil(state.news.length/state.perPage)); if(state.page<total){ state.page++; renderFeed(); } });
els.refresh.addEventListener('click', () => loadData());

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-review');
  if(btn){
    const id = btn.getAttribute('data-id');
    if(state.reviewed.has(id)) state.reviewed.delete(id); else state.reviewed.add(id);
    localStorage.setItem('reviewed', JSON.stringify([...state.reviewed]));
    renderFeed();
  }
});

// Carga inicial
loadData().catch(console.error);
