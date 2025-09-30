/*
  Ingesta diaria (hasta 4×/día) mediante Google News RSS queries.
  - No requiere claves. Puedes añadir APIs (NewsAPI, GDELT, Perplexity) si las tienes.
  - Dedupe por hash(url). Calcula score por coincidencias de keywords.
  - Salida: /data/news.json (y opcionalmente archivos en /archive/). 
*/
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'keywords.json'), 'utf8'));

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function buildGoogleNewsUrl(q, langCfg) {
  const { hl, gl, ceid } = langCfg;
  // when:1d no siempre funciona en RSS; usamos lookbackDays y filtramos por fecha
  const u = new URL('https://news.google.com/rss/search');
  u.searchParams.set('q', q);
  u.searchParams.set('hl', hl);
  u.searchParams.set('gl', gl);
  u.searchParams.set('ceid', ceid);
  return u.toString();
}

async function fetchXML(url){
  const res = await fetch(url, { headers: { 'User-Agent': 'E3VMonitor/1.0' }});
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function hashId(s){ return crypto.createHash('sha256').update(s).digest('hex').slice(0,16); }
function normText(s){ return (s||'').replace(/\s+/g,' ').trim(); }
function parsePubDate(s){ const d = new Date(s); return isNaN(d) ? null : d.toISOString(); }

function scoreItem(item, allKeywords){
  const blob = `${item.title} ${item.summary}`.toLowerCase();
  let hits = 0; for(const kw of allKeywords){ if(blob.includes(kw)) hits++; }
  // escala a 0..100 (rudimentario pero útil)
  const cap = Math.min(10, hits);
  return Math.round((cap/10)*100);
}

function inferSource(link){ try { return new URL(link).hostname.replace('www.',''); } catch { return ''; } }

function mapRSSItem(it, region, allKw){
  const title = normText(it.title);
  // Google News RSS pone el enlace real en <link> o en <guid>; si es redirect de google, extraemos url=
  let url = (it.link || '').toString();
  try { const u = new URL(url); if(u.hostname.endsWith('news.google.com')) { const m = /url=([^&]+)/.exec(url); if(m) url = decodeURIComponent(m[1]); } } catch {}
  const summary = normText(it.description || it['content:encoded'] || '');
  const datePublished = parsePubDate(it.pubDate);
  const source = inferSource(url);
  const topics = [];
  const score = scoreItem({title, summary}, allKw);
  return { id: hashId(url), title, summary, url, source, datePublished, region, topics, score };
}

function withinLookback(iso, days){ if(!iso) return false; const t = new Date(iso).getTime(); return (Date.now() - t) <= days*86400000; }

async function run() {
  const prev = safeReadJSON(path.join(DATA, 'news.json')) || { items: [], uptime_started: new Date().toISOString() };
  const lookbackDays = CONFIG.lookbackDays || 7;

  const results = [];
  for(const region of Object.keys(CONFIG.queries)){
    const qs = CONFIG.queries[region];
    const langCfg = CONFIG.langs[region];
    const flatKws = qs.flatMap(q => q.toLowerCase().split(/\s+or\s+|\s+|,/i).filter(Boolean));
    for(const q of qs){
      const url = buildGoogleNewsUrl(q, langCfg);
      try {
        const xml = await fetchXML(url);
        const json = parser.parse(xml);
        const items = json?.rss?.channel?.item || [];
        for(const it of items){
          const mapped = mapRSSItem(it, region, flatKws);
          if(withinLookback(mapped.datePublished, lookbackDays)) results.push(mapped);
        }
      } catch(e){
        console.error('Feed error', region, q, e.message);
      }
    }
  }

  // Dedupe por URL hash, conservando el más reciente
  const byId = new Map();
  for(const x of [...prev.items, ...results]){
    const cur = byId.get(x.id);
    if(!cur || new Date(x.datePublished||0) > new Date(cur.datePublished||0)) byId.set(x.id, x);
  }

  // Limitar tamaño: últimos 30 días
  const items = [...byId.values()].filter(n => withinLookback(n.datePublished, 30))
    .sort((a,b) => new Date(b.datePublished) - new Date(a.datePublished));

  const avg_relevance = Math.round(items.reduce((s,n)=>s+(n.score||0),0) / (items.length||1));
  const payload = {
    generated_at: new Date().toISOString(),
    uptime_started: prev.uptime_started || new Date().toISOString(),
    avg_relevance,
    items
  };
  fs.writeFileSync(path.join(DATA, 'news.json'), JSON.stringify(payload, null, 2));

  // Alerts (placeholder: aquí podrías leer feeds regulatorios/boletines con el mismo patrón y escribir alerts.json)
  const alertsPrev = safeReadJSON(path.join(DATA, 'alerts.json')) || { items: [] };
  fs.writeFileSync(path.join(DATA, 'alerts.json'), JSON.stringify({ generated_at: new Date().toISOString(), items: alertsPrev.items }, null, 2));
}

function safeReadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch{ return null; } }

// Node 18+ trae fetch global
if (typeof fetch === 'undefined') {
  global.fetch = (await import('node-fetch')).default;
}

run().catch(err => { console.error(err); process.exit(1); });

