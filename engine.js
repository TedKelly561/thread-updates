// Status Updates on the Original Thread (M3): the decision engine.
// Pure state + functions (window.Threads). No DOM here, so it can be tested in Node:
//   global.window = global; require('shared/data.js'); const T = require('./engine.js');
//
// The idea: when a job's status changes, post a short, correct update as a REPLY on the
// thread the customer or vendor is already reading (an email thread, a helpdesk ticket,
// or a note on the vendor's portal). Every event goes through the same pipeline:
//
//   event → never twice → right thread or no send → customer replied? → template
//         → quiet hours → shadow mode → approve the first 5 → post on the thread
//
// Anything the pipeline is not sure about goes to "Needs a person" with the full story.
// It never starts a new thread and never guesses which thread is the right one.
// All data is fictional (see shared/data.js).

(function (root) {
  'use strict';
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const S = root.SUMMIT;
  const T0 = +new Date(S.today);                                   // today 00:00 local
  const at = (day, h = 0, m = 0) => { const t = new Date(T0); t.setDate(t.getDate() + day); t.setHours(h, m, 0, 0); return +t; };
  const START_CLOCK = at(0, 10, 12);                               // demo clock starts here
  const QUIET = { from: 20, to: 7 };                               // 8 PM to 7 AM, homeowners only
  const APPROVE_FIRST = 5;                                         // new templates: first 5 sends need a person
  const OFFICE = { name: 'Summit Home Services', email: 'dispatch@summit-home.example' };
  const byId = (list, id) => list.find(x => x.id === id);

  // ---------------------------------------------------------------- channels
  // Where each sender expects to hear back. Vendors are exempt from quiet hours.
  const CHANNELS = {
    V2: { kind: 'email',  audience: 'vendor',    label: 'Email thread',       system: 'Email',
          contact: { name: 'Bluepeak Claims Desk', email: 'claims@bluepeak-protection.example' }, domain: 'bluepeak-protection.example',
          matchBy: 'Claim # in the subject, sent from bluepeak-protection.example' },
    V1: { kind: 'ticket', audience: 'vendor',    label: 'Helpdesk ticket',    system: 'Northstar Partner Support',
          contact: { name: 'Northstar Dispatch', email: 'dispatch@northstar-warranty.example' }, domain: 'northstar-warranty.example',
          matchBy: 'Claim # field on the ticket' },
    V3: { kind: 'portal', audience: 'vendor',    label: 'Vendor portal note', system: 'Harbor Service Partner Portal',
          contact: { name: 'Harbor Appliance Care', email: 'service@harbor-appliance.example' }, domain: 'harbor-appliance.example',
          matchBy: 'Claim # is the portal record' },
    V0: { kind: 'email',  audience: 'homeowner', label: 'Email thread',       system: 'Email',
          matchBy: 'Thread ID saved when the request came in, checked against the customer\'s address' },
  };

  // One template set per vendor. A brand-new template has to earn trust: the first 5 live
  // sends wait for a person's OK. Harbor's portal template is new in this demo (2 of 5 done).
  const TEMPLATES = {
    V2: { name: 'Bluepeak claim email',       approvedAtStart: 5 },
    V1: { name: 'Northstar ticket comment',   approvedAtStart: 5 },
    V3: { name: 'Harbor portal note',         approvedAtStart: 2, isNew: true },
    V0: { name: 'Homeowner email (friendly)', approvedAtStart: 5 },
  };

  // ---------------------------------------------------------------- events
  const EVENTS = {
    received:      { label: 'Acknowledge',        status: 'Received',         short: 'Received' },
    scheduled:     { label: 'Schedule',           status: 'Scheduled',        short: 'Scheduled' },
    en_route:      { label: 'Tech en route',      status: 'Tech en route',    short: 'En route' },
    completed:     { label: 'Completed + report', status: 'Completed',        short: 'Completed' },
    waiting_parts: { label: 'Waiting on parts',   status: 'Waiting on parts', short: 'Parts' },
    rescheduled:   { label: 'Reschedule',         status: 'Rescheduled',      short: 'Rescheduled' },
  };
  const LIFECYCLE = ['received', 'scheduled', 'en_route', 'completed'];
  // Which status changes can happen next, from each status.
  const NEXT = {
    new: ['received'],
    received: ['scheduled'],
    scheduled: ['en_route', 'rescheduled'],
    rescheduled: ['en_route', 'rescheduled'],
    en_route: ['completed', 'waiting_parts'],
    waiting_parts: ['scheduled'],
    completed: [],
  };

  // ---------------------------------------------------------------- sample jobs
  // Real jobs from SUMMIT.jobs, each with the details a status update needs.
  const SAMPLES = [
    { jobId: 'SH-1044', hint: 'Bluepeak email thread. Matched by claim # in the subject.',
      work: 'Cleaned the flame sensor and replaced a clogged filter. Furnace ran 3 full cycles without shutting off.',
      part: 'Furnace hot surface igniter' },
    { jobId: 'SH-1041', hint: 'Northstar helpdesk ticket. Matched by the claim # field.',
      work: 'Replaced the failed 45/5 µF run capacitor. Condenser running, supply air 56°F.',
      part: 'Condenser fan motor 1/4 HP' },
    { jobId: 'SH-1043', hint: 'Harbor portal note. New template: first 5 live sends need a person\'s OK.',
      work: 'Replaced the washer drain pump. Test drain cycle ran clean, no 5E code.',
      part: 'Washer drain pump' },
    { jobId: 'SH-1042', hint: 'Homeowner email. Friendly wording, quiet hours apply.',
      work: 'Replaced the leaking 50-gallon gas water heater and the relief valve, then checked every joint for leaks.',
      part: '50-gallon gas water heater', threadRef: { id: 'th-1042', by: 'intake' } },
    { jobId: 'SH-1049', hint: 'Bluepeak claim with no matching thread. Goes to a person.', tech: 'T2',
      work: 'Replaced the toilet fill valve. No more running.',
      part: 'Toilet fill valve' },
    { jobId: 'SH-1061', hint: 'Northstar claim with two open tickets. Goes to a person.',
      work: 'Cleared a blocked dryer vent and replaced the drum belt. Dries in one cycle.',
      part: 'Dryer drum belt & idler kit' },
  ];

  // What the customer or vendor writes when "Customer replied" is pressed.
  const REPLIES = {
    V2: 'Homeowner called us and is upset: says the window has passed and nobody has called. Please advise today.',
    V1: 'Homeowner now reports a burning smell from the outdoor unit. Please confirm priority and call her.',
    V3: 'Customer asked if the visit can move to the afternoon. She works mornings.',
    V0: 'Hi, the leak is worse this morning and the garage floor is soaked. Is there any way someone can come sooner? I have to leave at 2.',
  };

  // ---------------------------------------------------------------- formatting
  const pad = n => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtTime(ms) { const d = new Date(ms); let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; }
  function fmtHour(ms) { const d = new Date(ms); let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return d.getMinutes() ? `${h}:${pad(d.getMinutes())} ${ap}` : `${h} ${ap}`; }
  const fmtDay = ms => { const d = new Date(ms); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtDayLong = ms => { const d = new Date(ms); return `${DOW_LONG[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtStamp = ms => `${fmtDay(ms)} · ${fmtTime(ms)}`;
  const h24 = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const isoDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const usDay = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; };
  const dmyDay = ms => { const d = new Date(ms); return `${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}`; };
  const localKey = ms => `${isoDay(ms)}T${h24(ms)}`;
  const first = name => String(name || '').split(' ')[0];
  const initial = name => { const p = String(name || '').split(' '); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : name; };
  const emailFor = name => String(name).toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@example.com';
  // "1 to 3 PM", "9 AM to 12 PM": how a person says an appointment window.
  function spokenWindow(a, b) {
    const ap = ms => (new Date(ms).getHours() < 12 ? 'AM' : 'PM');
    const bare = ms => { const d = new Date(ms); const h = d.getHours() % 12 || 12; return d.getMinutes() ? `${h}:${pad(d.getMinutes())}` : String(h); };
    return ap(a) === ap(b) ? `${bare(a)} and ${bare(b)} ${ap(b)}` : `${bare(a)} ${ap(a)} and ${bare(b)} ${ap(b)}`;
  }
  const usWindow = (a, b) => `${usDay(a)}, ${fmtHour(a)}–${fmtHour(b)}`;
  function replySubject(subject) { const s = String(subject || '').trim(); return /^re:/i.test(s) ? s : 'Re: ' + s; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- time rules
  function inQuietHours(ms) { const h = new Date(ms).getHours(); return h >= QUIET.from || h < QUIET.to; }
  // The next 7:00 AM at or after ms.
  function nextMorning(ms) { const d = new Date(ms); if (d.getHours() >= QUIET.to) d.setDate(d.getDate() + 1); d.setHours(QUIET.to, 0, 0, 0); return +d; }
  // The next time it is hh:mm, strictly after ms.
  function nextAt(ms, h, m = 0) { const d = new Date(ms); d.setHours(h, m, 0, 0); if (+d <= ms) d.setDate(d.getDate() + 1); return +d; }
  function skipWeekend(d) { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d; }
  function addBusinessDays(ms, n) { const d = new Date(ms); for (let i = 0; i < n; i++) { d.setDate(d.getDate() + 1); skipWeekend(d); } return +d; }
  // Book the first 2-hour window that starts at least 2 hours from now, 8 AM to 5 PM on weekdays.
  function bookWindow(from) {
    const d = new Date(from + 2 * HOUR);
    if (d.getMinutes()) { d.setHours(d.getHours() + 1); }
    d.setMinutes(0, 0, 0);
    if (d.getHours() < 8) d.setHours(8);
    if (d.getHours() > 15) { d.setDate(d.getDate() + 1); d.setHours(8); }
    skipWeekend(d);
    return { start: +d, end: +d + 2 * HOUR };
  }

  // ---------------------------------------------------------------- the mailbox
  // Every thread the automation can see: email threads, helpdesk tickets and portal records.
  // Includes the awkward ones: a near-miss claim number and two tickets for one claim.
  function buildMailbox() {
    const c = id => byId(S.customers, id);
    const msg = (o) => Object.assign({ dir: 'in', unread: false, attachments: [] }, o);
    const th = {};
    // Bluepeak: email threads, claim # in the subject.
    const bp = (id, claim, cust, issue, when, item) => {
      const cu = c(cust);
      th[id] = { id, kind: 'email', vendorId: 'V2', claim, customerId: cust,
        subject: `Service Assignment: Claim ${claim} - ${issue}`,
        participants: [CHANNELS.V2.contact.email, OFFICE.email],
        messages: [msg({ id: `<${claim.toLowerCase()}.0@bluepeak-protection.example>`, by: 'vendor', name: 'Bluepeak Claims Desk', email: CHANNELS.V2.contact.email,
          to: OFFICE.email, at: when,
          body: `Summit Home Services,\n\nPlease accept the following service assignment.\n\nClaim: ${claim}\nContract holder: ${cu.name}\nProperty: ${cu.address}, ${cu.zip}\nPhone: ${cu.phone}\nItem: ${item}\nReported: ${issue}\n\nReply to this email with status updates and include the claim number.\n\nBluepeak Claims Desk` })] };
    };
    bp('th-bp2209184', 'BP2209184', 'C04', 'Furnace short cycling, shuts off after 2 min', at(-2, 9, 0), 'Gas furnace');
    // Near miss for SH-1049 (claim BP2209301): same homeowner, digits swapped. Never used automatically.
    bp('th-bp2209031', 'BP2209031', 'C09', 'Toilet running constantly', at(-1, 15, 52), 'Toilet');
    // Direct customer: thread saved by the intake automation (M1) when the email arrived.
    const brian = c('C02');
    th['th-1042'] = { id: 'th-1042', kind: 'email', vendorId: 'V0', claim: null, customerId: 'C02', jobId: 'SH-1042',
      subject: 'Water heater leaking from bottom', participants: [emailFor(brian.name), OFFICE.email],
      messages: [msg({ id: '<CAK7f2m1042@mail.example.com>', by: 'customer', name: brian.name, email: emailFor(brian.name), to: OFFICE.email, at: at(-1, 15, 0),
        body: `Hi, our water heater is leaking from the bottom and there's a puddle in the garage. Can someone come out? We're at ${brian.address}.\n\nThanks,\nBrian` })] };
    // Northstar: helpdesk tickets with a claim # field.
    const ns = (id, claim, cust, title, when, body, agent) => {
      th[id] = { id, kind: 'ticket', vendorId: 'V1', claim, customerId: cust, subject: title, ticketStatus: 'Open',
        participants: [CHANNELS.V1.contact.email],
        messages: [msg({ id: id + '-c1', by: 'vendor', name: agent, email: CHANNELS.V1.contact.email, at: when, body })] };
    };
    const al = c('C01');
    ns('#20931', 'NS-448213', 'C01', `Claim NS-448213 · HVAC · ${al.name}`, at(-1, 8, 0),
      `New dispatch for Summit Home Services.\nClaim NS-448213 · Contract holder ${al.name} · ${al.address}, ${al.zip} · ${al.phone}\nCentral AC blowing warm air, outdoor unit humming.\nFirst contact within 24 hours. Post status updates as public replies on this ticket.`, 'Janelle P. (Northstar Dispatch)');
    ns('#20977', 'NS-448290', 'C02', `Claim NS-448290 · Appliance · ${brian.name}`, at(-2, 10, 0),
      `New dispatch for Summit Home Services.\nClaim NS-448290 · Contract holder ${brian.name} · ${brian.address}, ${brian.zip}\nDryer takes 3 cycles to dry.\nPost status updates as public replies on this ticket.`, 'Janelle P. (Northstar Dispatch)');
    ns('#20984', 'NS-448290', 'C02', `Claim NS-448290 · Re-dispatch · ${brian.name}`, at(-1, 13, 25),
      `Opening per homeowner call: dryer still takes 3 cycles. Claim NS-448290. Please update.`, 'Omar T. (Northstar Customer Care)');
    // Harbor: portal record per claim.
    const ca = c('C03');
    th['HAC-77102'] = { id: 'HAC-77102', kind: 'portal', vendorId: 'V3', claim: 'HAC-77102', customerId: 'C03', subject: `HAC-77102 · Washer · ${ca.name}`,
      portalStatus: 'Assigned', participants: [CHANNELS.V3.contact.email],
      messages: [msg({ id: 'HAC-77102-n1', by: 'vendor', name: 'Harbor Appliance Care', email: CHANNELS.V3.contact.email, at: at(-2, 11, 0),
        body: `Assigned to Summit Home Services. Washer not draining, error code 5E. Customer ${ca.name}, ${ca.address}.` })] };
    return th;
  }

  // ---------------------------------------------------------------- state
  function createState(opts = {}) {
    const jobs = {};
    SAMPLES.forEach(s => {
      const j = byId(S.jobs, s.jobId);
      const cu = byId(S.customers, j.customerId);
      jobs[s.jobId] = {
        id: j.id, vendorId: j.vendorId, customerId: j.customerId, claim: j.claim, issue: j.issue, trade: j.trade,
        techId: s.tech || j.techId, durationHrs: j.durationHrs, customerName: cu.name, customerEmail: emailFor(cu.name),
        status: 'new', window: null, partEta: null, returnVisit: false, threadRef: s.threadRef ? Object.assign({}, s.threadRef) : null,
        lastEvent: null, history: [],
      };
    });
    const templates = {};
    Object.keys(TEMPLATES).forEach(k => { templates[k] = { approved: TEMPLATES[k].approvedAtStart, required: APPROVE_FIRST }; });
    return {
      v: 1, clock: opts.clock || START_CLOCK, shadow: opts.shadow !== false,
      jobs, threads: buildMailbox(), keys: {}, log: [], person: [], queue: [], templates,
      counters: { sent: 0, drafts: 0, dupes: 0, queued: 0, held: 0 }, seq: 0,
    };
  }
  const uid = (st, p) => `${p}${++st.seq}`;
  const sampleFor = id => SAMPLES.find(s => s.jobId === id);
  const channelOf = job => CHANNELS[job.vendorId];
  const techOf = job => byId(S.techs, job.techId) || { name: 'a Summit technician', initials: 'S', color: '#55605b' };

  // ---------------------------------------------------------------- right thread or no send
  const wordRe = s => new RegExp('(^|[^A-Za-z0-9])' + String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '($|[^A-Za-z0-9])', 'i');
  function mentionsClaim(t, claim) {
    if (t.kind !== 'email') return t.claim === claim;               // tickets and portal records have a claim field
    const re = wordRe(claim);
    return re.test(t.subject) || re.test((t.messages[0] || {}).body || '');
  }
  const fromVendor = (t, ch) => t.messages.some(m => m.dir === 'in' && String(m.email).toLowerCase().endsWith('@' + ch.domain));
  // How many characters differ (same length only): used to show a near miss to a person, never to send.
  const charDiff = (a, b) => (a.length !== b.length ? 99 : [...a].filter((c, i) => c !== b[i]).length);

  // Returns { status: 'matched' | 'none' | 'ambiguous' | 'mismatch', thread, candidates, closest, how }
  function matchThread(job, threads) {
    const ch = channelOf(job);
    const pool = Object.values(threads).filter(t => t.kind === ch.kind && t.vendorId === job.vendorId);
    if (job.threadRef) {
      const t = threads[job.threadRef.id];
      if (!t) return { status: 'none', candidates: [], how: `Saved thread ${job.threadRef.id} no longer exists` };
      if (job.threadRef.by === 'person') return { status: 'matched', thread: t, candidates: [t], how: `Thread chosen by a person (${t.id})` };
      const okClaim = !job.claim || mentionsClaim(t, job.claim);
      const okWho = ch.audience === 'homeowner' ? t.participants.includes(job.customerEmail) : fromVendor(t, ch);
      if (okClaim && okWho) return { status: 'matched', thread: t, candidates: [t], how: 'Saved thread ID from intake, customer address checked' };
      return { status: 'mismatch', thread: t, candidates: [t], how: `Saved thread ${t.id} does not match this ${okClaim ? 'customer' : 'claim #'}` };
    }
    if (!job.claim) return { status: 'none', candidates: [], how: 'No saved thread ID and no claim # to search by' };
    const candidates = pool.filter(t => mentionsClaim(t, job.claim) && (ch.audience === 'homeowner' || fromVendor(t, ch)));
    const how = `Searched ${ch.label.toLowerCase()}s for claim ${job.claim}`;
    if (candidates.length === 1) return { status: 'matched', thread: candidates[0], candidates, how: `${ch.matchBy}: exactly 1 match` };
    if (candidates.length > 1) return { status: 'ambiguous', candidates, how: `${how}: ${candidates.length} matches` };
    const closest = pool.filter(t => t.claim && charDiff(t.claim, job.claim) <= 2 && t.customerId === job.customerId);
    return { status: 'none', candidates: [], closest, how: `${how}: 0 matches` };
  }

  // ---------------------------------------------------------------- customer replied?
  // Anything from the customer or vendor that a person has not read yet pauses the automation.
  const unreadInbound = t => t.messages.filter(m => m.dir === 'in' && m.unread && !m.draft);

  // ---------------------------------------------------------------- never twice
  // One key per job + status + the detail that makes it a different update (the window, the ETA).
  function idemKey(jobId, type, payload) {
    const p = payload || {};
    const detail = p.window ? localKey(p.window.start) : p.partEta ? isoDay(p.partEta) : '';
    return [jobId, type, detail].filter(Boolean).join('|');
  }

  // ---------------------------------------------------------------- templates
  // Vendors want the claim # first and dates in their format. Homeowners want plain words.
  function render(job, type, payload, ch) {
    ch = ch || channelOf(job);
    const p = payload || {};
    const tech = techOf(job), t1 = first(tech.name);
    const w = p.window, claim = job.claim;
    const report = type === 'completed' ? [{ name: `${job.id}-completion-report.pdf`, size: '412 KB' }] : [];
    const sample = sampleFor(job.id) || {};
    const work = p.work || sample.work || 'Work completed.';
    const part = p.part || sample.part || 'a part';
    let body = '', summary = '';
    if (job.vendorId === 'V2') {                        // Bluepeak: email, US dates, claim # first
      const lines = {
        received: `Claim ${claim}: received and accepted by Summit Home Services (our job ${job.id}). We will contact the homeowner, ${job.customerName}, within ${byId(S.vendors, 'V2').firstCallHours} hours and post the appointment on this thread.`,
        scheduled: `Claim ${claim}: ${p.returnVisit ? 'return visit' : 'appointment'} set for ${w && usWindow(w.start, w.end)}. Technician: ${tech.name} (${job.trade}). The homeowner has been given the same window.`,
        en_route: `Claim ${claim}: technician ${tech.name} is on the way. ETA ${p.eta && fmtTime(p.eta)}.`,
        completed: `Claim ${claim}: completed ${p.doneAt && usDay(p.doneAt)} at ${p.doneAt && fmtTime(p.doneAt)}.\nWork done: ${work}\nCompletion report with photos attached. Invoice follows on Net 45 terms.`,
        waiting_parts: `Claim ${claim}: diagnosed, waiting on parts.\nPart: ${part}, ordered. ETA ${p.partEta && usDay(p.partEta)}.\nWe will book the return visit when it arrives and post it here.`,
        rescheduled: `Claim ${claim}: appointment moved to ${w && usWindow(w.start, w.end)} at the homeowner's request. Technician: ${tech.name}.`,
      };
      body = `${lines[type]}\n\nSummit Home Services dispatch · ${S.company.phone}\nAutomated update. Reply here and a person will read it.`;
      summary = lines[type].split('\n')[0];
    } else if (job.vendorId === 'V1') {                 // Northstar: helpdesk comment, key: value, ISO dates
      const st = { received: 'ACCEPTED', scheduled: 'SCHEDULED', en_route: 'TECH EN ROUTE', completed: 'COMPLETED', waiting_parts: 'WAITING ON PARTS', rescheduled: 'RESCHEDULED' }[type];
      const rows = [`Status: ${st}`, `Claim: ${claim}`];
      if (type === 'received') rows.push(`Job: ${job.id}`, `First contact: within ${byId(S.vendors, 'V1').firstCallHours} h`);
      if (w && (type === 'scheduled' || type === 'rescheduled')) rows.push(`Appt: ${isoDay(w.start)} ${h24(w.start)}–${h24(w.end)}`, `Tech: ${tech.name}`);
      if (type === 'scheduled' && p.returnVisit) rows.push('Visit: return visit, part arrived');
      if (type === 'rescheduled') rows.push('Reason: homeowner request');
      if (type === 'en_route') rows.push(`Tech: ${tech.name}`, `ETA: ${h24(p.eta)}`);
      if (type === 'completed') rows.push(`Completed: ${isoDay(p.doneAt)} ${h24(p.doneAt)}`, `Work: ${work}`, 'Report: attached');
      if (type === 'waiting_parts') rows.push(`Part: ${part}`, `Part ETA: ${isoDay(p.partEta)}`, 'Next: return visit booked on arrival');
      body = rows.join('\n');
      summary = rows.slice(0, 1).concat(rows.slice(2, 3)).join(' · ');
    } else if (job.vendorId === 'V3') {                 // Harbor: one-line portal note, DD-Mon-YYYY
      const lines = {
        received: `ACCEPTED · ${claim} · Summit job ${job.id} · first contact within ${byId(S.vendors, 'V3').firstCallHours} h`,
        scheduled: `${p.returnVisit ? 'RETURN VISIT' : 'SCHEDULED'} · ${claim} · ${w && dmyDay(w.start)} ${w && h24(w.start)}-${w && h24(w.end)} · Tech ${initial(tech.name)}`,
        en_route: `EN ROUTE · ${claim} · Tech ${initial(tech.name)} · ETA ${p.eta && h24(p.eta)}`,
        completed: `COMPLETED · ${claim} · ${p.doneAt && dmyDay(p.doneAt)} ${p.doneAt && h24(p.doneAt)} · ${work} · Report attached`,
        waiting_parts: `PARTS ORDERED · ${claim} · ${part} · ETA ${p.partEta && dmyDay(p.partEta)}`,
        rescheduled: `RESCHEDULED · ${claim} · ${w && dmyDay(w.start)} ${w && h24(w.start)}-${w && h24(w.end)} · Customer request`,
      };
      body = lines[type];
      summary = body;
    } else {                                            // Homeowner: plain, friendly, no jargon
      const n = first(job.customerName);
      const lines = {
        received: `Hi ${n}, thanks for getting in touch. We have your request about the ${job.issue.toLowerCase()} (job ${job.id}). Someone from our office will call you within ${byId(S.vendors, 'V0').firstCallHours} hours to set a time. If it's an emergency, call us at ${S.company.phone}.`,
        scheduled: `Hi ${n}, you're booked${p.returnVisit ? ' for the return visit' : ''}: ${tech.name} will come ${w && fmtDayLong(w.start)} between ${w && spokenWindow(w.start, w.end)}. ${t1} will text you when on the way.`,
        en_route: `Hi ${n}, ${t1} is on the way and should be with you around ${p.eta && fmtTime(p.eta)}.`,
        completed: `Hi ${n}, all done. ${work} Your report with photos is attached. Thanks for choosing Summit!`,
        waiting_parts: `Hi ${n}, ${t1} found the problem: the ${part.toLowerCase()} needs replacing. It's ordered and should arrive ${p.partEta && fmtDayLong(p.partEta)}. We'll book the return visit as soon as it's in.`,
        rescheduled: `Hi ${n}, as you asked, we've moved your appointment to ${w && fmtDayLong(w.start)} between ${w && spokenWindow(w.start, w.end)}. Same tech: ${tech.name}.`,
      };
      body = `${lines[type]}\n\nSummit Home Services · ${S.company.phone}\nJust reply to this email if anything changes.`;
      summary = lines[type];
    }
    return { body, summary, attachments: report };
  }

  // ---------------------------------------------------------------- posting
  // Builds the reply exactly as it would go out: same thread, Re: subject, In-Reply-To/References.
  function buildReply(st, thread, job, type, payload, rendered, opts) {
    const real = thread.messages.filter(m => !m.draft);
    const last = real[real.length - 1];
    const ch = channelOf(job);
    const m = {
      id: thread.kind === 'email' ? `<summit.${job.id.toLowerCase()}.${type}.${st.seq + 1}@summit-home.example>` : `${thread.id}-u${st.seq + 1}`,
      dir: 'out', by: 'auto', name: OFFICE.name, email: OFFICE.email, at: st.clock,
      to: thread.kind === 'email' ? (ch.audience === 'homeowner' ? job.customerEmail : ch.contact.email) : ch.system,
      body: rendered.body, attachments: rendered.attachments, type, key: opts.key, draft: !!opts.draft, note: opts.note || '',
    };
    if (thread.kind === 'email') {
      m.subject = replySubject(thread.subject);
      m.headers = { 'In-Reply-To': last ? last.id : '', References: real.map(x => x.id).join(' ') };
    }
    st.seq++;
    return m;
  }
  function post(st, thread, msg) {
    thread.messages.push(msg);
    if (!msg.draft && thread.kind === 'portal') thread.portalStatus = EVENTS[msg.type].status;
    if (!msg.draft && thread.kind === 'ticket') thread.ticketStatus = msg.type === 'completed' ? 'Solved' : 'Open';
  }

  // ---------------------------------------------------------------- log
  function log(st, e) {
    const entry = Object.assign({ id: uid(st, 'L'), at: st.clock, shadow: st.shadow }, e);
    st.log.unshift(entry);
    if (st.log.length > 300) st.log.length = 300;
    return entry;
  }

  // ---------------------------------------------------------------- the event itself
  // A status change in the jobs sheet. Moves the demo clock to when it would really happen.
  function canDo(job, type) { return (NEXT[job.status] || []).includes(type); }
  function makeEvent(st, job, type) {
    const p = {};
    if (type === 'received') st.clock += 4 * MIN;
    if (type === 'scheduled') {
      st.clock += 20 * MIN;
      let w = bookWindow(st.clock);
      if (job.status === 'waiting_parts' && job.partEta) {
        const d = new Date(Math.max(w.start, job.partEta)); d.setHours(Math.max(8, d.getHours()), 0, 0, 0);
        if (+d < w.start) d.setTime(w.start);
        w = { start: +d, end: +d + 2 * HOUR };
        p.returnVisit = true;
      }
      p.window = w;
    }
    if (type === 'rescheduled') {
      st.clock += 15 * MIN;
      const base = job.window || bookWindow(st.clock);
      const s = new Date(addBusinessDays(Math.max(base.start, st.clock), 1)); s.setHours(8, 0, 0, 0);
      p.window = { start: +s, end: +s + 2 * HOUR };
    }
    if (type === 'en_route') {
      const ws = job.window ? job.window.start : st.clock + 30 * MIN;
      st.clock = Math.max(st.clock + 5 * MIN, ws - 25 * MIN);
      p.eta = st.clock + 25 * MIN;
    }
    if (type === 'completed') {
      const ws = job.window ? job.window.start : st.clock;
      st.clock = Math.max(st.clock + 30 * MIN, ws + Math.round(job.durationHrs * 60) * MIN + 5 * MIN);
      p.doneAt = st.clock - 5 * MIN;
    }
    if (type === 'waiting_parts') {
      const ws = job.window ? job.window.start : st.clock;
      st.clock = Math.max(st.clock + 30 * MIN, ws + 55 * MIN);
      const eta = new Date(addBusinessDays(st.clock, 2)); eta.setHours(12, 0, 0, 0);
      p.partEta = +eta;
    }
    // The jobs sheet changes no matter what happens to the message.
    job.status = type;
    if (p.window) job.window = p.window;
    if (p.partEta) job.partEta = p.partEta;
    if (type === 'scheduled') job.returnVisit = !!p.returnVisit;
    const ev = { type, at: st.clock, payload: p, key: idemKey(job.id, type, p) };
    job.lastEvent = ev;
    job.history.push({ type, at: st.clock });
    return ev;
  }

  // ---------------------------------------------------------------- the pipeline
  // runEvent(state, jobId, type)            a new status change
  // runEvent(state, jobId, null, { event })  the same event again (a webhook retry, a double edit)
  // runEvent(state, jobId, null, { event, resume })  re-run a held event after a person acted
  function runEvent(st, jobId, type, opts = {}) {
    const job = st.jobs[jobId];
    if (!job) throw new Error('Unknown job ' + jobId);
    if (type === 'customer_replied') return customerReplied(st, jobId);
    let ev = opts.event;
    if (!ev) {
      if (!canDo(job, type)) return { outcome: 'invalid', jobId, steps: [], reason: `${job.id} can't go from ${job.status} to ${type}` };
      ev = makeEvent(st, job, type);
    }
    const ch = channelOf(job), tpl = TEMPLATES[job.vendorId];
    const steps = [];
    const step = (k, label, tone, detail) => steps.push({ k, label, tone, detail: detail || '' });
    const res = { jobId, event: ev, steps, outcome: null };
    const done = (outcome, extra) => Object.assign(res, { outcome }, extra || {});
    step('event', EVENTS[ev.type].status, 'info', `${job.id} → ${EVENTS[ev.type].status}`);

    // 1. Never twice.
    const prior = st.keys[ev.key];
    if (prior && !(opts.resume && prior.ref === opts.resume)) {
      const was = { sent: 'already sent', drafted: 'already drafted (shadow)', queued: 'already queued for the morning', held: 'already waiting for a person', handled: 'already handled by a person' }[prior.state] || 'already seen';
      step('dup', 'Duplicate', 'warn', `Key ${ev.key}: ${was}`);
      st.counters.dupes++;
      const e = log(st, { kind: 'skipped', jobId, key: ev.key, title: `${job.id}: ${EVENTS[ev.type].status} event repeated, ${was}, skipped`, detail: 'Nothing posted. The same status change arrived twice (a double edit or a retried webhook).', steps });
      return done('skipped', { logEntry: e });
    }
    step('dup', 'New', 'good', `Key ${ev.key}`);

    // 2. Right thread or no send.
    const m = matchThread(job, st.threads);
    if (m.status !== 'matched') {
      const label = { none: 'No thread', ambiguous: `${m.candidates.length} threads`, mismatch: 'Mismatch' }[m.status];
      step('thread', label, 'bad', m.how);
      const why = m.status === 'ambiguous'
        ? `${m.candidates.length} ${ch.label.toLowerCase()}s mention claim ${job.claim}. It won't guess which one the vendor is watching.`
        : m.status === 'mismatch' ? `${m.how}. It won't post on a thread that might belong to someone else.`
        : `No ${ch.label.toLowerCase()} matches claim ${job.claim || job.id}. It never starts a new thread, because the vendor would not be watching it.`;
      return hold(st, res, job, ev, m.status === 'ambiguous' ? 'ambiguous' : m.status === 'mismatch' ? 'mismatch' : 'no_thread', why,
        { candidates: m.candidates.map(t => t.id), closest: (m.closest || []).map(t => t.id), preview: render(job, ev.type, ev.payload, ch) });
    }
    const thread = m.thread;
    step('thread', 'Matched', 'good', `${m.how} (${thread.id})`);

    // 3. Customer replied? Don't post a cheery update on top of a question or a complaint.
    const unread = unreadInbound(thread);
    if (unread.length) {
      const u = unread[unread.length - 1];
      step('replied', 'Unread reply', 'bad', `${u.name} wrote at ${fmtTime(u.at)}, nobody has read it`);
      return hold(st, res, job, ev, 'customer_replied', `${u.name} wrote on this thread at ${fmtTime(u.at)} and nobody has read it yet. The automation pauses here until a person has.`,
        { thread: thread.id, reply: u.body, preview: render(job, ev.type, ev.payload, ch) });
    }
    step('replied', 'All read', 'good', 'No unread message from the customer or vendor');

    // 4. Template.
    const r = render(job, ev.type, ev.payload, ch);
    step('template', tpl.name, 'good', r.attachments.length ? `With ${r.attachments[0].name}` : '');

    // 5. Quiet hours (homeowners only; vendors are exempt).
    const quiet = ch.audience === 'homeowner' && inQuietHours(st.clock) && !opts.released;
    if (quiet) {
      const sendAt = nextMorning(st.clock);
      step('quiet', 'Quiet hours', 'warn', `${fmtTime(st.clock)} is between 8 PM and 7 AM. ${st.shadow ? 'Would wait' : 'Waits'} until ${fmtStamp(sendAt)}`);
      if (!st.shadow) {
        const q = { id: uid(st, 'Q'), jobId, event: ev, thread: thread.id, sendAt, queuedAt: st.clock, summary: r.summary };
        st.queue.push(q);
        st.keys[ev.key] = { state: 'queued', ref: q.id, at: st.clock };
        st.counters.queued++;
        const e = log(st, { kind: 'queued', jobId, key: ev.key, title: `${job.id}: ${EVENTS[ev.type].status} update queued for ${fmtTime(sendAt)} (quiet hours)`, detail: r.summary, steps });
        return done('queued', { queueItem: q, logEntry: e });
      }
    } else {
      step('quiet', ch.audience === 'homeowner' ? 'OK to send' : 'Vendor: exempt', 'good', ch.audience === 'homeowner' ? `${fmtTime(st.clock)} is outside 8 PM to 7 AM` : 'Vendors get updates around the clock');
    }

    // 6. Shadow mode: create a draft on the right thread and log what it would have sent.
    const t = st.templates[job.vendorId];
    const needsOk = t.approved < t.required;
    if (st.shadow) {
      const note = [quiet ? `Would wait until ${fmtTime(nextMorning(st.clock))} (quiet hours)` : '', needsOk ? `Would ask a person to approve (send ${t.approved + 1} of ${t.required})` : ''].filter(Boolean).join('. ');
      const msg = buildReply(st, thread, job, ev.type, ev.payload, r, { key: ev.key, draft: true, note });
      post(st, thread, msg);
      st.keys[ev.key] = { state: 'drafted', ref: msg.id, at: st.clock };
      st.counters.drafts++;
      step('mode', 'Shadow: draft', 'shadow', `Draft reply on ${thread.id}. Nothing sent.`);
      const e = log(st, { kind: 'drafted', jobId, key: ev.key, title: `WOULD ${ch.kind === 'email' ? 'reply on' : ch.kind === 'ticket' ? 'comment on ticket' : 'add a portal note to'} ${thread.id}: ${EVENTS[ev.type].status}`, detail: r.summary + (note ? ` (${note})` : ''), steps, thread: thread.id });
      return done('drafted', { message: msg, thread: thread.id, logEntry: e });
    }
    step('mode', 'Live', 'good', '');

    // 7. Approve the first 5 sends of a new template.
    if (needsOk) {
      step('approve', `Approval ${t.approved + 1} of ${t.required}`, 'warn', `New template "${tpl.name}": a person checks the first ${t.required} sends`);
      return hold(st, res, job, ev, 'approval', `"${tpl.name}" is a new template. A person approves its first ${t.required} live sends (this is ${t.approved + 1} of ${t.required}).`,
        { thread: thread.id, preview: r });
    }
    if (TEMPLATES[job.vendorId].isNew) step('approve', 'Trusted', 'good', `${t.approved} of ${t.required} approved`);

    // 8. Post it on the thread.
    const msg = buildReply(st, thread, job, ev.type, ev.payload, r, { key: ev.key });
    post(st, thread, msg);
    st.keys[ev.key] = { state: 'sent', ref: msg.id, at: st.clock };
    st.counters.sent++;
    step('post', 'Posted', 'good', `${ch.kind === 'email' ? 'Reply' : ch.kind === 'ticket' ? 'Public comment' : 'Portal note'} on ${thread.id}`);
    const e = log(st, { kind: 'sent', jobId, key: ev.key, title: `${job.id}: ${EVENTS[ev.type].status} update posted on ${thread.id}${opts.released ? ' (held overnight)' : ''}`, detail: r.summary, steps, thread: thread.id });
    return done('sent', { message: msg, thread: thread.id, logEntry: e });
  }

  function hold(st, res, job, ev, kind, why, ctx) {
    const titles = {
      no_thread: 'No matching thread', ambiguous: 'More than one possible thread', mismatch: 'Saved thread doesn\'t match',
      customer_replied: 'Customer wrote something new', approval: 'Approve a new template',
    };
    const item = Object.assign({ id: uid(st, 'P'), at: st.clock, jobId: job.id, kind, title: titles[kind], why, event: ev, status: 'open' }, ctx);
    st.person.unshift(item);
    st.keys[ev.key] = { state: 'held', ref: item.id, at: st.clock };
    st.counters.held++;
    res.steps.push({ k: 'person', label: 'Needs a person', tone: 'bad', detail: titles[kind] });
    const e = log(st, { kind: 'person', jobId: job.id, key: ev.key, title: `${job.id}: ${EVENTS[ev.type].status} update held for a person. ${titles[kind]}`, detail: why, steps: res.steps });
    return Object.assign(res, { outcome: 'held', personItem: item, logEntry: e });
  }

  // The customer (or vendor) writes on the thread. A person hasn't read it yet.
  function customerReplied(st, jobId) {
    const job = st.jobs[jobId], ch = channelOf(job);
    const m = matchThread(job, st.threads);
    if (m.status !== 'matched') {
      log(st, { kind: 'admin', jobId, title: `${job.id}: a reply came in on a thread the automation can't match, so it can't pause that thread`, detail: 'The office inbox shows it as normal.' });
      return { outcome: 'unmatched', jobId };
    }
    st.clock += 3 * MIN;
    const t = m.thread;
    const who = ch.audience === 'homeowner' ? { name: job.customerName, email: job.customerEmail, by: 'customer' }
      : { name: ch.kind === 'ticket' ? 'Janelle P. (Northstar Dispatch)' : ch.contact.name, email: ch.contact.email, by: 'vendor' };
    const msg = { id: t.kind === 'email' ? `<reply.${job.id.toLowerCase()}.${st.seq + 1}@${who.email.split('@')[1]}>` : `${t.id}-r${st.seq + 1}`, dir: 'in', by: who.by, name: who.name, email: who.email,
      to: OFFICE.email, at: st.clock, body: REPLIES[job.vendorId], unread: true, attachments: [] };
    if (t.kind === 'email') msg.subject = replySubject(t.subject);
    st.seq++;
    t.messages.push(msg);
    log(st, { kind: 'inbound', jobId, title: `${job.id}: ${who.name} replied on ${t.id}. Updates on this thread pause until a person reads it.`, detail: msg.body });
    return { outcome: 'replied', jobId, message: msg, thread: t.id };
  }

  // ---------------------------------------------------------------- the clock and the morning queue
  function setClock(st, ms) {
    st.clock = Math.max(st.clock, ms);
    const due = st.queue.filter(q => q.sendAt <= st.clock);
    st.queue = st.queue.filter(q => q.sendAt > st.clock);
    // Re-run each held update: the customer may have written overnight.
    return due.map(q => runEvent(st, q.jobId, null, { event: q.event, resume: q.id, released: true }));
  }
  const jumpToEvening = st => setClock(st, nextAt(st.clock, 20, 50));
  const jumpToMorning = st => setClock(st, nextMorning(st.clock));

  // ---------------------------------------------------------------- a person acts
  function resolve(st, personId, action, arg) {
    const item = st.person.find(p => p.id === personId);
    if (!item || item.status !== 'open') return null;
    const job = st.jobs[item.jobId];
    const close = (resolution) => { item.status = 'done'; item.resolution = resolution; item.resolvedAt = st.clock; };
    st.clock += MIN;
    if (action === 'approve' && item.kind === 'approval') {
      const thread = st.threads[item.thread];
      const msg = buildReply(st, thread, job, item.event.type, item.event.payload, item.preview, { key: item.event.key, note: 'Approved by a person' });
      post(st, thread, msg);
      st.templates[job.vendorId].approved++;
      st.keys[item.event.key] = { state: 'sent', ref: msg.id, at: st.clock };
      st.counters.sent++;
      close('Approved and posted');
      const t = st.templates[job.vendorId];
      log(st, { kind: 'sent', jobId: job.id, key: item.event.key, title: `${job.id}: approved by a person and posted on ${thread.id} (${t.approved} of ${t.required})`, detail: item.preview.summary, thread: thread.id });
      return { outcome: 'sent', jobId: job.id, event: item.event, steps: [], message: msg, thread: thread.id };
    }
    if (action === 'pick' && arg && st.threads[arg]) {
      job.threadRef = { id: arg, by: 'person' };
      close(`Person chose ${arg}`);
      log(st, { kind: 'admin', jobId: job.id, title: `${job.id}: a person chose ${arg} as the right thread. Future updates go there.` });
      return runEvent(st, job.id, null, { event: item.event, resume: item.id });
    }
    if (action === 'read_send' && item.kind === 'customer_replied') {
      const t = st.threads[item.thread];
      t.messages.forEach(m => { if (m.dir === 'in') m.unread = false; });
      close('Read by a person, update released');
      log(st, { kind: 'admin', jobId: job.id, title: `${job.id}: a person read the reply on ${t.id} and released the held update` });
      return runEvent(st, job.id, null, { event: item.event, resume: item.id });
    }
    if (action === 'read_skip' && item.kind === 'customer_replied') {
      const t = st.threads[item.thread];
      t.messages.forEach(m => { if (m.dir === 'in') m.unread = false; });
    }
    // reject / read_skip / dismiss: a person handles it by hand; the key stays so it never sends later.
    st.keys[item.event.key] = { state: 'handled', ref: item.id, at: st.clock };
    const label = { reject: 'Rejected, not sent', read_skip: 'Read by a person, handled by hand', dismiss: 'Handled by hand' }[action] || 'Handled by hand';
    close(label);
    log(st, { kind: 'admin', jobId: job.id, title: `${job.id}: ${label.toLowerCase()} (${EVENTS[item.event.type].status} update)` });
    return { outcome: 'handled', jobId: job.id, event: item.event, steps: [] };
  }

  // Re-fire the job's last event exactly as it was (what a duplicate webhook looks like).
  function repeatLast(st, jobId) {
    const job = st.jobs[jobId];
    if (!job.lastEvent) return null;
    return runEvent(st, jobId, null, { event: job.lastEvent });
  }

  // Put one job back to "new", with its original thread. Keys for it are cleared too.
  function resetJob(st, jobId) {
    const fresh = createState({ clock: st.clock });
    st.jobs[jobId] = fresh.jobs[jobId];
    Object.values(fresh.threads).forEach(t => {
      const rel = (t.jobId === jobId) || (t.claim && t.claim === fresh.jobs[jobId].claim) || (t.vendorId === fresh.jobs[jobId].vendorId && t.customerId === fresh.jobs[jobId].customerId);
      if (rel) st.threads[t.id] = t;
    });
    Object.keys(st.keys).forEach(k => { if (k.split('|')[0] === jobId) delete st.keys[k]; });
    st.queue = st.queue.filter(q => q.jobId !== jobId);
    st.person.forEach(p => { if (p.jobId === jobId && p.status === 'open') { p.status = 'done'; p.resolution = 'Job reset in the demo'; } });
    log(st, { kind: 'admin', jobId, title: `${jobId}: reset to a new job (demo)` });
  }

  // ---------------------------------------------------------------- read helpers for the UI
  const openPerson = st => st.person.filter(p => p.status === 'open');
  function counts(st) {
    return { sent: st.counters.sent, drafts: st.counters.drafts, held: openPerson(st).length, dupes: st.counters.dupes, queued: st.queue.length };
  }
  function threadFor(st, jobId) {
    const job = st.jobs[jobId];
    const m = matchThread(job, st.threads);
    return m;
  }

  // ---------------------------------------------------------------- the before/after story
  // One real-feeling job, told twice. Built with the same templates the simulator uses.
  function story() {
    const job = byId(S.jobs, 'SH-1056');
    const cu = byId(S.customers, job.customerId);
    const tech = byId(S.techs, job.techId);
    const v = { id: job.id, vendorId: 'V2', customerId: cu.id, claim: job.claim, issue: job.issue, trade: job.trade, techId: job.techId,
      durationHrs: job.durationHrs, customerName: cu.name, customerEmail: emailFor(cu.name) };
    const subject = `Service Assignment: Claim ${job.claim} - ${job.issue}`;
    const bpEmail = CHANNELS.V2.contact.email;
    const original = { by: 'vendor', name: 'Bluepeak Claims Desk', email: bpEmail, at: at(-5, 8, 2), attachments: [],
      body: `Summit Home Services,\n\nPlease accept the following service assignment.\n\nClaim: ${job.claim}\nContract holder: ${cu.name}\nProperty: ${cu.address}, ${cu.zip}\nPhone: ${cu.phone}\nItem: Central AC condenser\nReported: ${job.issue}\n\nReply to this email with status updates and include the claim number.\n\nBluepeak Claims Desk` };
    const w1 = { start: at(-3, 14), end: at(-3, 16) }, w2 = { start: at(0, 8), end: at(0, 10) };
    const before = [
      original,
      { by: 'vendor', name: 'Renee Calder, Bluepeak', email: 'renee.calder@bluepeak-protection.example', at: at(-5, 16, 40), chase: true,
        body: `Following up: can you confirm you received claim ${job.claim}? The homeowner has called us twice today.` },
      { by: 'office', name: 'Summit Office', email: 'office@summit-home.example', at: at(-4, 10, 15), late: true,
        body: 'Got it, we will get someone out.' },
      { by: 'vendor', name: 'Renee Calder, Bluepeak', email: 'renee.calder@bluepeak-protection.example', at: at(-4, 15, 30), chase: true,
        body: 'Any update? We need an appointment date in the portal within 48 hours of assignment.' },
      { by: 'office', name: 'Summit Office', email: 'office@summit-home.example', at: at(-3, 9, 5),
        body: 'Scheduled for today 2-4.' },
      { by: 'customer', name: cu.name, email: emailFor(cu.name), at: at(-3, 14, 40), chase: true, newThread: 'Where is the technician??',
        body: 'Your tech was supposed to be here at 2. Nobody has called. I took the afternoon off work for this.' },
      { by: 'office', name: 'Summit Office', email: 'office@summit-home.example', at: at(-3, 15, 5), newThread: 'Re: Where is the technician??',
        body: `Sorry Paul, ${first(tech.name)} is running behind, should be there by 3:30.` },
      { by: 'vendor', name: 'Renee Calder, Bluepeak', email: 'renee.calder@bluepeak-protection.example', at: at(-2, 11, 0), chase: true,
        body: `The homeowner says the tech came but the AC still doesn't work. What is the status? The portal still shows "Assigned".` },
      { by: 'office', name: 'Summit Office', email: 'office@summit-home.example', at: at(-2, 16, 45),
        body: 'Waiting on a part.' },
      { by: 'office', name: 'Summit Office', email: 'office@summit-home.example', at: at(-1, 14, 10),
        body: 'Part should be in tomorrow, we will call the homeowner.' },
    ];
    const ev = (type, when, payload) => Object.assign({ type, at: when, by: 'auto', name: OFFICE.name, email: OFFICE.email }, render(v, type, payload, CHANNELS.V2));
    const after = [
      Object.assign({}, original),
      ev('received', at(-5, 8, 6), {}),
      ev('scheduled', at(-5, 9, 10), { window: w1 }),
      ev('en_route', at(-3, 13, 40), { eta: at(-3, 14, 5) }),
      ev('waiting_parts', at(-3, 15, 10), { partEta: at(-1, 12), part: 'Condenser fan motor 1/4 HP' }),
      ev('scheduled', at(-1, 13, 30), { window: w2, returnVisit: true }),
      ev('en_route', at(0, 7, 35), { eta: at(0, 8, 0) }),
      ev('completed', at(0, 9, 40), { doneAt: at(0, 9, 35), work: 'Replaced the seized condenser fan motor and the run capacitor. System cooling, supply air 55°F.' }),
    ];
    return {
      job: v, subject, replySubject: replySubject(subject), tech, customer: cu, before, after,
      // Illustrative numbers for the demo, counted from the two threads above.
      metrics: [
        { k: 'Follow-up emails', before: before.filter(m => m.chase).length, after: 0, unit: '' },
        { k: 'Office replies typed', before: before.filter(m => m.by === 'office').length, after: 0, unit: '' },
        { k: 'Time to first acknowledgement', beforeText: '26 h', afterText: '4 min' },
        { k: 'Threads for one job', before: 2, after: 1, unit: '' },
      ],
    };
  }

  const Threads = {
    MIN, HOUR, DAY, START_CLOCK, QUIET, APPROVE_FIRST, OFFICE, CHANNELS, TEMPLATES, EVENTS, LIFECYCLE, NEXT, SAMPLES, REPLIES,
    at, createState, buildMailbox, matchThread, unreadInbound, idemKey, render, replySubject, inQuietHours, nextMorning, nextAt,
    bookWindow, canDo, runEvent, repeatLast, customerReplied, resolve, setClock, jumpToEvening, jumpToMorning, resetJob,
    openPerson, counts, threadFor, story, channelOf, techOf,
    fmtTime, fmtDay, fmtDayLong, fmtStamp, isoDay, usDay, dmyDay, h24, esc, first, emailFor,
  };
  root.Threads = Threads;
  if (typeof module !== 'undefined' && module.exports) module.exports = Threads;
})(typeof window !== 'undefined' ? window : globalThis);
