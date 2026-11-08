// Node tests for the M3 engine. Run from the project folder:  node tests/engine.test.js
// No test framework needed. Exits with code 1 on the first failure.
'use strict';
global.window = global;
require('../shared/data.js');
const T = require('../engine.js');

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('  FAIL -', msg); process.exit(1); }
  passed++; console.log('  ok -', msg);
}
const fresh = (o = {}) => T.createState(Object.assign({ shadow: false }, o));
const section = s => console.log('\n' + s);

section('Right thread or no send');
{
  const st = fresh();
  const m = T.matchThread(st.jobs['SH-1044'], st.threads);
  ok(m.status === 'matched' && m.thread.id === 'th-bp2209184', 'Bluepeak claim # in subject matches exactly one email thread');
  ok(T.matchThread(st.jobs['SH-1041'], st.threads).thread.id === '#20931', 'Northstar claim # field matches one helpdesk ticket');
  ok(T.matchThread(st.jobs['SH-1043'], st.threads).thread.id === 'HAC-77102', 'Harbor claim # matches its portal record');
  const d = T.matchThread(st.jobs['SH-1042'], st.threads);
  ok(d.status === 'matched' && /intake/.test(d.how), 'direct customer matched by the thread ID saved at intake');

  const none = T.matchThread(st.jobs['SH-1049'], st.threads);
  ok(none.status === 'none' && none.candidates.length === 0, 'BP2209301 has no thread');
  ok(none.closest.length === 1 && none.closest[0].id === 'th-bp2209031', 'the near-miss BP2209031 is shown as closest, not used');
  const amb = T.matchThread(st.jobs['SH-1061'], st.threads);
  ok(amb.status === 'ambiguous' && amb.candidates.length === 2, 'two tickets for NS-448290 is ambiguous');

  const r1 = T.runEvent(st, 'SH-1049', 'received');
  ok(r1.outcome === 'held' && r1.personItem.kind === 'no_thread', 'no thread → Needs a person');
  const r2 = T.runEvent(st, 'SH-1061', 'received');
  ok(r2.outcome === 'held' && r2.personItem.kind === 'ambiguous' && r2.personItem.candidates.length === 2, 'ambiguous → Needs a person with both candidates');
  const before = Object.keys(st.threads).length;
  ok(Object.values(st.threads).every(t => !t.messages.some(m => m.by === 'auto')), 'nothing posted anywhere when the thread is unclear');
  ok(Object.keys(st.threads).length === before, 'no new thread was started');

  // A person picks the right ticket: the held update goes there, and later ones follow.
  const after = T.resolve(st, r2.personItem.id, 'pick', '#20977');
  ok(after.outcome === 'sent' && after.thread === '#20977', 'after a person picks #20977, the held update posts there');
  ok(T.runEvent(st, 'SH-1061', 'scheduled').thread === '#20977', 'the next update goes to the same ticket');
  ok(!st.threads['#20984'].messages.some(m => m.by === 'auto'), 'the other ticket is untouched');

  // A saved thread that doesn't match the customer is refused.
  const st2 = fresh();
  st2.jobs['SH-1042'].customerEmail = 'someone.else@example.com';
  ok(T.matchThread(st2.jobs['SH-1042'], st2.threads).status === 'mismatch', 'saved thread with a different customer address → mismatch');
  ok(T.runEvent(st2, 'SH-1042', 'received').personItem.kind === 'mismatch', 'mismatch → Needs a person');
}

section('Replies land on the original thread');
{
  const st = fresh();
  const r = T.runEvent(st, 'SH-1044', 'received');
  const t = st.threads['th-bp2209184'];
  ok(t.messages.length === 2 && t.messages[1] === r.message, 'reply appended to the same thread');
  ok(r.message.subject === 'Re: ' + t.subject, 'subject is "Re: " + the original subject');
  ok(T.replySubject('Re: Hello') === 'Re: Hello', 'never "Re: Re:"');
  ok(r.message.headers['In-Reply-To'] === t.messages[0].id && r.message.headers.References.includes(t.messages[0].id), 'In-Reply-To and References point at the original message');
  ok(/^Claim BP2209184:/.test(r.message.body), 'Bluepeak update starts with the claim #');
  const s = T.runEvent(st, 'SH-1044', 'scheduled');
  ok(/\d\d\/\d\d\/\d{4}/.test(s.message.body) && /Priya Nair/.test(s.message.body), 'Bluepeak: US date format and tech name');
  const n = T.runEvent(st, 'SH-1041', 'received'); T.runEvent(st, 'SH-1041', 'scheduled');
  const nt = st.threads['#20931'].messages.slice(-1)[0].body;
  ok(/Appt: \d{4}-\d\d-\d\d \d\d:\d\d–\d\d:\d\d/.test(nt) && /Claim: NS-448213/.test(nt), 'Northstar: ISO date and claim field');
  ok(n.message.headers === undefined, 'helpdesk comments carry no email headers');
  const h = T.runEvent(st, 'SH-1042', 'received');
  ok(/^Hi Brian,/.test(h.message.body) && !/claim/i.test(h.message.body), 'homeowner: friendly, first name, no claim jargon');
  T.runEvent(st, 'SH-1044', 'en_route');
  const c = T.runEvent(st, 'SH-1044', 'completed');
  ok(c.message.attachments.length === 1 && /completion-report\.pdf$/.test(c.message.attachments[0].name), 'completed update attaches the report');
}

section('Never twice');
{
  const st = fresh();
  T.runEvent(st, 'SH-1044', 'received');
  const n = st.threads['th-bp2209184'].messages.length;
  const d = T.repeatLast(st, 'SH-1044');
  ok(d.outcome === 'skipped' && /already sent/.test(d.logEntry.title), 'repeat event → "already sent, skipped"');
  ok(st.threads['th-bp2209184'].messages.length === n, 'nothing new on the thread');
  ok(st.counters.dupes === 1, 'duplicate counter goes up');
  ok(T.idemKey('SH-1', 'scheduled', { window: { start: T.at(1, 8) } }) !== T.idemKey('SH-1', 'scheduled', { window: { start: T.at(2, 8) } }), 'a new appointment window is a new key');
  ok(T.runEvent(st, 'SH-1044', 'completed').outcome === 'invalid', 'an impossible status jump is refused');
  const p = T.runEvent(st, 'SH-1049', 'received');
  ok(T.repeatLast(st, 'SH-1049').outcome === 'skipped', 'repeat of an event waiting for a person is skipped too');
  ok(T.openPerson(st).filter(x => x.jobId === 'SH-1049').length === 1 && p.personItem, 'still only one Needs a person item');
}

section('Quiet hours (homeowners only)');
{
  ok(T.inQuietHours(T.at(0, 20, 0)) && T.inQuietHours(T.at(0, 6, 59)) && !T.inQuietHours(T.at(0, 7, 0)) && !T.inQuietHours(T.at(0, 19, 59)), '8 PM to 7 AM is quiet');
  ok(T.nextMorning(T.at(0, 21)) === T.at(1, 7) && T.nextMorning(T.at(0, 3)) === T.at(0, 7), 'next 7 AM is worked out from evening and from early morning');
  const st = fresh({ clock: T.at(0, 20, 40) });
  const q = T.runEvent(st, 'SH-1042', 'received');
  ok(q.outcome === 'queued' && q.queueItem.sendAt === T.at(1, 7), 'homeowner update at 8:44 PM is queued for 7:00 AM');
  ok(!st.threads['th-1042'].messages.some(m => m.by === 'auto'), 'nothing sent overnight');
  ok(T.repeatLast(st, 'SH-1042').outcome === 'skipped', 'a repeat while queued is skipped');
  const v = T.runEvent(st, 'SH-1044', 'received');
  ok(v.outcome === 'sent', 'vendor update at night is sent (vendors are exempt)');
  const out = T.jumpToMorning(st);
  ok(out.length === 1 && out[0].outcome === 'sent' && st.queue.length === 0, 'at 7:00 AM the queued update is sent');
  ok(new Date(out[0].message.at).getHours() === 7, 'and it is stamped 7:00 AM');

  const st2 = fresh({ clock: T.at(0, 20, 40) });
  T.runEvent(st2, 'SH-1042', 'received');
  T.customerReplied(st2, 'SH-1042');
  const out2 = T.jumpToMorning(st2);
  ok(out2[0].outcome === 'held' && out2[0].personItem.kind === 'customer_replied', 'if the customer wrote overnight, the morning send pauses for a person');
}

section('Customer replied? Pause and flag a person');
{
  const st = fresh();
  T.runEvent(st, 'SH-1042', 'received');
  const rep = T.customerReplied(st, 'SH-1042');
  ok(rep.message.unread && rep.message.dir === 'in', 'reply arrives unread');
  const n = st.threads['th-1042'].messages.length;
  const r = T.runEvent(st, 'SH-1042', 'scheduled');
  ok(r.outcome === 'held' && r.personItem.kind === 'customer_replied' && /leak is worse/.test(r.personItem.reply), 'next update is held, with the customer\'s words');
  ok(st.threads['th-1042'].messages.length === n, 'no cheery update posted on top of the reply');
  const res = T.resolve(st, r.personItem.id, 'read_send');
  ok(res.outcome === 'sent' && !T.unreadInbound(st.threads['th-1042']).length, 'after a person reads it, the held update is sent');

  const st2 = fresh();
  T.runEvent(st2, 'SH-1044', 'received'); T.customerReplied(st2, 'SH-1044');
  const r2 = T.runEvent(st2, 'SH-1044', 'scheduled');
  T.resolve(st2, r2.personItem.id, 'read_skip');
  ok(st2.keys[r2.event.key].state === 'handled' && T.repeatLast(st2, 'SH-1044').outcome === 'skipped', '"handled by hand" means it never sends later');
}

section('Approve the first 5 of a new template');
{
  const st = fresh();
  ok(st.templates.V3.approved === 2 && st.templates.V3.required === 5, 'Harbor portal template starts at 2 of 5');
  const r = T.runEvent(st, 'SH-1043', 'received');
  ok(r.outcome === 'held' && r.personItem.kind === 'approval', 'send 3 of 5 waits for approval');
  ok(!st.threads['HAC-77102'].messages.some(m => m.by === 'auto'), 'nothing on the portal yet');
  T.resolve(st, r.personItem.id, 'approve');
  ok(st.templates.V3.approved === 3 && st.threads['HAC-77102'].messages.slice(-1)[0].by === 'auto', 'approved → posted, 3 of 5');
  const r4 = T.runEvent(st, 'SH-1043', 'scheduled'); T.resolve(st, r4.personItem.id, 'approve');
  const r5 = T.runEvent(st, 'SH-1043', 'en_route'); T.resolve(st, r5.personItem.id, 'approve');
  ok(st.templates.V3.approved === 5, '5 of 5 approved');
  ok(T.runEvent(st, 'SH-1043', 'completed').outcome === 'sent', 'the 6th send goes out on its own');
  ok(st.threads['HAC-77102'].portalStatus === 'Completed', 'portal status follows the note');
  const rj = fresh(); const x = T.runEvent(rj, 'SH-1043', 'received'); T.resolve(rj, x.personItem.id, 'reject');
  ok(rj.templates.V3.approved === 2 && rj.keys[x.event.key].state === 'handled', 'a rejected send does not count and never goes out');
  ok(T.runEvent(fresh(), 'SH-1044', 'received').outcome === 'sent', 'established templates send without approval');
}

section('Shadow mode');
{
  const st = T.createState();
  ok(st.shadow === true, 'shadow mode is on by default');
  const r = T.runEvent(st, 'SH-1044', 'received');
  ok(r.outcome === 'drafted' && r.message.draft && /^WOULD/.test(r.logEntry.title), 'creates a draft and a "WOULD" log entry');
  ok(st.counters.sent === 0 && st.counters.drafts === 1, 'nothing counted as sent');
  const a = T.runEvent(st, 'SH-1043', 'received');
  ok(a.outcome === 'drafted' && /approve/.test(a.message.note), 'shadow notes it would ask for approval');
  const st2 = T.createState({ clock: T.at(0, 21) });
  const q = T.runEvent(st2, 'SH-1042', 'received');
  ok(q.outcome === 'drafted' && /quiet hours/.test(q.message.note) && st2.queue.length === 0, 'shadow notes it would wait for quiet hours');
  ok(T.runEvent(st, 'SH-1049', 'received').outcome === 'held', 'unmatched threads still go to a person in shadow mode');
}

section('Activity log and reset');
{
  const st = fresh();
  T.runEvent(st, 'SH-1044', 'received'); T.runEvent(st, 'SH-1044', 'scheduled');
  ok(st.log[0].at >= st.log[1].at && /Scheduled/.test(st.log[0].title), 'log is newest first');
  ok(JSON.parse(JSON.stringify(st)).log.length === st.log.length, 'state is plain JSON (safe for localStorage)');
  T.resetJob(st, 'SH-1044');
  ok(st.jobs['SH-1044'].status === 'new' && st.threads['th-bp2209184'].messages.length === 1 && !Object.keys(st.keys).some(k => k.startsWith('SH-1044')), 'reset puts the job and its thread back');
}

section('Before / after story');
{
  const s = T.story();
  ok(s.metrics[0].before === 4 && s.metrics[1].before === 5, 'before: 4 follow-ups, 5 typed replies');
  ok(s.after.slice(1).every(m => m.body.startsWith('Claim BP2208890')), 'after: every update carries the claim #');
  ok(s.after.some(m => m.attachments.length), 'after: completion report attached');
  ok(s.after[1].at - s.after[0].at === 4 * T.MIN, 'after: first acknowledgement 4 minutes after the work order');
}

console.log(`\n${passed} passed`);
