# n8n version: status updates on the original thread

`m3-thread-updates.json` is an n8n workflow you can import (Workflows → Import from file).

**Every 5 minutes**

Schedule trigger → **Settings** (`shadowMode`, quiet hours, `newTemplates`) → read the **Jobs** sheet → read the **Update Log** sheet → a Code node finds jobs whose status changed and builds each update → IF it's an update to post:

1. **Find original thread.** A Gmail API call: the saved Thread ID if the row has one, otherwise a search for the claim # from the vendor's domain (or the homeowner's address).
2. **Exactly one thread?** If there are none, or more than one, the item goes to **Needs a person** (Slack `#office`) with the update it was going to post. It never starts a new thread and never picks one of two.
3. **Customer replied?** It reads the thread. If the newest message isn't from us and is still unread, the thread is paused and a person gets a Slack message. Otherwise it builds the reply with `Re:` + the original subject, `In-Reply-To` and `References`, so it lands in the same conversation.
4. **Draft only?** In shadow mode, or while a new vendor template still needs approval, it creates a Gmail **draft** on the thread. Otherwise it sends the reply on the thread.
5. Every result (sent, drafted, skipped, queued, person) is appended to the **Update Log**, and "Last Notified Key" is saved on the job row for sent, drafted and skipped updates.

## The rules, and where they live

- **Never twice.** The key is job + status + appointment window (or part ETA). The Code node skips any key already in the Update Log. Updates waiting for a person are not retried by themselves.
- **Quiet hours.** Homeowner updates between 8 PM and 7 AM are logged once as `queued` and go out on the first run after 7 AM. Vendors are exempt.
- **Approve the first 5.** For vendors listed in `newTemplates`, the draft waits for a person. They send it from Gmail and change that log row's Result from `person` to `approved`. After 5 approved sends, that vendor's updates go out on their own.
- **Retries.** Every Gmail, Google Sheets and Slack node has Retry on fail set to 3 tries, 5 seconds apart.
- **Errors.** `settings.errorWorkflow` is a placeholder. Point it at a small "fail to a person" workflow (Error Trigger → Slack or email), so a crash still reaches someone.

## Before you turn it on

1. Replace `REPLACE_WITH_YOUR_SHEET_ID` in the Google Sheets nodes and connect your own Google Sheets, Gmail and Slack credentials. The credential IDs in the file are placeholders.
2. In **Settings**, set `ourAddress` to the mailbox the updates come from, and `timezone`.
3. Leave `shadowMode` on for the first week. Read the drafts on real threads, then switch it off.
4. Helpdesk tickets and vendor portals: add an HTTP Request node with that system's API (search tickets by claim #, then post a public comment), using the same "exactly one" check. The Apps Script version has a Zendesk-style example.

The sheet columns are the same as in the Apps Script version. See the header comment in `../apps-script/thread-updates.gs`.
