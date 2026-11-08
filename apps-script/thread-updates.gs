/**
 * Summit Home Services: status updates on the original thread (Google Apps Script)
 * --------------------------------------------------------------------------------
 * What it does, every 5 minutes:
 *   1. Reads the "Jobs" sheet and finds rows whose Status changed since the last update
 *      (Status + window/ETA is different from "Last Notified Key").
 *   2. Finds the customer's or vendor's ORIGINAL thread: the saved Thread ID, or a Gmail
 *      search by claim # from the vendor's domain. Helpdesk tickets are found by claim #.
 *   3. Posts a short update as a reply on that thread (thread.reply / createDraftReply),
 *      or as a public comment on the helpdesk ticket, and writes a row to "Update Log".
 *
 * Safety rules it follows:
 *   - Shadow mode (SHADOW_MODE=true, the default): replies are created as Gmail DRAFTS on
 *     the right thread and logged "would send". Nothing goes out.
 *   - Right thread or no send: exactly one matching thread, or it emails a person. It never
 *     starts a new thread and never guesses between two.
 *   - Never twice: one key per job + status + window/ETA. A key in the Update Log is skipped.
 *   - Quiet hours: no homeowner emails 8 PM to 7 AM. The row simply waits for the first run
 *     after 7 AM. Vendors are exempt.
 *   - Customer replied: if the last message on the thread is from them and still unread,
 *     it pauses that thread and emails a person instead of posting on top.
 *   - Approve the first 5: vendors listed in NEW_TEMPLATES get a draft + an email to a person
 *     until 5 sends have been approved (tick "Approved" on the row after sending the draft).
 *   - Any error on a row is caught, logged and emailed to a person. Other rows carry on.
 *
 * Setup (about 15 minutes):
 *   1. Open the Google Sheet with "Jobs" and "Update Log" → Extensions → Apps Script. Paste this file.
 *   2. Project Settings → Script properties:
 *        SHADOW_MODE      true            (switch to false after a week of checking drafts)
 *        ALERT_TO         office@example.com
 *        TIMEZONE         America/Denver  (optional)
 *        NEW_TEMPLATES    Harbor Appliance Care   (comma-separated vendor names; optional)
 *        HELPDESK_URL     https://yourdesk.example/api/v2     (optional, for ticket vendors)
 *        HELPDESK_TOKEN   (only if you use HELPDESK_URL; kept in Script properties, never in code)
 *   3. Run installTrigger() once and approve the permissions.
 *
 * Sheet layouts (row 1 = headers, names must match; extra columns are ignored):
 *   Jobs:        Job ID | Customer | Customer Email | Vendor | Claim # | Status | Tech | Window Start |
 *                Window End | ETA | Part | Part ETA | Work Done | Report File ID | Thread ID |
 *                Last Notified Key | Approved | Ticket Seen (helpdesk only: ID of the last vendor comment a person read)
 *                Status is one of: received, scheduled, en_route, completed, waiting_parts, rescheduled
 *   Update Log:  Timestamp | Job ID | Status | Key | Result | Thread | Note
 *                Result is one of: sent, drafted, skipped, queued, person, error
 *
 * No secrets live in this file. Addresses below are example placeholders.
 */

// ---------- Settings ----------
var SHEETS = { jobs: 'Jobs', log: 'Update Log' };
var QUIET_FROM = 20, QUIET_TO = 7;            // 8 PM to 7 AM, homeowners only
var APPROVE_FIRST = 5;
var OFFICE_NAME = 'Summit Home Services';
var OFFICE_PHONE = '(555) 010-4400';

// How each sender wants to hear back. 'audience' decides quiet hours and wording.
var VENDORS = {
  'Bluepeak Protection Plans': { channel: 'email',  audience: 'vendor', domain: 'bluepeak-protection.example', style: 'bluepeak' },
  'Northstar Home Warranty':   { channel: 'ticket', audience: 'vendor', domain: 'northstar-warranty.example',  style: 'northstar' },
  'Harbor Appliance Care':     { channel: 'email',  audience: 'vendor', domain: 'harbor-appliance.example',    style: 'harbor' },
  'Direct customer':           { channel: 'email',  audience: 'homeowner', style: 'homeowner' }
};

// ---------- Entry points ----------

/** Run once: checks for changed jobs every 5 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollJobs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollJobs').timeBased().everyMinutes(5).create();
}

/** Time-driven trigger target. One lock, so two runs never post the same update. */
function pollJobs() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;                 // another run is still going; it will catch up
  try {
    var cfg = config_();
    var jobs = sheet_(SHEETS.jobs);
    var done = sentKeys_();
    var rows = jobs.getDataRange().getValues();
    var head = rows[0];
    for (var r = 1; r < rows.length; r++) {
      var job = toObject_(head, rows[r]);
      if (!job['Job ID'] || !job.Status) continue;
      try {
        processJob_(cfg, job, r + 1, head, done);
      } catch (err) {
        log_(job, '', 'error', '', String(err && err.message || err));
        failToPerson_(cfg, 'Status update failed for ' + job['Job ID'], err, job);
      }
    }
  } catch (err) {
    failToPerson_(config_(), 'Thread updates: the whole run failed', err, null);
  } finally {
    lock.releaseLock();
  }
}

// ---------- The pipeline for one job ----------

function processJob_(cfg, job, rowNum, head, done) {
  var status = String(job.Status).trim();
  var key = idemKey_(job);
  var vendor = VENDORS[job.Vendor] || VENDORS['Direct customer'];

  // Already handled this exact update? Nothing to do (this is the normal case).
  if (String(job['Last Notified Key']) === key) return;

  // 1. Approval of a held draft: a person sent it from Gmail and ticked "Approved".
  if (done[key] === 'person' && job.Approved === true) {
    bumpApproved_(job.Vendor);
    setCell_(rowNum, head, 'Last Notified Key', key);
    setCell_(rowNum, head, 'Approved', false);
    log_(job, status, 'sent', key, 'Approved and sent by a person');
    return;
  }

  if (done[key] === 'person') return;              // still waiting for a person; never retried by itself

  // 2. Never twice: the key may be in the log even if the sheet column was not saved.
  if (done[key] && done[key] !== 'queued') {
    setCell_(rowNum, head, 'Last Notified Key', key);
    log_(job, status, 'skipped', key, 'Already ' + done[key] + ', skipped');
    return;
  }

  // 3. Quiet hours for homeowners: wait for the first run after 7 AM.
  if (vendor.audience === 'homeowner' && inQuietHours_(cfg.tz)) {
    if (!done[key]) { log_(job, status, 'queued', key, 'Quiet hours: waits until 7:00 AM'); done[key] = 'queued'; }
    return;
  }

  var text = render_(vendor.style, status, job, cfg.tz);

  // 4. Right thread or no send.
  if (vendor.channel === 'ticket') return postTicket_(cfg, job, vendor, status, key, text, rowNum, head, done);
  var found = findThread_(job, vendor);
  if (found.threads.length !== 1) {
    var why = found.threads.length ? found.threads.length + ' threads match ' + found.query + '. It will not guess.'
                                   : 'No thread matches ' + found.query + '. It never starts a new thread.';
    return toPerson_(cfg, job, status, key, why, text, done);
  }
  var thread = found.threads[0];
  if (!job['Thread ID']) setCell_(rowNum, head, 'Thread ID', thread.getId());

  // 5. Customer replied? Pause if their latest message is unread.
  var msgs = thread.getMessages();
  var lastMsg = msgs[msgs.length - 1];
  var fromUs = String(lastMsg.getFrom()).toLowerCase().indexOf(Session.getEffectiveUser().getEmail().toLowerCase()) >= 0;
  if (!fromUs && lastMsg.isUnread()) {
    return toPerson_(cfg, job, status, key, lastMsg.getFrom() + ' wrote on ' + lastMsg.getDate() +
      ' and nobody has read it. Updates on this thread are paused.\n\nThey wrote:\n' + lastMsg.getPlainBody().slice(0, 1500), text, done);
  }

  var options = { name: OFFICE_NAME };
  var att = reportAttachment_(job, status);
  if (att) options.attachments = [att];

  // 6. Shadow mode: a draft on the right thread, nothing sent.
  if (cfg.shadow) {
    thread.createDraftReply(text, options);
    setCell_(rowNum, head, 'Last Notified Key', key);
    log_(job, status, 'drafted', key, 'SHADOW: would reply on thread ' + thread.getId(), thread.getId());
    return;
  }

  // 7. Approve the first 5 sends of a new template.
  if (needsApproval_(cfg, job.Vendor)) {
    thread.createDraftReply(text, options);
    return toPerson_(cfg, job, status, key, 'New template for ' + job.Vendor + ': the first ' + APPROVE_FIRST +
      ' sends need a person. A draft is waiting on the thread. Send it from Gmail, then tick "Approved" on the row.', text, done);
  }

  // 8. Reply on the original thread. thread.reply keeps the subject and In-Reply-To headers.
  thread.reply(text, options);
  setCell_(rowNum, head, 'Last Notified Key', key);
  log_(job, status, 'sent', key, 'Replied on the original thread', thread.getId());
}

// ---------- Right thread ----------

/** The saved Thread ID (checked), or a Gmail search by claim # from the vendor's domain. */
function findThread_(job, vendor) {
  var claim = String(job['Claim #'] || '').trim();
  var who = vendor.audience === 'homeowner' ? String(job['Customer Email'] || '').toLowerCase() : '@' + vendor.domain;
  if (job['Thread ID']) {
    var t = null;
    try { t = GmailApp.getThreadById(String(job['Thread ID'])); } catch (e) { t = null; }
    if (t && threadHas_(t, who) && (!claim || threadMentions_(t, claim))) return { threads: [t], query: 'saved thread ID' };
    return { threads: [], query: 'the saved thread ID (it no longer matches this customer)' };
  }
  if (!claim) return { threads: [], query: 'this job (no thread ID and no claim #)' };
  var q = '"' + claim + '" from:' + who + ' newer_than:180d -in:drafts';
  return { threads: GmailApp.search(q, 0, 5), query: 'claim ' + claim };
}
function threadHas_(thread, who) {
  return thread.getMessages().some(function (m) {
    return (m.getFrom() + ' ' + m.getTo() + ' ' + m.getCc()).toLowerCase().indexOf(who) >= 0;
  });
}
function threadMentions_(thread, claim) {
  var first = thread.getMessages()[0];
  return (thread.getFirstMessageSubject() + ' ' + first.getPlainBody()).indexOf(claim) >= 0;
}

// ---------- Helpdesk tickets (Zendesk-style API) ----------

function postTicket_(cfg, job, vendor, status, key, text, rowNum, head, done) {
  if (!cfg.helpdeskUrl) return toPerson_(cfg, job, status, key, 'HELPDESK_URL is not set, so ticket updates cannot be posted.', text, done);
  var ticketId = job['Thread ID'];
  if (!ticketId) {
    var res = helpdesk_(cfg, 'get', '/search.json?query=' + encodeURIComponent('type:ticket status<solved "' + job['Claim #'] + '"'));
    var hits = (res.results || []);
    if (hits.length !== 1) {
      return toPerson_(cfg, job, status, key, (hits.length ? hits.length + ' open tickets' : 'No open ticket') +
        ' mention claim ' + job['Claim #'] + '. It will not guess and never opens a new ticket.', text, done);
    }
    ticketId = String(hits[0].id);
    setCell_(rowNum, head, 'Thread ID', ticketId);
  }
  var ticket = helpdesk_(cfg, 'get', '/tickets/' + ticketId + '/comments.json?sort_order=desc').comments || [];
  if (ticket.length && ticket[0].author_id !== cfg.helpdeskSelf && ticket[0].public && job['Ticket Seen'] !== ticket[0].id) {
    return toPerson_(cfg, job, status, key, 'The vendor added a comment on ticket ' + ticketId + ' that nobody has marked as seen.', text, done);
  }
  if (cfg.shadow) {
    setCell_(rowNum, head, 'Last Notified Key', key);
    log_(job, status, 'drafted', key, 'SHADOW: would comment on ticket ' + ticketId + ':\n' + text, ticketId);
    return;
  }
  helpdesk_(cfg, 'put', '/tickets/' + ticketId + '.json', { ticket: { comment: { body: text, public: true } } });
  setCell_(rowNum, head, 'Last Notified Key', key);
  log_(job, status, 'sent', key, 'Public comment on ticket ' + ticketId, ticketId);
}
function helpdesk_(cfg, method, path, body) {
  var opts = { method: method, muteHttpExceptions: true, contentType: 'application/json',
               headers: { Authorization: 'Bearer ' + cfg.helpdeskToken } };
  if (body) opts.payload = JSON.stringify(body);
  var resp = UrlFetchApp.fetch(cfg.helpdeskUrl + path, opts);
  if (resp.getResponseCode() >= 300) throw new Error('Helpdesk returned ' + resp.getResponseCode() + ' for ' + path);
  return JSON.parse(resp.getContentText() || '{}');
}

// ---------- Templates ----------

/** Vendors want the claim # first and dates in their format. Homeowners want plain words. */
function render_(style, status, job, tz) {
  var f = function (d, p) { return d ? Utilities.formatDate(new Date(d), tz, p) : ''; };
  var claim = job['Claim #'], tech = job.Tech || 'a Summit technician';
  var ws = job['Window Start'], we = job['Window End'];
  var first = String(job.Customer || '').split(' ')[0];
  var techFirst = String(tech).split(' ')[0];
  var lines;
  if (style === 'bluepeak' || style === 'harbor') {
    var win = f(ws, 'MM/dd/yyyy, h:mm a') + '–' + f(we, 'h:mm a');
    lines = {
      received: 'Claim ' + claim + ': received and accepted by ' + OFFICE_NAME + ' (our job ' + job['Job ID'] + '). We will contact the homeowner and post the appointment on this thread.',
      scheduled: 'Claim ' + claim + ': appointment set for ' + win + '. Technician: ' + tech + '.',
      rescheduled: 'Claim ' + claim + ': appointment moved to ' + win + ' at the homeowner\'s request. Technician: ' + tech + '.',
      en_route: 'Claim ' + claim + ': technician ' + tech + ' is on the way. ETA ' + f(job.ETA, 'h:mm a') + '.',
      waiting_parts: 'Claim ' + claim + ': diagnosed, waiting on parts.\nPart: ' + job.Part + ', ordered. ETA ' + f(job['Part ETA'], 'MM/dd/yyyy') + '.\nWe will book the return visit when it arrives and post it here.',
      completed: 'Claim ' + claim + ': completed.\nWork done: ' + job['Work Done'] + '\nCompletion report attached.'
    };
    return lines[status] + '\n\n' + OFFICE_NAME + ' dispatch · ' + OFFICE_PHONE + '\nAutomated update. Reply here and a person will read it.';
  }
  if (style === 'northstar') {
    var rows = ['Status: ' + status.toUpperCase().replace('_', ' '), 'Claim: ' + claim];
    if (status === 'scheduled' || status === 'rescheduled') rows.push('Appt: ' + f(ws, 'yyyy-MM-dd HH:mm') + '–' + f(we, 'HH:mm'), 'Tech: ' + tech);
    if (status === 'en_route') rows.push('Tech: ' + tech, 'ETA: ' + f(job.ETA, 'HH:mm'));
    if (status === 'waiting_parts') rows.push('Part: ' + job.Part, 'Part ETA: ' + f(job['Part ETA'], 'yyyy-MM-dd'));
    if (status === 'completed') rows.push('Work: ' + job['Work Done'], 'Report: attached in the portal');
    return rows.join('\n');
  }
  var day = f(ws, 'EEEE, MMM d'), between = f(ws, 'h a') + ' and ' + f(we, 'h a');
  lines = {
    received: 'Hi ' + first + ', thanks for getting in touch. We have your request (job ' + job['Job ID'] + '). Someone from our office will call you within 4 hours to set a time.',
    scheduled: 'Hi ' + first + ', you\'re booked: ' + tech + ' will come ' + day + ' between ' + between + '. ' + techFirst + ' will text you when on the way.',
    rescheduled: 'Hi ' + first + ', as you asked, we\'ve moved your appointment to ' + day + ' between ' + between + '.',
    en_route: 'Hi ' + first + ', ' + techFirst + ' is on the way and should be with you around ' + f(job.ETA, 'h:mm a') + '.',
    waiting_parts: 'Hi ' + first + ', ' + techFirst + ' found the problem: the ' + String(job.Part).toLowerCase() + ' needs replacing. It\'s ordered and should arrive ' + f(job['Part ETA'], 'EEEE, MMM d') + '. We\'ll book the return visit as soon as it\'s in.',
    completed: 'Hi ' + first + ', all done. ' + job['Work Done'] + ' Your report is attached. Thanks for choosing Summit!'
  };
  return lines[status] + '\n\n' + OFFICE_NAME + ' · ' + OFFICE_PHONE + '\nJust reply to this email if anything changes.';
}

function reportAttachment_(job, status) {
  if (status !== 'completed' || !job['Report File ID']) return null;
  return DriveApp.getFileById(String(job['Report File ID'])).getAs(MimeType.PDF);
}

// ---------- Rules ----------

/** job + status + the detail that makes it a different update (the window or the part ETA). */
function idemKey_(job) {
  var d = job['Window Start'] || job['Part ETA'];
  var detail = d ? Utilities.formatDate(new Date(d), 'UTC', "yyyy-MM-dd'T'HH:mm") : '';
  return [job['Job ID'], String(job.Status).trim(), detail].filter(String).join('|');
}
function inQuietHours_(tz) {
  var h = Number(Utilities.formatDate(new Date(), tz, 'H'));
  return h >= QUIET_FROM || h < QUIET_TO;
}
function needsApproval_(cfg, vendorName) {
  if (cfg.newTemplates.indexOf(vendorName) < 0) return false;
  return approvedCount_(vendorName) < APPROVE_FIRST;
}
function approvedCount_(vendorName) {
  return Number(PropertiesService.getScriptProperties().getProperty('APPROVED_' + vendorName) || 0);
}
function bumpApproved_(vendorName) {
  PropertiesService.getScriptProperties().setProperty('APPROVED_' + vendorName, String(approvedCount_(vendorName) + 1));
}

// ---------- Fail to a person ----------

function toPerson_(cfg, job, status, key, why, text, done) {
  log_(job, status, 'person', key, why);
  done[key] = 'person';
  MailApp.sendEmail({
    to: cfg.alertTo, name: 'Summit Ops Bot',
    subject: 'Needs a person: ' + job['Job ID'] + ' ' + status + ' update not posted',
    body: why + '\n\nJob: ' + job['Job ID'] + ' · ' + job.Customer + ' · ' + job.Vendor + (job['Claim #'] ? ' · ' + job['Claim #'] : '') +
          '\nIdempotency key: ' + key + '\n\nThe update it was going to post:\n\n' + text +
          '\n\nNothing was sent. It will not retry this update by itself.'
  });
}
function failToPerson_(cfg, subject, err, job) {
  try {
    MailApp.sendEmail({ to: cfg.alertTo, name: 'Summit Ops Bot', subject: subject,
      body: 'Error: ' + (err && err.stack || err) + (job ? '\n\nRow: ' + JSON.stringify(job) : '') +
            '\n\nNothing was posted for this job. It will be tried again on the next run.' });
  } catch (e) { console.error('Could not send failure alert: ' + e); }
}

// ---------- Sheet helpers ----------

function config_() {
  var p = PropertiesService.getScriptProperties();
  return {
    shadow: String(p.getProperty('SHADOW_MODE') || 'true').toLowerCase() === 'true',
    alertTo: p.getProperty('ALERT_TO') || Session.getEffectiveUser().getEmail(),
    tz: p.getProperty('TIMEZONE') || Session.getScriptTimeZone(),
    newTemplates: String(p.getProperty('NEW_TEMPLATES') || '').split(',').map(function (s) { return s.trim(); }).filter(String),
    helpdeskUrl: p.getProperty('HELPDESK_URL') || '',
    helpdeskToken: p.getProperty('HELPDESK_TOKEN') || '',
    helpdeskSelf: Number(p.getProperty('HELPDESK_SELF_ID') || 0)
  };
}
function sheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Sheet "' + name + '" not found.');
  return s;
}
function toObject_(head, row) {
  var o = {};
  head.forEach(function (h, i) { o[String(h).trim()] = row[i]; });
  return o;
}
function setCell_(rowNum, head, column, value) {
  var c = head.indexOf(column);
  if (c >= 0) sheet_(SHEETS.jobs).getRange(rowNum, c + 1).setValue(value);
}
/** Key → last result, from the Update Log. Later rows win. */
function sentKeys_() {
  var rows = sheet_(SHEETS.log).getDataRange().getValues();
  var out = {};
  for (var i = 1; i < rows.length; i++) {
    var key = rows[i][3], result = rows[i][4];
    if (!key || result === 'skipped' || result === 'error') continue;
    out[key] = result;
  }
  return out;
}
function log_(job, status, result, key, note, thread) {
  sheet_(SHEETS.log).appendRow([new Date(), job ? job['Job ID'] : '', status, key, result, thread || '', note || '']);
}
