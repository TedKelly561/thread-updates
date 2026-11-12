// Status Updates on the Original Thread (M3): the page.
// All decisions live in engine.js (window.Threads). This file only draws state and wires buttons.
// State is saved in localStorage (wrapped in try/catch, so a private window still works).

(function () {
  'use strict';
  const T = window.Threads, S = window.SUMMIT;
  const $ = s => document.querySelector(s);
  const esc = T.esc;
  const KEY = 'm3-thread-updates-v1';
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: lives in memory */ } },
  };
  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- state
  let st, ui;
  function load() {
    const saved = params.get('reset') === '1' ? null : store.get(KEY, null);
    // Dates are relative to today, so a save from another day starts fresh.
    if (saved && saved.state && saved.state.v === 1 && saved.day === S.today) { st = saved.state; ui = Object.assign(defaultUi(), saved.ui || {}); }
    else { st = T.createState(); ui = defaultUi(); }
    if (params.has('shadow')) st.shadow = params.get('shadow') !== '0';
    ui.results = ui.results || {};
  }
  function defaultUi() { return { job: 'SH-1044', tab: 'person', ba: 'before', results: {}, open: {} }; }
  function save() { store.set(KEY, { day: S.today, state: st, ui: { job: ui.job, tab: ui.tab, ba: ui.ba, results: ui.results, open: ui.open } }); }

  // ---------------------------------------------------------------- small helpers
  const vendorOf = job => S.byId(S.vendors, job.vendorId);
  const initials = name => String(name).replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const lines = s => esc(s).replace(/\n/g, '<br>');
  const firstLine = s => { const ls = String(s).split('\n').filter(l => l.trim()); return ls.find(l => !/,\s*$/.test(l)) || ls[0] || ''; };
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const STEP_NAMES = { event: 'Status change', dup: 'Never twice', thread: 'Right thread', replied: 'Customer replied?', template: 'Template',
    quiet: 'Quiet hours', mode: 'Mode', approve: 'Approve first 5', post: 'Post', person: 'Result' };
  const ICON = { good: '✓', warn: '!', bad: '×', info: '→', shadow: '◌' };
  const KIND_CHIP = { sent: ['Sent', 'good'], drafted: ['Would send', 'shade'], queued: ['Queued', 'warn'], person: ['Needs a person', 'bad'],
    skipped: ['Skipped', 'warn'], inbound: ['Reply in', 'info'], admin: ['Note', ''] };

  // ---------------------------------------------------------------- message rendering (shared)
  function msgHtml(m, o) {
    o = o || {};
    const who = m.by === 'auto' ? 'auto' : m.by;
    const open = o.open;
    const tags = [];
    if (m.by === 'auto' && !m.draft) tags.push('<span class="chip good">Automated</span>');
    if (m.draft) tags.push('<span class="chip shade">Draft · not sent</span>');
    if (m.unread) tags.push('<span class="chip bad">Unread</span>');
    if (m.chase) tags.push('<span class="chip bad">Chasing</span>');
    if (m.lateTag) tags.push(`<span class="chip warn">${esc(m.lateTag)}</span>`);
    if (m.by === 'office') tags.push('<span class="chip">Typed by hand</span>');
    const snippet = m.summary || firstLine(m.body);
    const att = (m.attachments || []).map(a => `<span class="att" title="Attachment (sample)"><span class="att-ic" aria-hidden="true">PDF</span>${esc(a.name)} <span class="muted">${esc(a.size)}</span></span>`).join('');
    const quote = o.quote ? `<button type="button" class="dots" data-act="quote" aria-expanded="false" aria-label="Show quoted history">•••</button><blockquote class="quoted" hidden>On ${esc(T.fmtStamp(o.quote.at))}, ${esc(o.quote.name)} wrote:<br>${lines(o.quote.body)}</blockquote>` : '';
    const headers = m.headers ? `<details class="hdrs"><summary>Headers</summary><dl><dt>Subject</dt><dd>${esc(m.subject)}</dd><dt>In-Reply-To</dt><dd>${esc(m.headers['In-Reply-To'])}</dd><dt>References</dt><dd>${esc(m.headers.References)}</dd>${m.key ? `<dt>Idempotency key</dt><dd>${esc(m.key)}</dd>` : ''}</dl></details>` : (m.key ? `<p class="keyline mono">key ${esc(m.key)}</p>` : '');
    const note = m.note ? `<p class="m-note">${esc(m.note)}</p>` : '';
    return `<article class="msg by-${who}${m.draft ? ' draft' : ''}${m.unread ? ' unread' : ''}${m.chase ? ' chase-row' : ''}${open ? ' open' : ''}${o.fresh ? ' fresh' : ''}" data-mid="${esc(m.id || '')}">
      <button type="button" class="msg-top" data-act="msg" aria-expanded="${open ? 'true' : 'false'}">
        <span class="av av-${who}" aria-hidden="true">${esc(m.by === 'auto' || m.by === 'office' ? 'S' : initials(m.name))}</span>
        <span class="who"><b>${esc(m.name)}</b> <span class="em">${esc(m.email || '')}</span><span class="snip">${esc(snippet)}</span></span>
        <time>${esc(T.fmtStamp(m.at))}</time>
      </button>
      <div class="msg-body">
        ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
        ${m.to ? `<div class="to">to ${esc(m.to)}</div>` : ''}
        <div class="txt">${lines(m.body)}</div>
        ${att ? `<div class="atts">${att}</div>` : ''}
        ${note}${quote}${headers}
      </div>
    </article>`;
  }
  const gap = (a, b) => { const h = (b - a) / T.HOUR; return h >= 1 ? `${h >= 24 ? Math.round(h / 24 * 10) / 10 + ' days' : Math.round(h) + ' h'} later` : `${Math.round(h * 60)} min later`; };

  // ---------------------------------------------------------------- 1. before / after
  function renderBA() {
    const s = T.story();
    const v = S.byId(S.vendors, 'V2');
    $('#baSub').textContent = `Claim ${s.job.claim} · ${s.customer.name} · ${s.job.issue.toLowerCase()} · ${v.name} · tech ${s.tech.name}`;
    $('#changed').innerHTML = s.metrics.map(m => `<div class="ch"><dt>${esc(m.k)}</dt><dd><s>${esc(m.beforeText || m.before)}</s> <span aria-hidden="true">→</span><span class="sr-only">became</span> <b>${esc(m.afterText != null ? m.afterText : m.after)}</b></dd></div>`).join('');

    const main = s.before.filter(m => !m.newThread);
    const side = s.before.filter(m => m.newThread);
    main[2].lateTag = 'First reply: 26 h after the work order';
    const conv = (list, openLast, gaps) => list.map((m, i) => (gaps && i ? `<div class="gap">${esc(gap(list[i - 1].at, m.at))}</div>` : '') + msgHtml(m, { open: openLast && i === list.length - 1 })).join('');
    $('#beforeConvo').innerHTML = `
      <div class="subj"><h4>${esc(s.subject)}</h4><span class="chip">Inbox</span><span class="count">${main.length}</span></div>
      <div class="msgs">${conv(main, true, true)}</div>
      <div class="side-thread"><div class="side-h"><span class="chip warn">A second thread</span> started by the homeowner: <b>${esc(side[0].newThread)}</b></div><div class="msgs">${conv(side, false, false)}</div></div>
      <ul class="facts">
        <li class="bad"><b>Bluepeak portal:</b> still “Assigned”, not updated in 5 days</li>
        <li class="bad"><b>Completion report:</b> not sent yet. The office is behind.</li>
        <li class="warn"><b>Office replies:</b> late, no claim # in most, no tech name, no time window</li>
      </ul>`;
    const after = s.after.map(m => Object.assign({}, m));
    $('#afterConvo').innerHTML = `
      <div class="subj"><h4>${esc(s.replySubject)}</h4><span class="chip">Inbox</span><span class="count">${after.length}</span></div>
      <div class="msgs">${after.map((m, i) => (i ? `<div class="gap">${esc(gap(after[i - 1].at, m.at))}</div>` : '') + msgHtml(m, { open: i === after.length - 1, quote: i ? after[0] : null })).join('')}</div>
      <ul class="facts">
        <li class="good"><b>Bluepeak portal:</b> “Completed”, updated at every step</li>
        <li class="good"><b>Homeowner:</b> got a friendly version of each update on his own thread, so he never had to write in</li>
        <li class="good"><b>Office replies typed:</b> none. Every update has the claim #, the tech, the window or ETA.</li>
      </ul>`;
    setBA(ui.ba);
  }
  function setBA(which) {
    ui.ba = which;
    $('#baGrid').dataset.show = which;
    document.querySelectorAll('[data-ba]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ba === which)));
  }

  // ---------------------------------------------------------------- 2. mode, counters, clock
  function renderMode() {
    $('#shadow').checked = st.shadow;
    document.body.classList.toggle('is-shadow', st.shadow);
    $('#shadowState').textContent = st.shadow ? 'ON' : 'OFF';
    $('#shadowDesc').innerHTML = st.shadow
      ? '<b>Nothing is sent.</b> Each update is created as a draft on the right thread, and the log says what it would have sent. Turn it off to post for real (in this demo).'
      : '<b>Live.</b> Updates are posted on the thread. Anything that isn\'t clear-cut still goes to a person.';
    const c = T.counts(st);
    $('#counters').innerHTML = [
      ['Updates sent', c.sent, 'good'], ['Drafts in shadow', c.drafts, 'shade'], ['Held for a person', c.held, c.held ? 'bad' : ''],
      ['Duplicates skipped', c.dupes, c.dupes ? 'warn' : ''], ['Waiting for 7 AM', c.queued, c.queued ? 'warn' : ''],
    ].map(([k, n, tone]) => `<div class="ct ${tone}"><dt>${k}</dt><dd>${n}</dd></div>`).join('');
    $('#clock').textContent = T.fmtTime(st.clock);
    $('#clockDay').textContent = T.fmtDay(st.clock);
    $('#quietChip').hidden = !T.inQuietHours(st.clock);
    $('#morningBtn').hidden = !(T.inQuietHours(st.clock) || st.queue.length);
    $('#eveningBtn').hidden = T.inQuietHours(st.clock);
  }

  // ---------------------------------------------------------------- 3. jobs
  function renderJobs() {
    $('#jobs').innerHTML = T.SAMPLES.map(s => {
      const j = st.jobs[s.jobId], ch = T.channelOf(j), v = vendorOf(j);
      const open = T.openPerson(st).some(p => p.jobId === j.id);
      const status = j.status === 'new' ? 'New' : T.EVENTS[j.status].status;
      return `<button type="button" class="job${ui.job === j.id ? ' active' : ''}" data-act="job" data-job="${j.id}" aria-pressed="${ui.job === j.id}">
        <span class="j-top"><span class="mono j-id">${j.id}</span><span class="chip ch-${ch.kind}">${esc(ch.label)}</span>${open ? '<span class="dot-bad" title="Needs a person">!</span>' : ''}</span>
        <span class="j-name">${esc(j.customerName)}</span>
        <span class="j-meta">${esc(v.short)}${j.claim ? ' · ' + esc(j.claim) : ''} · <b>${esc(status)}</b></span>
      </button>`;
    }).join('');
  }

  const OUTCOME = {
    sent: ['good', 'Posted on the thread', r => `${T.EVENTS[r.event.type].status} update posted on ${r.thread}. Nobody had to type it.`],
    drafted: ['shadow', 'Shadow mode: draft created, nothing sent', r => `A draft reply sits on ${r.thread}. The log says what would have gone out.`],
    queued: ['warn', 'Quiet hours: waiting until 7:00 AM', r => `It's after 8 PM, so the homeowner update waits for ${T.fmtStamp(r.queueItem.sendAt)}.`],
    held: ['bad', 'Sent to a person', r => r.personItem.why],
    skipped: ['warn', 'Already done, skipped', r => r.logEntry.title.replace(/^SH-\d+: /, '') + '.'],
    replied: ['warn', 'The customer wrote in', () => 'Their message is unread. The next update on this thread waits for a person.'],
    unmatched: ['warn', 'Reply on an unmatched thread', () => 'It can\'t pause a thread it can\'t find. The office inbox shows the message as normal.'],
    handled: ['info', 'Handled by a person', () => 'Closed by hand. This update will never be sent automatically.'],
  };

  function renderJobCard() {
    const j = st.jobs[ui.job], ch = T.channelOf(j), v = vendorOf(j), tech = T.techOf(j);
    const sample = T.SAMPLES.find(s => s.jobId === j.id);
    const lc = T.LIFECYCLE;
    const reached = new Set(j.history.map(h => h.type));
    const steps = lc.map((k, i) => {
      const cur = j.status === k || (k === 'scheduled' && j.status === 'rescheduled') || (k === 'en_route' && j.status === 'waiting_parts' && false);
      const done = reached.has(k) || (k === 'scheduled' && reached.has('rescheduled'));
      return `<li class="${cur ? 'cur' : done ? 'done' : ''}"><span class="st-dot" aria-hidden="true">${done && !cur ? '✓' : i + 1}</span><span>${esc(T.EVENTS[k].short)}</span></li>`;
    }).join('');
    const exc = j.status === 'waiting_parts' ? '<span class="chip warn">Waiting on parts</span>' : j.status === 'rescheduled' ? '<span class="chip warn">Rescheduled</span>' : '';
    const btn = (type, cls) => `<button type="button" class="btn small ${cls || ''}" data-act="event" data-type="${type}" ${T.canDo(j, type) ? '' : 'disabled'}>${esc(T.EVENTS[type].label)}</button>`;
    const r = ui.results[j.id];
    let resHtml = '';
    if (r && OUTCOME[r.outcome]) {
      const [tone, title, text] = OUTCOME[r.outcome];
      resHtml = `<div class="decision ${tone}" role="status">
        <span class="d-k">Last event${r.event ? ': ' + esc(T.EVENTS[r.event.type].status) : ''}</span>
        <span class="d-v">${esc(title)}</span>
        <p>${esc(text(r))}</p>
        ${r.outcome === 'held' ? '<button type="button" class="btn ghost small" data-act="tab" data-tab="person">Open Needs a person</button>' : ''}
        ${r.thread ? '<a class="to-thread" href="#threadPane">See it on the thread ↓</a>' : ''}
      </div>`;
      if (r.steps && r.steps.length) {
        resHtml += `<ol class="trace" aria-label="What the pipeline checked">${r.steps.map(s => `<li class="${s.tone}"><span class="t-ic" aria-hidden="true">${ICON[s.tone] || '·'}</span><span class="t-k">${esc(STEP_NAMES[s.k] || s.k)}</span><b>${esc(s.label)}</b><span class="t-d">${esc(s.detail)}</span></li>`).join('')}</ol>`;
      }
    }
    const win = j.window ? `${T.fmtDay(j.window.start)}, ${T.fmtTime(j.window.start)}–${T.fmtTime(j.window.end)}` : 'not booked yet';
    $('#jobcard').innerHTML = `
      <div class="jc-head">
        <div><span class="mono jc-id">${j.id}</span><h3>${esc(j.customerName)}</h3><p class="muted small">${esc(j.issue)}</p></div>
        <span class="av-tech" style="--c:${tech.color}" title="${esc(tech.name)}" aria-hidden="true">${esc(tech.initials)}</span>
      </div>
      <dl class="jc-dl">
        <dt>From</dt><dd>${esc(v.name)}${j.claim ? ` · <span class="mono">${esc(j.claim)}</span>` : ''}</dd>
        <dt>Updates go</dt><dd>${esc(ch.label)}${ch.kind !== 'email' ? ' · ' + esc(ch.system) : ch.audience === 'homeowner' ? ' · to the homeowner' : ''}</dd>
        <dt>Tech</dt><dd>${esc(tech.name)}</dd>
        <dt>Window</dt><dd>${esc(win)}</dd>
      </dl>
      <p class="hint small">${esc(sample.hint)}</p>
      <ol class="stepper" aria-label="Job status">${steps}</ol>${exc ? `<div class="exc">${exc}</div>` : ''}
      <div class="acts" role="group" aria-label="Move the job">
        ${btn('received')}${btn('scheduled')}${btn('en_route')}${btn('completed')}
      </div>
      <div class="acts alt" role="group" aria-label="Exceptions and tests">
        ${btn('waiting_parts', 'ghost')}${btn('rescheduled', 'ghost')}
        <button type="button" class="btn ghost small" data-act="reply">Customer replied</button>
        <button type="button" class="btn ghost small" data-act="repeat" ${j.lastEvent ? '' : 'disabled'} title="Fire the last event again, like a retried webhook">Same event again</button>
        <button type="button" class="btn ghost small" data-act="resetJob">Reset job</button>
      </div>
      <div class="result" id="result">${resHtml}</div>`;
  }

  // ---------------------------------------------------------------- 3b. the thread
  function renderThread() {
    const j = st.jobs[ui.job], ch = T.channelOf(j);
    const m = T.threadFor(st, j.id);
    const el = $('#thread');
    $('#threadHow').textContent = m.status === 'matched' ? m.how : '';
    if (m.status !== 'matched') {
      const all = st.threads;
      const mini = t => `<div class="cand"><div class="cand-h"><span class="mono">${esc(t.id)}</span> <b>${esc(t.subject)}</b></div><p class="small muted">${esc(t.messages[0].name)} · ${esc(T.fmtStamp(t.messages[0].at))}</p><p class="small">${esc(firstLine(t.messages[t.messages.length - 1].body))}</p></div>`;
      let body;
      if (m.status === 'ambiguous') {
        body = `<p><b>${m.candidates.length} ${esc(ch.label.toLowerCase())}s mention claim ${esc(j.claim)}.</b> It won't guess which one the vendor is watching, so every update for this job goes to a person until someone picks.</p><div class="cands">${m.candidates.map(mini).join('')}</div>`;
      } else {
        const closest = (m.closest || []).map(t => all[t.id] || t);
        body = `<p><b>No ${esc(ch.label.toLowerCase())} matches ${esc(j.claim || j.id)}.</b> It never starts a new thread: the vendor wouldn't be watching it, and it would split the conversation in two.</p>${closest.length ? `<p class="small muted">Closest, <b>not used</b>: a different claim number for the same homeowner. Could be a typo by the vendor, or a different job. A person should check.</p><div class="cands">${closest.map(mini).join('')}</div>` : ''}`;
      }
      el.innerHTML = `<div class="nomatch"><div class="nm-icon" aria-hidden="true">?</div><div><h3>${m.status === 'ambiguous' ? 'More than one possible thread' : m.status === 'mismatch' ? 'Saved thread doesn\'t match' : 'No matching thread'}</h3><p class="small muted">${esc(m.how)}</p>${body}</div></div>`;
      return;
    }
    const t = m.thread;
    const msgs = t.messages;
    const lastReal = msgs.filter(x => !x.draft);
    const isOpen = (x, i) => ui.open[x.id] != null ? ui.open[x.id] : (i === msgs.length - 1 || x.unread);
    if (t.kind === 'email') {
      el.innerHTML = `<div class="mailview">
        <div class="subj"><h3>${esc(lastReal.length > 1 || msgs.length > 1 ? T.replySubject(t.subject) : t.subject)}</h3><span class="chip">Inbox</span><span class="count">${msgs.length}</span></div>
        <div class="msgs">${msgs.map((x, i) => msgHtml(x, { open: isOpen(x, i), fresh: x.id === ui.fresh, quote: x.by === 'auto' && i ? msgs[i - 1] : null })).join('')}</div>
      </div>`;
    } else if (t.kind === 'ticket') {
      el.innerHTML = `<div class="ticketview">
        <div class="tk-bar"><span class="tk-sys">${esc(T.CHANNELS.V1.system)}</span><span class="mono">Ticket ${esc(t.id)}</span><span class="pill-st ${t.ticketStatus === 'Solved' ? 'good' : ''}">${esc(t.ticketStatus)}</span></div>
        <h3>${esc(t.subject)}</h3>
        <dl class="tk-fields"><dt>Claim #</dt><dd class="mono">${esc(t.claim)}</dd><dt>Requester</dt><dd>${esc(t.messages[0].name)}</dd><dt>Assignee</dt><dd>Summit Home Services</dd></dl>
        <ol class="comments">${msgs.map(x => `<li class="cm by-${x.by}${x.draft ? ' draft' : ''}${x.unread ? ' unread' : ''}${x.id === ui.fresh ? ' fresh' : ''}">
          <span class="av av-${x.by}" aria-hidden="true">${esc(x.by === 'auto' ? 'S' : initials(x.name))}</span>
          <div class="cm-b"><div class="cm-h"><b>${esc(x.by === 'auto' ? 'Summit Home Services (automation)' : x.name)}</b>
          ${x.draft ? '<span class="chip shade">Draft · not posted</span>' : x.by === 'auto' ? '<span class="chip good">Public reply</span>' : ''}${x.unread ? '<span class="chip bad">Unread</span>' : ''}<time>${esc(T.fmtStamp(x.at))}</time></div>
          <div class="cm-t${x.by === 'auto' ? ' mono' : ''}">${lines(x.body)}</div>
          ${(x.attachments || []).map(a => `<span class="att"><span class="att-ic" aria-hidden="true">PDF</span>${esc(a.name)}</span>`).join('')}
          ${x.note ? `<p class="m-note">${esc(x.note)}</p>` : ''}${x.key ? `<p class="keyline mono">key ${esc(x.key)}</p>` : ''}</div></li>`).join('')}</ol>
      </div>`;
    } else {
      el.innerHTML = `<div class="portalview">
        <div class="pt-bar"><span class="pt-sys">${esc(T.CHANNELS.V3.system)}</span><span class="pill-st ${t.portalStatus === 'Completed' ? 'good' : ''}">${esc(t.portalStatus)}</span></div>
        <h3>Claim <span class="mono">${esc(t.id)}</span> · ${esc(S.byId(S.customers, t.customerId).name)}</h3>
        <table class="pt-notes"><caption class="sr-only">Claim notes</caption><thead><tr><th scope="col">When</th><th scope="col">By</th><th scope="col">Note</th></tr></thead>
        <tbody>${msgs.map(x => `<tr class="by-${x.by}${x.draft ? ' draft' : ''}${x.unread ? ' unread' : ''}${x.id === ui.fresh ? ' fresh' : ''}"><td class="mono nowrap">${esc(T.fmtDay(x.at))}<br>${esc(T.h24(x.at))}</td>
          <td>${esc(x.by === 'auto' ? 'Summit (auto)' : x.name)}${x.draft ? '<br><span class="chip shade">Draft</span>' : ''}${x.unread ? '<br><span class="chip bad">Unread</span>' : ''}</td>
          <td><span class="${x.by === 'auto' ? 'mono' : ''}">${lines(x.body)}</span>${(x.attachments || []).map(a => `<br><span class="att"><span class="att-ic" aria-hidden="true">PDF</span>${esc(a.name)}</span>`).join('')}${x.note ? `<p class="m-note">${esc(x.note)}</p>` : ''}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }
  }

  // ---------------------------------------------------------------- 4. lists
  function previewOf(p) { return p.preview ? p.preview.body : ''; }
  function personCard(p) {
    const j = st.jobs[p.jobId];
    const ev = T.EVENTS[p.event.type].status;
    let ctx = '', btns = '';
    const cand = id => { const t = st.threads[id]; return `<li><span class="mono">${esc(id)}</span> ${esc(t.subject)} <span class="muted small">· ${esc(T.fmtStamp(t.messages[0].at))}</span> <button type="button" class="btn ghost small" data-act="resolve" data-pid="${p.id}" data-action="pick" data-arg="${esc(id)}">Use this thread</button></li>`; };
    if (p.kind === 'ambiguous') ctx = `<div class="p-k">Candidates</div><ul class="p-cands">${p.candidates.map(cand).join('')}</ul>`;
    if (p.kind === 'no_thread' || p.kind === 'mismatch') ctx = p.closest && p.closest.length ? `<div class="p-k">Closest (different claim #, same homeowner)</div><ul class="p-cands">${p.closest.map(cand).join('')}</ul>` : '<p class="small muted">Nothing close. Find the thread by hand, or call the vendor.</p>';
    if (p.kind === 'customer_replied') ctx = `<div class="p-k">What they wrote</div><blockquote class="p-quote">${lines(p.reply)}</blockquote>`;
    if (p.status === 'open') {
      if (p.kind === 'approval') btns = `<button type="button" class="btn small" data-act="resolve" data-pid="${p.id}" data-action="approve">Approve and post</button><button type="button" class="btn ghost small" data-act="resolve" data-pid="${p.id}" data-action="reject">Reject</button>`;
      else if (p.kind === 'customer_replied') btns = `<button type="button" class="btn small" data-act="resolve" data-pid="${p.id}" data-action="read_send">Mark read and send the update</button><button type="button" class="btn ghost small" data-act="resolve" data-pid="${p.id}" data-action="read_skip">Mark read, I'll reply myself</button>`;
      else btns = `<button type="button" class="btn ghost small" data-act="resolve" data-pid="${p.id}" data-action="dismiss">I'll handle it by hand</button>`;
    }
    return `<article class="p-card k-${p.kind}${p.status !== 'open' ? ' closed' : ''}">
      <div class="p-top"><span class="mono p-id">${esc(j.id)}</span><b class="p-subj">${esc(p.title)}</b><span class="chip">${esc(ev)} update</span><time class="small muted">${esc(T.fmtStamp(p.at))}</time></div>
      <p class="p-why">${esc(p.why)}</p>
      <div class="p-grid">
        <div>${ctx}</div>
        <div><div class="p-k">The update it was going to post</div><pre class="p-pre">${esc(previewOf(p))}</pre></div>
      </div>
      ${p.status === 'open' ? `<div class="row p-btns">${btns}<button type="button" class="btn ghost small" data-act="job" data-job="${j.id}" data-scroll="1">Show the job</button></div>` : `<p class="p-done small"><span class="chip good">Done</span> ${esc(p.resolution || '')}</p>`}
    </article>`;
  }
  function renderLists() {
    const open = T.openPerson(st), closed = st.person.filter(p => p.status !== 'open').slice(0, 8);
    $('#nPerson').textContent = open.length;
    $('#nPerson').className = 'chip' + (open.length ? ' bad' : '');
    $('#nQueue').textContent = st.queue.length;
    $('#nLog').textContent = st.log.length;
    $('#person').innerHTML = (open.length ? open.map(personCard).join('') : '<p class="q-empty muted">Nothing needs a person right now. Try <button type="button" class="linkish" data-act="job" data-job="SH-1049" data-scroll="1">SH-1049</button>: its claim has no thread.</p>')
      + (closed.length ? `<details class="p-closed"><summary>Handled recently (${closed.length})</summary>${closed.map(personCard).join('')}</details>` : '');
    $('#queue').innerHTML = st.queue.length ? st.queue.map(q => `<div class="q-row"><span class="mono q-id">${esc(q.jobId)}</span><span class="q-main"><b>${esc(T.EVENTS[q.event.type].status)}</b> · ${esc(q.summary)}</span><span class="chip warn">Sends ${esc(T.fmtStamp(q.sendAt))}</span></div>`).join('')
      : '<p class="q-empty muted">Nothing waiting. Pick SH-1042 (a homeowner), press <b>Jump to 8:50 PM</b>, then move the job along with shadow mode off.</p>';
    $('#log').innerHTML = st.log.length ? st.log.slice(0, 80).map(e => {
      const [lab, tone] = KIND_CHIP[e.kind] || ['Note', ''];
      return `<li class="log-e k-${e.kind}"><div class="l-top"><time>${esc(T.fmtStamp(e.at))}</time><span class="chip ${tone}">${lab}</span>${e.shadow && e.kind === 'drafted' ? '<span class="chip shade">shadow</span>' : ''}${e.key ? `<span class="l-key mono">${esc(e.key)}</span>` : ''}</div>
        <div class="l-title">${esc(e.title)}</div>${e.detail ? `<div class="l-detail small muted">${esc(e.detail)}</div>` : ''}
        ${e.steps && e.steps.length ? `<details><summary>Steps</summary><ol class="steps-l">${e.steps.map(s => `<li><span class="s-k">${esc(STEP_NAMES[s.k] || s.k)}</span><span><b>${esc(s.label)}</b> ${esc(s.detail)}</span></li>`).join('')}</ol></details>` : ''}</li>`;
    }).join('') : '<li class="q-empty muted">The log is empty. Move a job along to see entries.</li>';
    $('#clearLog').hidden = !st.log.length;
    setTab(ui.tab, false);
  }
  function setTab(tab, focus) {
    ui.tab = tab;
    document.querySelectorAll('[role="tab"]').forEach(b => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      $('#pane-' + b.dataset.tab).hidden = !on;
      if (on && focus) b.focus();
    });
  }

  // ---------------------------------------------------------------- 5. rules
  function renderRules() {
    const R = [
      ['Shadow mode first', 'On a first visit every update is created as a draft on the right thread and logged as “would send”. Nothing goes out until someone has compared it with reality and switched it off.', null, 'Toggle shadow mode above'],
      ['Right thread or no send', 'It finds the thread by the thread ID saved at intake or the claim #, and checks the customer or vendor matches. No match, or more than one: it goes to a person with the full context. It never starts a new thread and never guesses.', 'SH-1049', 'SH-1049 (no thread) or SH-1061 (two tickets)'],
      ['Never twice', 'Every update has a key: job + status + appointment window. If the same event arrives again (a double edit, a retried webhook), it is logged “already sent, skipped”.', 'SH-1044', '“Same event again” on any job'],
      ['Quiet hours for homeowners', 'No emails to homeowners between 8 PM and 7 AM. They wait until 7:00 AM and are checked again first. Warranty companies get updates around the clock.', 'SH-1042', 'SH-1042 + Jump to 8:50 PM'],
      ['Customer replied? Pause.', 'If the customer or vendor has written something nobody has read yet, it won\'t post a cheery update on top of a complaint. It pauses that thread and flags it to a person.', 'SH-1042', '“Customer replied”, then the next status'],
      ['Approve the first 5', 'A new vendor template needs a person\'s OK for its first 5 live sends. After that it runs on its own.', 'SH-1043', 'SH-1043 with shadow mode off'],
      ['Everything is logged', 'Every event, draft, send, skip and hand-off is in the activity log with a timestamp and the checks it ran.', null, 'Activity log tab'],
    ];
    $('#rules').innerHTML = R.map(([h, p, job, tryTxt]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p><p class="try small">Try it: ${job ? `<button type="button" class="linkish" data-act="job" data-job="${job}" data-scroll="1">${esc(tryTxt)}</button>` : esc(tryTxt)}</p></li>`).join('');
  }

  // ---------------------------------------------------------------- render all
  function render() { renderMode(); renderJobs(); renderJobCard(); renderThread(); renderLists(); save(); }

  // ---------------------------------------------------------------- actions
  function remember(r) {
    if (!r) return;
    ui.results[r.jobId || ui.job] = { outcome: r.outcome, event: r.event, steps: r.steps, thread: r.thread, queueItem: r.queueItem,
      personItem: r.personItem && { why: r.personItem.why }, logEntry: r.logEntry && { title: r.logEntry.title } };
    if (r.message) ui.fresh = r.message.id;
  }
  const SAY = { sent: 'Posted on the thread', drafted: 'Draft created (shadow mode)', queued: 'Queued for 7:00 AM', held: 'Sent to Needs a person', skipped: 'Duplicate skipped', replied: 'Customer replied', handled: 'Handled' };
  function act(el) {
    const a = el.dataset.act;
    ui.fresh = null;
    if (a === 'job') {
      $('#toast').classList.remove('show');
      ui.job = el.dataset.job; render();
      if (el.dataset.scroll) document.querySelector('.sim').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    if (a === 'event') { const r = T.runEvent(st, ui.job, el.dataset.type); remember(r); render(); toast(SAY[r.outcome] || r.outcome); if (r.outcome === 'held') bumpTab(); return; }
    if (a === 'reply') { const r = T.customerReplied(st, ui.job); remember(r); render(); toast(SAY[r.outcome] || 'Reply'); return; }
    if (a === 'repeat') { const r = T.repeatLast(st, ui.job); remember(r); render(); toast(SAY[r.outcome] || r.outcome); return; }
    if (a === 'resetJob') { T.resetJob(st, ui.job); delete ui.results[ui.job]; render(); toast(`${ui.job} reset`); return; }
    if (a === 'resolve') {
      const p = st.person.find(x => x.id === el.dataset.pid);
      const r = T.resolve(st, el.dataset.pid, el.dataset.action, el.dataset.arg);
      if (r && p) { r.jobId = p.jobId; remember(r); ui.job = p.jobId; }
      render(); toast(r ? (SAY[r.outcome] || 'Done') : 'Already handled'); return;
    }
    if (a === 'tab') { setTab(el.dataset.tab, true); save(); document.querySelector('#lists').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (a === 'msg') {
      const art = el.closest('.msg'); const open = !art.classList.contains('open');
      art.classList.toggle('open', open); el.setAttribute('aria-expanded', String(open));
      if (art.dataset.mid && art.closest('#thread')) { ui.open[art.dataset.mid] = open; save(); }
      return;
    }
    if (a === 'quote') {
      const q = el.nextElementSibling; q.hidden = !q.hidden; el.setAttribute('aria-expanded', String(!q.hidden)); return;
    }
  }
  function bumpTab() { setTab('person', false); save(); }

  function wire() {
    document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && !el.disabled) act(el); });
    document.querySelectorAll('[data-ba]').forEach(b => b.addEventListener('click', () => { setBA(b.dataset.ba); save(); }));
    $('#shadow').addEventListener('change', e => {
      st.shadow = e.target.checked;
      st.log.unshift({ id: 'L' + (++st.seq), at: st.clock, kind: 'admin', title: st.shadow ? 'Shadow mode turned ON: updates become drafts, nothing is sent' : 'Shadow mode turned OFF: updates are posted for real' });
      render(); toast(st.shadow ? 'Shadow mode on: drafts only' : 'Live: updates will be posted');
    });
    $('#eveningBtn').addEventListener('click', () => { T.jumpToEvening(st); render(); toast('Clock moved to 8:50 PM. Homeowner updates now wait for morning.'); });
    $('#morningBtn').addEventListener('click', () => {
      const out = T.jumpToMorning(st);
      out.forEach(r => remember(r));
      render(); toast(out.length ? `7:00 AM: ${out.length} queued update${out.length > 1 ? 's' : ''} released` : 'Clock moved to 7:00 AM');
    });
    $('#resetAll').addEventListener('click', () => { const sh = st.shadow; st = T.createState({ shadow: sh }); ui.results = {}; ui.open = {}; render(); toast('Demo reset'); });
    $('#clearLog').addEventListener('click', () => { st.log = []; render(); toast('Log cleared'); });
    // Arrow keys move between tabs.
    $('.tabs').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...document.querySelectorAll('[role="tab"]')]; const i = tabs.findIndex(t => t.dataset.tab === ui.tab);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[n].dataset.tab, true); save(); e.preventDefault();
    });
    document.querySelectorAll('[role="tab"]').forEach(b => b.addEventListener('click', () => { setTab(b.dataset.tab, false); save(); }));
  }

  load();
  renderBA();
  renderRules();
  wire();
  render();
  window.ThreadDemo = { get state() { return st; }, render };
})();
