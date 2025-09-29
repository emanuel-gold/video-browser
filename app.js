/* --- Utilities --- */
const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|m4v)$/i;
const fmtBytes = b => {
  if (!Number.isFinite(b)) return "?";
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length-1) { n/=1024; i++; }
  return `${n.toFixed(n<10&&i?1:0)} ${u[i]}`;
};
const fmtTime = s => {
  if (!Number.isFinite(s)) return "—";
  s = Math.max(0, s|0);
  const h = (s/3600)|0, m = ((s%3600)/60)|0, sec = s%60|0;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
};
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* --- Persistence (tags + small metadata) --- */
const DB_KEY = 'localVideoLibrary.v1';
function loadDB() { try { return JSON.parse(localStorage.getItem(DB_KEY)) || { items:{} }; } catch { return { items:{} }; } }
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
const db = loadDB();

/* --- State --- */
let items = []; // {id, name, path, size, mtime, type, file?, url, duration?, thumb? dataURL, tags:[]}
let useFSAPI = 'showDirectoryPicker' in window;
const objectURLs = new Set();

function trackObjectURL(url) {
  objectURLs.add(url);
  return url;
}

function revokeTrackedURL(url) {
  if (!url) return;
  URL.revokeObjectURL(url);
  objectURLs.delete(url);
}

function cleanupItem(item) {
  if (item && item.url) {
    revokeTrackedURL(item.url);
    delete item.url;
  }
}

function revokeAllObjectURLs() {
  items.forEach(cleanupItem);
  for (const url of objectURLs) URL.revokeObjectURL(url);
  objectURLs.clear();
  console.assert(objectURLs.size === 0, 'Leaked object URLs remain');
}

window.addEventListener('unload', revokeAllObjectURLs);

/* --- DOM --- */
const pickDirBtn = document.getElementById('pickDirBtn');
const fileInput = document.getElementById('fileInput');
const grid = document.getElementById('grid');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');
const sortEl = document.getElementById('sort');
const compatHint = document.getElementById('compatHint');
const loadingEl = document.getElementById('loading');

function showLoading(text) {
  loadingEl.textContent = text;
  loadingEl.classList.remove('hidden');
}
function updateLoading(text) {
  loadingEl.textContent = text;
}
function hideLoading() {
  loadingEl.classList.add('hidden');
}

compatHint.textContent = useFSAPI
  ? 'Tip: Chromium/Edge with File System Access API gives faster scans and persistent permissions.'
  : 'Your browser lacks the File System Access API. Falling back to directory input (still fully local).';

/* --- Scanning (two modes) --- */
async function scanWithFSAccess() {
  const dirHandle = await window.showDirectoryPicker({ id: 'videos-root', mode: 'read' });
  revokeAllObjectURLs();
  showLoading('Scanning...');
  items = [];
  await walkDir(dirHandle, '');
  updateLoading(`Processing 0/${items.length}`);
  await enrichAll();
  render();
  hideLoading();
}
async function walkDir(dirHandle, basePath) {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = basePath ? basePath + '/' + name : name;
    if (handle.kind === 'directory') {
      await walkDir(handle, path);
    } else if (VIDEO_EXT.test(name)) {
      const file = await handle.getFile();
      const url = trackObjectURL(URL.createObjectURL(file));
      items.push({
        id: crypto.randomUUID(),
        name, path, size: file.size, mtime: file.lastModified, type: file.type || 'video/*',
        file, url, tags: (db.items[path]?.tags)||[]
      });
    }
  }
}

async function scanWithDirectoryInput() {
  // Trigger the hidden input
  fileInput.click();
  await new Promise(resolve => {
    fileInput.onchange = resolve;
  });
  revokeAllObjectURLs();
  showLoading('Scanning...');
  items = [];
  for (const file of fileInput.files) {
    if (!VIDEO_EXT.test(file.name)) continue;
    const path = file.webkitRelativePath || file.name;
    const url = trackObjectURL(URL.createObjectURL(file));
    items.push({
      id: crypto.randomUUID(),
      name: file.name,
      path,
      size: file.size,
      mtime: file.lastModified,
      type: file.type || 'video/*',
      file, url, tags: (db.items[path]?.tags)||[]
    });
  }
  updateLoading(`Processing 0/${items.length}`);
  await enrichAll();
  render();
  hideLoading();
}

/* --- Metadata/thumbnail extraction --- */
async function enrichAll() {
  // Do a throttled loop to avoid hammering the decoder; 1st frame around 1s mark
  const total = items.length;
  let done = 0;
  const concurrency = 3;
  let idx = 0;
  const work = new Array(concurrency).fill(0).map(async () => {
    while (idx < items.length) {
      const me = items[idx++];
      await enrichOne(me);
      done++;
      updateLoading(`Processing ${done}/${total}`);
    }
  });
  await Promise.all(work);
  console.assert(objectURLs.size === 0, 'Leaked object URLs remain after enrichAll');
}

async function enrichOne(item) {
  return new Promise(async (resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = item.url;
    v.muted = true;
    let done = false;

      const finalize = () => {
        if (!done){
          done=true;
          cleanupItem(item);
          v.remove();
          resolve();
        }
      };

    v.addEventListener('loadedmetadata', async () => {
      item.duration = v.duration || item.duration;
      try {
        // seek to 1s or 10% if shorter
        const t = Math.min( Math.max(0.1, (v.duration||1) * 0.1), 1.0 );
        v.currentTime = t;
      } catch { /* ignore */ }
    }, { once:true });

    v.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        const w = v.videoWidth || 320, h = v.videoHeight || 180;
        // keep it modest to save memory
        const maxW = 640;
        const scale = Math.min(1, maxW / w);
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        item.thumb = canvas.toDataURL('image/jpeg', 0.7);
      } catch {}
      finalize();
    }, { once:true });

    v.addEventListener('error', finalize, { once:true });
    // hard timeout so one bad file doesn't stall
    await sleep(4000); finalize();
  });
}

/* --- Rendering --- */
function render() {
  const query = searchEl.value.trim();
  const tokens = query ? query.split(/\s+/) : [];
  const filters = tokens.map(tok => parseToken(tok));
  let out = items.filter(it => filters.every(f => f(it)));

  const sort = sortEl.value;
  const dir = sort.endsWith('desc') ? -1 : 1;
  const key = sort.split('-')[0];
  out.sort((a,b) => {
    const K = {
      name: a.name.localeCompare(b.name),
      date: (a.mtime||0) - (b.mtime||0),
      size: (a.size||0) - (b.size||0),
      dur:  (a.duration||0) - (b.duration||0)
    }[key];
    return K * dir;
  });

  grid.innerHTML = '';
  countEl.textContent = out.length;

  const frag = document.createDocumentFragment();
  for (const it of out) {
    const card = document.createElement('div');
    card.className = 'card';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = it.thumb || '';
    if (!it.thumb) img.alt = 'No thumbnail';
    thumb.appendChild(img);

    const dur = document.createElement('div');
    dur.className = 'badge';
    dur.textContent = fmtTime(it.duration);
    thumb.appendChild(dur);

    // Click thumb to open in a lightweight player
    thumb.addEventListener('click', () => openPlayer(it));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.name;
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = it.path;
    const dim = document.createElement('div');
    dim.className = 'dim';
    dim.textContent = `${fmtBytes(it.size)} • ${new Date(it.mtime||0).toLocaleString()}${Number.isFinite(it.duration) ? ' • '+fmtTime(it.duration):''}`;
    const tags = document.createElement('div');
    tags.className = 'tags';
    (it.tags||[]).forEach(t => tags.appendChild(tagChip(t, it)));

    const tagWrap = document.createElement('div');
    tagWrap.className = 'tag-input';
    const tagIn = document.createElement('input');
    tagIn.placeholder = 'Add tag then Enter';
    tagIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const val = tagIn.value.trim();
        if (!val) return;
        addTag(it, val);
        tags.appendChild(tagChip(val, it));
        tagIn.value = '';
        persist(it);
        render(); // update filters if using #tag search
      }
    });
    tagWrap.appendChild(tagIn);

    meta.append(name, path, dim, tags, tagWrap);
    card.append(thumb, meta);
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function tagChip(t, item) {
  const el = document.createElement('span');
  el.className = 'tag';
  el.textContent = t;
  el.title = 'Click to remove';
  el.addEventListener('click', () => {
    item.tags = (item.tags||[]).filter(x => x!==t);
    persist(item);
    render();
  });
  return el;
}

function addTag(item, t) {
  item.tags = Array.from(new Set([...(item.tags||[]), t]));
}

function persist(item) {
  db.items[item.path] = { tags: item.tags };
  saveDB(db);
}

/* --- Filter parser --- */
// Supported quick filters in the search box:
// - plain text: matches name/path
// - #tagName: matches a tag
// - dur:>60  (seconds) or dur:<300 or dur:=120
// - size:<500MB  (supports KB/MB/GB)
// You can combine tokens with spaces (AND).
function parseToken(tok) {
  if (tok.startsWith('#')) {
    const want = tok.slice(1).toLowerCase();
    return it => (it.tags||[]).some(t => t.toLowerCase().includes(want));
  }
  const m1 = tok.match(/^dur:(<=|>=|=|<|>)(\d+)$/i);
  if (m1) {
    const [,op,n] = m1; const val = Number(n);
    return it => cmp(it.duration||0, op, val);
  }
  const m2 = tok.match(/^size:(<=|>=|=|<|>)(\d+(?:\.\d+)?)(kb|mb|gb|tb)?$/i);
  if (m2) {
    const [,op,num,unitRaw] = m2;
    const unit = (unitRaw||'b').toLowerCase();
    const mul = unit==='kb'?1024 : unit==='mb'?1024**2 : unit==='gb'?1024**3 : unit==='tb'?1024**4 : 1;
    const val = Number(num) * mul;
    return it => cmp(it.size||0, op, val);
  }
  // default substring match
  const s = tok.toLowerCase();
  return it => it.name.toLowerCase().includes(s) || it.path.toLowerCase().includes(s);
}
function cmp(a,op,b){ return op==='<'?a<b: op==='>'?a>b: op==='='?a===b: op==='>='?a>=b: a<=b; }

/* --- Simple inline player dialog --- */
  function openPlayer(item){
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {position:'fixed', inset:'0', background:'#000b', display:'grid', placeItems:'center', zIndex:9999, padding:'2vw'});
    const box = document.createElement('div');
    Object.assign(box.style, {background:'#000', borderRadius:'12px', border:'1px solid #2a3244', width:'min(90vw,1200px)'});
    const head = document.createElement('div');
    Object.assign(head.style, {display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 12px', color:'#cdd3df', borderBottom:'1px solid #2a3244', fontWeight:'600'});
    head.textContent = item.name;
    const close = document.createElement('button');
    close.textContent = '×';
    Object.assign(close.style, {marginLeft:'auto', background:'#111', color:'#fff', border:'1px solid #333', borderRadius:'8px', padding:'4px 10px', cursor:'pointer'});
    const v = document.createElement('video');
    const url = trackObjectURL(URL.createObjectURL(item.file));
    v.src = url;
    v.controls = true;
    v.style.width = '100%';
    v.style.maxHeight = '75vh';
    v.autoplay = true;
    const cleanup = () => { revokeTrackedURL(url); wrap.remove(); };
    close.onclick = cleanup;
    head.appendChild(close);
    box.append(head, v);
    wrap.appendChild(box);
    wrap.addEventListener('click', (e)=>{ if(e.target===wrap) cleanup(); });
    document.body.appendChild(wrap);
  }

/* --- Events --- */
pickDirBtn.addEventListener('click', () => {
  if (useFSAPI) scanWithFSAccess().catch(err => {
    console.error(err);
    alert('Directory access failed. Falling back to standard picker.');
    useFSAPI = false;
    scanWithDirectoryInput();
  });
  else scanWithDirectoryInput();
});
searchEl.addEventListener('input', () => render());
sortEl.addEventListener('change', () => render());

