'use strict';

// ---------------------------------------------------------------------------
// helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const LARGE_DIFF = 1500;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Review-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

const LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', m: 'objectivec',
  sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', toml: 'ini',
  ini: 'ini', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', lua: 'lua', dart: 'dart', scala: 'scala', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  pl: 'perl', r: 'r', gradle: 'groovy', groovy: 'groovy', tf: 'ini', proto: 'protobuf', graphql: 'graphql',
};

function langFor(path) {
  const base = (path || '').split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANGS[base.split('.').pop()] || '';
}

function highlight(text, lang) {
  if (lang && window.hljs && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return esc(text);
}

// Tiny markdown renderer for comment bodies: fences, inline code, bold, italics, links.
function md(src) {
  const parts = [];
  const re = /```([\w-]*)\n([\s\S]*?)(?:\n)?```/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    parts.push(inline(src.slice(last, m.index)));
    if (m[1] === 'suggestion') {
      parts.push(`<div class="suggestion"><div class="sh">Suggested change</div><pre><code>${esc(m[2])}</code></pre></div>`);
    } else {
      parts.push(`<pre><code>${esc(m[2])}</code></pre>`);
    }
    last = re.lastIndex;
  }
  parts.push(inline(src.slice(last)));
  return parts.join('');

  function inline(t) {
    t = t.trim();
    if (!t) return '';
    return t
      .split(/\n{2,}/)
      .map((p) => {
        let h = esc(p);
        h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        h = h.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>');
        h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return `<p>${h.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }
}

// ---------------------------------------------------------------------------
// state

const S = {
  meta: null,
  scope: 'working',
  context: store('ai-review.context') || '3',
  view: store('ai-review.view') || 'split',
  files: [],
  comments: [],
  general: '',
  verdict: 'comment',
  viewed: new Set(),
  collapsed: new Set(),
  forceShow: new Set(),
  filter: '',
  editor: null, // { file, side, start, end, body, editingId }
  drag: null, // { fileIdx, side, start, end }
  finished: false,
};

let saveTimer = null;
function saveDraft() {
  if (S.finished) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('PUT', '/api/draft', {
      comments: S.comments,
      general: S.general,
      verdict: S.verdict,
      viewed: [...S.viewed],
    }).catch((e) => console.warn('draft save failed', e));
  }, 300);
}

const viewedKey = (path) => `${S.scope}|${path}`;
const scopeComments = () => S.comments.filter((c) => c.scope === S.scope);
const fileComments = (path) => scopeComments().filter((c) => c.file === path);

function anchorOf(line) {
  return line.type === 'del' ? `old:${line.oldNo}` : `new:${line.newNo}`;
}

function rangeLabel(c) {
  if (c.start == null) return 'File';
  const r = c.end != null && c.end !== c.start ? `L${c.start}–L${c.end}` : `L${c.start}`;
  return c.side === 'old' ? `${r} (old)` : r;
}

function snippetFor(file, side, start, end) {
  const out = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const no = side === 'old' ? (l.type === 'add' ? null : l.oldNo) : l.type === 'del' ? null : l.newNo;
      if (no != null && no >= start && no <= end) out.push(l.text);
    }
  }
  return out.slice(0, 80);
}

// ---------------------------------------------------------------------------
// loading

async function init() {
  S.meta = await api('GET', '/api/meta');
  const d = S.meta.draft || {};
  S.comments = d.comments || [];
  S.general = d.general || '';
  S.verdict = d.verdict || 'comment';
  S.viewed = new Set(d.viewed || []);
  S.scope = S.meta.initialScope || 'working';

  $('#repo').textContent = S.meta.repo;
  $('#branch').textContent = S.meta.branch;
  document.title = `Review · ${S.meta.repo}`;
  $('#general').value = S.general;
  $$('input[name=verdict]').forEach((r) => (r.checked = r.value === S.verdict));
  $('#context').value = S.context;

  const banner = $('#banner');
  if (S.meta.hook) {
    banner.classList.add('hook');
    banner.textContent = 'Claude is paused waiting for this review. Approve to let it finish; Comment or Request changes sends your feedback back to it.';
  } else {
    banner.textContent = 'Your review is sent back to Claude when you submit it.';
  }

  renderScopeSelect();
  renderPrevious();
  await loadDiff();
}

function renderScopeSelect() {
  const sel = $('#scope');
  const opts = S.meta.scopes.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`);
  if (S.meta.commits.length) {
    opts.push('<optgroup label="Recent commits">');
    S.meta.commits.forEach((c, i) => {
      const n = i + 1;
      const subj = c.subject.length > 50 ? c.subject.slice(0, 49) + '…' : c.subject;
      opts.push(`<option value="commits:${n}">Last ${n} commit${n > 1 ? 's' : ''} · ${esc(c.sha)} ${esc(subj)}</option>`);
    });
    opts.push('</optgroup>');
  }
  sel.innerHTML = opts.join('');
  if (![...sel.options].some((o) => o.value === S.scope)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(S.scope)}">${esc(S.scope)}</option>`);
  }
  sel.value = S.scope;
}

async function loadDiff() {
  $('#files').innerHTML = '<p class="empty">Loading diff…</p>';
  S.editor = null;
  try {
    const res = await api('GET', `/api/diff?scope=${encodeURIComponent(S.scope)}&context=${encodeURIComponent(S.context)}`);
    S.files = res.files;
  } catch (e) {
    S.files = [];
    $('#files').innerHTML = `<p class="empty">Failed to load diff: ${esc(e.message)}</p>`;
    renderTree();
    renderStats();
    return;
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// rendering

function visibleFiles() {
  const q = S.filter.toLowerCase();
  return S.files.map((f, i) => ({ f, i })).filter(({ f }) => !q || f.path.toLowerCase().includes(q));
}

function renderAll() {
  renderStats();
  renderTree();
  renderViewToggle();
  const files = visibleFiles();
  if (!S.files.length) {
    $('#files').innerHTML = '<p class="empty">No changes in this scope.</p>';
    return;
  }
  $('#files').innerHTML = files.map(({ i }) => `<div class="file" id="file-${i}"></div>`).join('') || '<p class="empty">No files match the filter.</p>';
  files.forEach(({ i }) => renderFile(i));
}

function renderStats() {
  const a = S.files.reduce((s, f) => s + f.additions, 0);
  const d = S.files.reduce((s, f) => s + f.deletions, 0);
  $('#stats').innerHTML = `${S.files.length} file${S.files.length === 1 ? '' : 's'} changed <span class="a">+${a}</span> <span class="d">−${d}</span>`;
  $('#count').textContent = S.comments.length;
}

function renderViewToggle() {
  $$('#view button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
}

function renderTree() {
  const root = { dirs: {}, files: [] };
  for (const { f, i } of visibleFiles()) {
    const parts = f.path.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) node = node.dirs[p] ||= { dirs: {}, files: [] };
    node.files.push({ f, i, name: parts[parts.length - 1] });
  }
  const STATUS = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C' };
  const renderNode = (node) => {
    let html = '<ul>';
    for (let [name, child] of Object.entries(node.dirs).sort()) {
      // Collapse chains of single-child directories: src/main/java → one row.
      while (Object.keys(child.dirs).length === 1 && !child.files.length) {
        const [n2, c2] = Object.entries(child.dirs)[0];
        name += '/' + n2;
        child = c2;
      }
      html += `<li><div class="tree-dir">▾ ${esc(name)}</div>${renderNode(child)}</li>`;
    }
    for (const { f, i, name } of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const n = fileComments(f.path).length;
      const viewed = S.viewed.has(viewedKey(f.path));
      html += `<li><div class="tree-file${viewed ? ' viewed' : ''}" data-goto="${i}" title="${esc(f.path)}">
        <span class="st st-${f.status}">${STATUS[f.status] || '?'}</span>
        <span class="name">${esc(name)}</span>
        ${n ? `<span class="cc">💬${n}</span>` : ''}${viewed ? '<span class="cc">✓</span>' : ''}
      </div></li>`;
    }
    return html + '</ul>';
  };
  $('#tree').innerHTML = renderNode(root);
}

function renderPrevious() {
  const p = S.meta.previous;
  if (!p) return;
  const when = new Date(p.submittedAt).toLocaleString();
  const items = (p.comments || [])
    .map((c) => `<li><code class="loc">${esc(c.file)}:${esc(rangeLabel(c))}</code><div class="md">${md(c.body || '')}</div></li>`)
    .join('');
  const general = p.general ? `<li><code class="loc">General</code><div class="md">${md(p.general)}</div></li>` : '';
  $('#previous').innerHTML = `<details class="previous">
    <summary>Previous review round · ${esc(p.verdict.replace('_', ' '))} · ${esc(when)} · ${(p.comments || []).length} comment(s)</summary>
    <ul>${general}${items || '<li>No comments.</li>'}</ul>
  </details>`;
}

function fileHeader(f, i) {
  const viewed = S.viewed.has(viewedKey(f.path));
  const collapsed = S.collapsed.has(f.path) || viewed;
  const path =
    f.status === 'renamed' || f.status === 'copied'
      ? `<span class="old">${esc(f.oldPath)}</span> → ${esc(f.newPath)}`
      : esc(f.path);
  return `<div class="file-head">
    <button class="chev" data-act="toggle" title="Collapse">${collapsed ? '▸' : '▾'}</button>
    <span class="st st-${f.status}">${{ added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C' }[f.status] || '?'}</span>
    <span class="path">${path}</span>
    <span class="fstats"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span>
    <span class="spacer"></span>
    <button class="btn sm" data-act="file-comment">💬 Comment on file</button>
    <label class="viewed"><input type="checkbox" data-act="viewed" ${viewed ? 'checked' : ''}> Viewed</label>
  </div>`;
}

function renderFile(i) {
  const el = document.getElementById(`file-${i}`);
  if (!el) return;
  const f = S.files[i];
  const viewed = S.viewed.has(viewedKey(f.path));
  const collapsed = S.collapsed.has(f.path) || viewed;
  el.classList.toggle('collapsed', collapsed);
  el.dataset.idx = i;

  const lineCount = f.hunks.reduce((s, h) => s + h.lines.length, 0);
  const comments = fileComments(f.path);
  const anchors = new Set();
  // Context lines can be anchored on either side (split view's left column uses the old number).
  f.hunks.forEach((h) => h.lines.forEach((l) => {
    anchors.add(anchorOf(l));
    if (l.type === 'ctx') anchors.add(`old:${l.oldNo}`);
  }));

  // Comments that can't be placed on a visible line go to the file-level area.
  const anchored = (c) => c.start != null && anchors.has(`${c.side}:${c.end ?? c.start}`);
  const fileLevel = comments.filter((c) => !anchored(c));
  const ed = S.editor && S.editor.file === f.path ? S.editor : null;

  let body = '';
  const fileLevelHtml =
    fileLevel.map((c) => commentHtml(c, c.start != null)).join('') + (ed && ed.start == null && !ed.editingId ? editorHtml(ed) : '');
  body += `<div class="file-comments">${fileLevelHtml}</div>`;

  if (f.binary) body += '<div class="file-msg">Binary file not shown.</div>';
  else if (!f.hunks.length) body += `<div class="file-msg">${f.status === 'renamed' ? 'File renamed without content changes.' : 'No content changes (mode change or empty file).'}</div>`;
  else if (lineCount > LARGE_DIFF && !S.forceShow.has(f.path))
    body += `<div class="file-msg">Large diff (${lineCount} lines) hidden. <button class="btn sm" data-act="show-large">Load diff</button></div>`;
  else body += S.view === 'split' ? splitTable(f, comments, ed) : unifiedTable(f, comments, ed);

  el.innerHTML = fileHeader(f, i) + `<div class="file-body">${body}</div>`;
  if (!selBtn.hidden && selTarget?.file === f.path) hideSelButton();

  if (ed) {
    const ta = $('.editor textarea', el);
    if (ta && document.activeElement?.tagName !== 'TEXTAREA') {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}

function selectedKeys(f) {
  const r = S.drag && S.drag.file === f.path ? S.drag : S.editor && S.editor.file === f.path && S.editor.start != null ? S.editor : null;
  const keys = new Set();
  if (!r) return keys;
  const [a, b] = [Math.min(r.start, r.end), Math.max(r.start, r.end)];
  for (let n = a; n <= b; n++) keys.add(`${r.side}:${n}`);
  return keys;
}

function threadsFor(comments, ed, key) {
  let html = comments.filter((c) => c.start != null && `${c.side}:${c.end ?? c.start}` === key).map((c) => commentHtml(c)).join('');
  if (ed && ed.start != null && `${ed.side}:${ed.end}` === key && !ed.editingId) html += editorHtml(ed);
  return html;
}

function codeCell(line, lang, cls, key, sel) {
  if (!line) return `<td class="num empty"></td><td class="code empty"></td>`;
  const no = key.startsWith('old:') ? line.oldNo : line.newNo;
  const mark = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const s = sel.has(key) ? ' sel' : '';
  return `<td class="num ${cls}${s}" data-a="${key}">${no}</td><td class="code ${cls}${s}" data-a="${key}"><button class="add-c" data-a="${key}" tabindex="-1" title="Comment (drag or shift-click for a range)">+</button><span class="mk">${mark}</span>${highlight(line.text, lang)}${line.noNewline ? '<span class="nonl" title="No newline at end of file">⊘</span>' : ''}</td>`;
}

function unifiedTable(f, comments, ed) {
  const lang = langFor(f.path);
  const sel = selectedKeys(f);
  let html = '<table class="diff unified"><colgroup><col class="num"><col class="num"><col></colgroup>';
  for (const h of f.hunks) {
    html += `<tr class="hunk"><td class="num"></td><td class="num"></td><td>${esc(h.header)}</td></tr>`;
    for (const l of h.lines) {
      const key = anchorOf(l);
      const s = sel.has(key) ? ' sel' : '';
      const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      html += `<tr class="line ${l.type}">
        <td class="num${s}" data-a="${key}">${l.oldNo ?? ''}</td><td class="num${s}" data-a="${key}">${l.newNo ?? ''}</td>
        <td class="code${s}" data-a="${key}"><button class="add-c" data-a="${key}" tabindex="-1" title="Comment (drag or shift-click for a range)">+</button><span class="mk">${mark}</span>${highlight(l.text, lang)}${l.noNewline ? '<span class="nonl" title="No newline at end of file">⊘</span>' : ''}</td></tr>`;
      const t = threadsFor(comments, ed, key) + (l.type === 'ctx' ? threadsFor(comments, ed, `old:${l.oldNo}`) : '');
      if (t) html += `<tr class="thread-row"><td colspan="3"><div class="threads">${t}</div></td></tr>`;
    }
  }
  return html + '</table>';
}

function splitRows(hunk) {
  const rows = [];
  const lines = hunk.lines;
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type === 'ctx') {
      rows.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] || null, adds[k] || null]);
  }
  return rows;
}

function splitTable(f, comments, ed) {
  const lang = langFor(f.path);
  const sel = selectedKeys(f);
  let html = '<table class="diff split"><colgroup><col class="num"><col><col class="num"><col></colgroup>';
  for (const h of f.hunks) {
    html += `<tr class="hunk"><td class="num"></td><td colspan="3">${esc(h.header)}</td></tr>`;
    for (const [l, r] of splitRows(h)) {
      // Context lines: left side anchors on the old number, right side on the new one.
      const lk = l ? `old:${l.oldNo}` : null;
      const rk = r ? `new:${r.newNo}` : null;
      html += '<tr class="line">';
      html += codeCell(l, lang, l && l.type === 'del' ? 'del' : '', lk || '', sel);
      html += codeCell(r, lang, r && r.type === 'add' ? 'add' : '', rk || '', sel);
      html += '</tr>';
      const lt = lk ? threadsFor(comments, ed, lk) : '';
      const rt = rk ? threadsFor(comments, ed, rk) : '';
      if (lt || rt) html += `<tr class="thread-row"><td colspan="2"><div class="threads">${lt}</div></td><td colspan="2"><div class="threads">${rt}</div></td></tr>`;
    }
  }
  return html + '</table>';
}

function commentHtml(c, stale = false) {
  if (S.editor && S.editor.editingId === c.id) return editorHtml(S.editor);
  return `<div class="comment" data-id="${esc(c.id)}">
    <div class="c-head"><span class="who">You</span><span>${esc(rangeLabel(c))}</span><span class="spacer"></span>
      <button class="link" data-act="edit">Edit</button><button class="link" data-act="delete">Delete</button></div>
    <div class="c-body md${stale ? ' stale' : ''}">${md(c.body)}</div>
  </div>`;
}

function editorHtml(ed) {
  const where = ed.start == null ? 'this file' : rangeLabel(ed);
  return `<div class="editor">
    <div class="ed-head">${ed.editingId ? 'Editing comment on' : 'Comment on'} ${esc(where)}</div>
    <textarea placeholder="Leave a comment (markdown). ⌘/Ctrl+Enter to save, Esc to cancel.">${esc(ed.body)}</textarea>
    <div class="ed-actions">
      ${ed.start != null ? '<button class="btn sm" data-act="suggest" title="Propose replacement code for these lines">± Suggestion</button>' : ''}
      <span class="hint">markdown supported</span>
      <span class="spacer"></span>
      <button class="btn" data-act="ed-cancel">Cancel</button>
      <button class="btn primary" data-act="ed-save">${ed.editingId ? 'Update comment' : 'Add comment'}</button>
    </div>
  </div>`;
}

function rerenderFileByPath(path) {
  const i = S.files.findIndex((f) => f.path === path);
  if (i >= 0) renderFile(i);
}

// ---------------------------------------------------------------------------
// comment actions

function openEditor(file, side, start, end) {
  const prev = S.editor;
  if (prev && prev.body.trim() && !prev.editingId && prev.file === file && prev.side === side) {
    // Keep typed text when the range is changed.
    S.editor = { ...prev, start, end };
  } else {
    S.editor = { file, side, start, end, body: '', editingId: null };
  }
  if (prev && prev.file !== file) rerenderFileByPath(prev.file);
  rerenderFileByPath(file);
}

function saveEditor() {
  const ed = S.editor;
  if (!ed || !ed.body.trim()) return;
  const f = S.files.find((x) => x.path === ed.file);
  if (ed.editingId) {
    const c = S.comments.find((x) => x.id === ed.editingId);
    if (c) c.body = ed.body;
  } else {
    const [start, end] = ed.start == null ? [null, null] : [Math.min(ed.start, ed.end), Math.max(ed.start, ed.end)];
    S.comments.push({
      id: Math.random().toString(36).slice(2, 10),
      scope: S.scope,
      file: ed.file,
      side: ed.side || 'new',
      start,
      end,
      body: ed.body,
      snippet: start == null || !f ? [] : snippetFor(f, ed.side, start, end),
      lang: langFor(ed.file),
      createdAt: new Date().toISOString(),
    });
  }
  S.editor = null;
  saveDraft();
  rerenderFileByPath(ed.file);
  renderTree();
  renderStats();
}

function cancelEditor() {
  const ed = S.editor;
  S.editor = null;
  if (ed) rerenderFileByPath(ed.file);
}

// ---------------------------------------------------------------------------
// events

function fileOf(el) {
  const fe = el.closest('.file');
  return fe ? S.files[+fe.dataset.idx] : null;
}

function parseKey(key) {
  const [side, n] = key.split(':');
  return { side, n: parseInt(n, 10) };
}

function paintSelection(fileEl, f) {
  const keys = selectedKeys(f);
  $$('td[data-a]', fileEl).forEach((td) => td.classList.toggle('sel', keys.has(td.dataset.a)));
}

const files = $('#files');

files.addEventListener('mousedown', (e) => {
  const target = e.target.closest('.add-c, td.num[data-a]');
  if (!target || !target.dataset.a || e.button !== 0) return;
  e.preventDefault();
  const f = fileOf(target);
  const { side, n } = parseKey(target.dataset.a);
  const ed = S.editor;
  if (e.shiftKey && ed && ed.file === f.path && ed.side === side && ed.start != null && !ed.editingId) {
    openEditor(f.path, side, Math.min(ed.start, ed.end, n), Math.max(ed.start, ed.end, n));
    return;
  }
  S.drag = { file: f.path, side, start: n, end: n };
  document.body.classList.add('dragging');
  paintSelection(target.closest('.file'), f);
});

files.addEventListener('mouseover', (e) => {
  if (!S.drag) return;
  const td = e.target.closest('td[data-a]');
  if (!td || !td.dataset.a) return;
  const f = fileOf(td);
  const { side, n } = parseKey(td.dataset.a);
  if (!f || f.path !== S.drag.file || side !== S.drag.side) return;
  S.drag.end = n;
  paintSelection(td.closest('.file'), f);
});

document.addEventListener('mouseup', () => {
  if (!S.drag) return;
  const d = S.drag;
  S.drag = null;
  document.body.classList.remove('dragging');
  openEditor(d.file, d.side, Math.min(d.start, d.end), Math.max(d.start, d.end));
});

files.addEventListener('input', (e) => {
  if (e.target.matches('.editor textarea') && S.editor) S.editor.body = e.target.value;
});

files.addEventListener('keydown', (e) => {
  if (!e.target.matches('.editor textarea')) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveEditor();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEditor();
  }
});

files.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const f = fileOf(btn);
  if (!f) return;
  const act = btn.dataset.act;
  const commentId = btn.closest('.comment')?.dataset.id;

  if (act === 'toggle') {
    if (S.viewed.has(viewedKey(f.path))) {
      S.viewed.delete(viewedKey(f.path));
      saveDraft();
    } else if (S.collapsed.has(f.path)) S.collapsed.delete(f.path);
    else S.collapsed.add(f.path);
    rerenderFileByPath(f.path);
    renderTree();
  } else if (act === 'viewed') {
    if (btn.checked) S.viewed.add(viewedKey(f.path));
    else {
      S.viewed.delete(viewedKey(f.path));
      S.collapsed.delete(f.path);
    }
    saveDraft();
    rerenderFileByPath(f.path);
    renderTree();
    if (btn.checked) document.getElementById(`file-${S.files.indexOf(f)}`)?.scrollIntoView({ block: 'nearest' });
  } else if (act === 'show-large') {
    S.forceShow.add(f.path);
    rerenderFileByPath(f.path);
  } else if (act === 'file-comment') {
    S.collapsed.delete(f.path);
    S.editor = { file: f.path, side: 'new', start: null, end: null, body: '', editingId: null };
    rerenderFileByPath(f.path);
  } else if (act === 'edit' && commentId) {
    const c = S.comments.find((x) => x.id === commentId);
    if (c) {
      const prev = S.editor;
      S.editor = { file: c.file, side: c.side, start: c.start, end: c.end, body: c.body, editingId: c.id };
      if (prev && prev.file !== c.file) rerenderFileByPath(prev.file);
      rerenderFileByPath(c.file);
    }
  } else if (act === 'delete' && commentId) {
    S.comments = S.comments.filter((x) => x.id !== commentId);
    saveDraft();
    rerenderFileByPath(f.path);
    renderTree();
    renderStats();
  } else if (act === 'ed-cancel') {
    cancelEditor();
  } else if (act === 'ed-save') {
    saveEditor();
  } else if (act === 'suggest' && S.editor) {
    const ta = $('.editor textarea', btn.closest('.editor'));
    const ed = S.editor;
    const lines = snippetFor(f, ed.side, Math.min(ed.start, ed.end), Math.max(ed.start, ed.end));
    const block = '```suggestion\n' + lines.join('\n') + '\n```\n';
    const pos = ta.selectionStart ?? ta.value.length;
    const prefix = ta.value.slice(0, pos);
    ta.value = prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + block + ta.value.slice(pos);
    ed.body = ta.value;
    ta.focus();
  }
});

$('#tree').addEventListener('click', (e) => {
  const el = e.target.closest('[data-goto]');
  if (!el) return;
  const i = +el.dataset.goto;
  const f = S.files[i];
  S.collapsed.delete(f.path);
  renderFile(i);
  document.getElementById(`file-${i}`)?.scrollIntoView({ block: 'start' });
});

$('#filter').addEventListener('input', (e) => {
  S.filter = e.target.value;
  renderAll();
});

$('#scope').addEventListener('change', (e) => {
  S.scope = e.target.value;
  loadDiff();
});

$('#context').addEventListener('change', (e) => {
  S.context = e.target.value;
  store('ai-review.context', S.context);
  loadDiff();
});

$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b || b.dataset.view === S.view) return;
  S.view = b.dataset.view;
  store('ai-review.view', S.view);
  renderAll();
});

// ---------------------------------------------------------------------------
// comment on selected code text

const selBtn = document.createElement('button');
selBtn.id = 'sel-comment';
selBtn.className = 'sel-comment';
selBtn.type = 'button';
selBtn.hidden = true;
document.body.appendChild(selBtn);
let selTarget = null;
let mouseDown = false;

/** Maps the current text selection in a diff table to a line range, or null. */
function selectionTarget() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  const anchorEl = node && (node.nodeType === 1 ? node : node.parentElement);
  const table = anchorEl?.closest('table.diff');
  if (!table || anchorEl.closest('tr.thread-row')) return null;
  const fileEl = table.closest('.file');
  const f = fileEl && S.files[+fileEl.dataset.idx];
  if (!f) return null;

  const range = sel.getRangeAt(0);
  let cells = $$('td.code[data-a]', table).filter((td) => td.dataset.a && range.intersectsNode(td));
  if (!cells.length) return null;

  let side;
  if (table.classList.contains('split')) {
    // Split view: keep to the column the selection started in.
    const anchorTd = anchorEl.closest('td.code[data-a]') || cells[0];
    const left = anchorTd.cellIndex < 2;
    cells = cells.filter((td) => td.cellIndex < 2 === left);
    side = left ? 'old' : 'new';
    // Context lines on the left are addressed by their old number, which is fine.
  } else {
    side = cells.some((td) => td.dataset.a.startsWith('new:')) ? 'new' : 'old';
  }
  const nums = cells.map((td) => parseKey(td.dataset.a)).filter((k) => k.side === side).map((k) => k.n);
  if (!nums.length) return null;
  return { file: f.path, fileEl, side, start: Math.min(...nums), end: Math.max(...nums) };
}

function hideSelButton() {
  selBtn.hidden = true;
  selTarget = null;
}

function updateSelButton() {
  selTarget = selectionTarget();
  if (!selTarget || S.finished) return hideSelButton();
  const rects = window.getSelection().getRangeAt(0).getClientRects();
  const r = rects[rects.length - 1];
  if (!r) return hideSelButton();
  selBtn.textContent = `💬 Comment on ${rangeLabel(selTarget)}`;
  selBtn.hidden = false;
  const top = r.bottom + window.scrollY + 6;
  const left = Math.min(r.right + window.scrollX, window.scrollX + document.documentElement.clientWidth - selBtn.offsetWidth - 16);
  selBtn.style.top = `${top}px`;
  selBtn.style.left = `${Math.max(window.scrollX + 8, left)}px`;
}

selBtn.addEventListener('mousedown', (e) => {
  e.preventDefault(); // keep the selection alive through the click
  e.stopPropagation();
  const t = selTarget;
  hideSelButton();
  window.getSelection().removeAllRanges();
  if (t) openEditor(t.file, t.side, t.start, t.end);
});

document.addEventListener('mousedown', (e) => {
  if (e.target === selBtn) return;
  mouseDown = true;
  hideSelButton();
  // Split view: restrict native text selection to the column the user started in.
  $$('table.split[data-sel-side]').forEach((t) => delete t.dataset.selSide);
  const td = e.target.closest('table.split td.code[data-a]');
  if (td && !e.target.closest('.add-c')) td.closest('table').dataset.selSide = td.cellIndex < 2 ? 'left' : 'right';
});

document.addEventListener('mouseup', () => {
  mouseDown = false;
  if (!S.drag) setTimeout(updateSelButton, 0);
});

let selTimer = null;
document.addEventListener('selectionchange', () => {
  if (mouseDown) return;
  clearTimeout(selTimer);
  selTimer = setTimeout(updateSelButton, 120);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !selBtn.hidden) hideSelButton();
});

// ---------------------------------------------------------------------------
// finish review

const panel = $('#finish-panel');

function updateFinishNote() {
  const other = S.comments.length - scopeComments().length;
  const unsaved = S.editor && S.editor.body.trim() ? 'You have an unsaved comment open; it will not be included until you add it. ' : '';
  $('#finish-note').textContent =
    unsaved + (other > 0 ? `${other} comment(s) were made on a different scope and will be included.` : '');
}

$('#finish').addEventListener('click', (e) => {
  e.stopPropagation();
  panel.hidden = !panel.hidden;
  $('#finish-error').textContent = '';
  if (!panel.hidden) {
    updateFinishNote();
    $('#general').focus();
  }
});

document.addEventListener('click', (e) => {
  if (!panel.hidden && !e.target.closest('.finish-wrap')) panel.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.hidden) panel.hidden = true;
});

$('#general').addEventListener('input', (e) => {
  S.general = e.target.value;
  saveDraft();
});
$$('input[name=verdict]').forEach((r) =>
  r.addEventListener('change', () => {
    S.verdict = r.value;
    saveDraft();
  })
);

function showDone(title, text) {
  S.finished = true;
  clearTimeout(saveTimer);
  const done = $('#done');
  done.innerHTML = `<div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
  done.hidden = false;
}

$('#submit').addEventListener('click', async () => {
  const err = $('#finish-error');
  err.textContent = '';
  if (S.verdict !== 'approve' && !S.comments.length && !S.general.trim()) {
    err.textContent = 'Add at least one comment, or choose Approve.';
    return;
  }
  const btn = $('#submit');
  btn.disabled = true;
  try {
    await api('POST', '/api/submit', { scope: S.scope, verdict: S.verdict, general: S.general, comments: S.comments });
    const msg =
      S.verdict === 'approve'
        ? 'Claude has been told the changes are approved.'
        : `${S.comments.length} comment(s) were sent to Claude to address.`;
    showDone('Review submitted', `${msg} You can close this tab.`);
  } catch (e) {
    err.textContent = `Submit failed: ${e.message}`;
    btn.disabled = false;
  }
});

$('#close-review').addEventListener('click', async () => {
  try {
    await api('PUT', '/api/draft', { comments: S.comments, general: S.general, verdict: S.verdict, viewed: [...S.viewed] });
    await api('POST', '/api/cancel');
  } catch {
    /* server may already be gone */
  }
  showDone('Review closed', 'Nothing was sent to Claude. Your draft comments are kept for next time.');
});

init().catch((e) => {
  $('#files').innerHTML = `<p class="empty">Failed to start: ${esc(e.message)}</p>`;
});
