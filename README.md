# Gmail Unread Fetcher — User Guide

A small command-line tool that connects to **up to three Gmail inboxes** (or more) and, for each one:

1. finds every **unread** email,
2. prints the sender, subject, date and **full message text** in the console window,
3. downloads all **attachments** to a folder on your PC,
4. **marks each email as read** in Gmail.

It uses Google's official Gmail API with secure OAuth sign-in. Your Gmail password is never entered into or stored by the tool.

---

## Contents

1. [What you need](#1-what-you-need)
2. [One-time Google Cloud setup](#2-one-time-google-cloud-setup)
3. [Install the tool](#3-install-the-tool)
4. [Configure the tool](#4-configure-the-tool)
5. [Connect your three Gmail accounts](#5-connect-your-three-gmail-accounts)
6. [Everyday use](#6-everyday-use)
7. [What the output looks like](#7-what-the-output-looks-like)
8. [Where files are stored](#8-where-files-are-stored)
9. [Optional settings](#9-optional-settings)
10. [Running automatically on a schedule (Windows)](#10-running-automatically-on-a-schedule-windows)
11. [Troubleshooting](#11-troubleshooting)
12. [Security notes](#12-security-notes)
13. [Command reference](#13-command-reference)

---

## 1. What you need

- A Windows, macOS or Linux PC
- **Node.js 20.12 or newer** — download the "LTS" version from [nodejs.org](https://nodejs.org/) and install with the default options (needed for native `.env` loading; no `dotenv` package)
- A Google account to create a (free) Google Cloud project
- The three Gmail addresses you want to read

To check Node.js is installed, open **PowerShell** (Windows) or **Terminal** (macOS/Linux) and run:

```powershell
node --version
```

You should see something like `v20.x.x` or higher.

---

## 2. One-time Google Cloud setup

Google requires an "OAuth client" so the tool is allowed to access Gmail. This takes about 10 minutes and is done only once.

> If you have already received a `.env` file with a **Client ID** and **Client secret** filled in, and your three Gmail addresses have been added as test users, skip to [section 3](#3-install-the-tool).

### 2.1 Create a project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. At the top, click the project selector → **New Project** → give it a name (e.g. `gmail-fetcher`) → **Create**.
3. Make sure the new project is selected at the top of the page.

### 2.2 Enable the Gmail API

1. Open **APIs & Services → Library**.
2. Search for **Gmail API**, open it, and click **Enable**.

### 2.3 Configure the consent screen

1. Open **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience**).
2. Choose **External** and fill in the required fields (app name, your support email, developer email). Save.
3. Under **Test users** (or **Audience → Test users**), click **Add users** and add **all three Gmail addresses** you want to use. Save.

> Only addresses listed as test users can sign in. If you later want to add a fourth inbox, add it here first.

### 2.4 Create the OAuth client

1. Open **APIs & Services → Credentials** (or **Google Auth Platform → Clients**).
2. Click **Create credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it anything. Click **Create**.
4. Copy the **Client ID** and **Client secret** (or download the JSON file — both values are inside it as `client_id` and `client_secret`).

Desktop clients automatically allow `http://localhost` addresses, so there is no redirect URL to configure.

One client can serve all three inboxes. If your inboxes belong to different Google Cloud projects, create a Desktop client in each project and see [4.2](#42-optional-a-separate-client-per-inbox).

---

## 3. Install the tool

1. Unzip / copy the project folder somewhere on your PC, e.g. `C:\gmail-unread-fetcher`.
2. Open PowerShell **in that folder**. (In File Explorer, open the folder, click the address bar, type `powershell` and press Enter.)
3. Install the dependency (there is only one, `googleapis`):

```powershell
npm install
```

4. Check everything works (this uses a simulated inbox and does not contact Google):

```powershell
npm test
```

You should see `VIRTUAL TEST: PASS` at the end.

---

## 4. Configure the tool

### 4.1 One client for all inboxes (usual case)

1. Create your settings file by copying the example:

```powershell
copy .env.example .env
```

   (macOS/Linux: `cp .env.example .env`)

   The file **must** be named exactly `.env`. Editing `.env.example` has no effect.

2. Open `.env` in Notepad (or any text editor) and fill in the two values from step 2.4:

```ini
GOOGLE_CLIENT_ID=1234567890-abc...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000
GMAIL_ACCOUNTS=account1,account2,account3
SAVE_ATTACHMENTS_TO_DISK=1
```

3. Save the file.

Leave `GOOGLE_REDIRECT_URI` as `http://localhost:3000` unless port 3000 is already used by another program on your PC (then use e.g. `http://localhost:3010`).

### 4.2 Optional: a separate client per inbox

If each inbox has its own Google Cloud project, add per-label values. The label is appended in
capitals, so `account1` uses `..._ACCOUNT1`. Give each one a different port so sign-ins never clash:

```ini
GOOGLE_CLIENT_ID_ACCOUNT1=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET_ACCOUNT1=GOCSPX-...
GOOGLE_REDIRECT_URI_ACCOUNT1=http://localhost:3000

GOOGLE_CLIENT_ID_ACCOUNT2=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET_ACCOUNT2=GOCSPX-...
GOOGLE_REDIRECT_URI_ACCOUNT2=http://localhost:3001

GOOGLE_CLIENT_ID_ACCOUNT3=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET_ACCOUNT3=GOCSPX-...
GOOGLE_REDIRECT_URI_ACCOUNT3=http://localhost:3002
```

Any label without its own values falls back to the shared `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`. Custom labels work the same way: `billing` reads `GOOGLE_CLIENT_ID_BILLING`.

---

## 5. Connect your three Gmail accounts

The tool refers to your inboxes by **labels**: `account1`, `account2`, `account3`. You decide which Gmail belongs to which label by the account you choose when signing in.

These sign-in commands **do not read or change any email** — they only connect the account.

### Connect account 1

```powershell
npm run auth:1
```

1. The window prints a long `https://accounts.google.com/...` link. Hold **Ctrl** and click it (or copy it into your browser).
2. Google shows an account chooser — pick the **first** Gmail.
3. You may see **"Google hasn't verified this app"**. This is normal for a private project: click **Continue**.
4. Approve the Gmail permission.
5. The browser tab shows **"Auth complete. You can close this tab."**
6. The console shows:

```text
Tokens saved to ...\tokens\account1.json
Signed in as: first.address@gmail.com
```

### Connect accounts 2 and 3

Repeat with:

```powershell
npm run auth:2
npm run auth:3
```

choosing the **second** and **third** Gmail in the account chooser.

> Tip: `npm run auth:all` does all three one after another in a single run.

If you accidentally pick the same Gmail for two labels, the tool prints a **WARNING**. See [Change which Gmail a label uses](#change-which-gmail-a-label-uses).

You only need to do this once. The tool remembers each connection and renews it automatically.

---

## 6. Everyday use

Open PowerShell in the project folder and run one of:

| What you want | Command |
|---|---|
| Process **all three** inboxes | `npm run fetch:all` |
| Process only inbox 1 | `npm run fetch:1` |
| Process only inbox 2 | `npm run fetch:2` |
| Process only inbox 3 | `npm run fetch:3` |

The tool processes every unread email, marks it as read, prints a summary, and exits on its own.

> **Important:** every email the tool processes is **marked as read** in Gmail. If you want to try it without affecting your normal inbox, see `GMAIL_QUERY` in [section 9](#9-optional-settings).

---

## 7. What the output looks like

For each unread email:

```text
======== UNREAD MESSAGE ========
Account: account1
ID:      18f2c3a9b7d4e001
From:    Jane Doe <jane@example.com>
Subject: Invoice September
Date:    Mon, 28 Sep 2026 09:14:02 -0400
-------- BODY --------
Hi, please find the invoice attached.
Kind regards, Jane
-------- ATTACHMENTS --------
- invoice-0923.pdf (application/pdf, 48211 bytes)
===============================
```

After all accounts, with `fetch:all`:

```text
======== SUMMARY ========
account1: first.address@gmail.com — 4 processed
account2: second.address@gmail.com — 0 processed
account3: third.address@gmail.com — 2 processed
Attachments held in memory: 3
```

- If an email has no plain-text version, the text is extracted from its HTML.
- If a single email fails (e.g. a network hiccup), it is reported as `Failed on message ... (left unread)`, stays unread in Gmail, and the tool continues with the next one. It will be picked up again on the next run.

To save the output to a file as well:

```powershell
npm run fetch:all | Tee-Object -FilePath "run-log.txt"
```

---

## 8. Where files are stored

Everything is inside the project folder:

```text
gmail-unread-fetcher/
├── .env                      your settings (Client ID / secret)
├── tokens/
│   ├── account1.json         saved Gmail connection for account1
│   ├── account2.json
│   ├── account3.json
│   └── accounts.json         which Gmail address each label is linked to
└── attachments/
    ├── account1/
    │   └── <email id>/
    │       ├── invoice-0923.pdf
    │       └── photo (2).jpg     ← duplicates within one email get (2), (3)…
    ├── account2/
    └── account3/
```

- Each email's attachments go into their own folder named after the Gmail message ID.
- Attachment names supplied by the sender are sanitised before writing, so an attachment can never be saved outside its own message folder or overwrite another file.
- Keep `.env` and the `tokens` folder private — they grant access to the inboxes.

---

## 9. Optional settings

All settings live in `.env`. Lines starting with `#` are ignored.

| Setting | Default | Meaning |
|---|---|---|
| `GMAIL_ACCOUNTS` | `account1,account2,account3` | Labels processed by `fetch:all` / `auth:all` |
| `GOOGLE_CLIENT_ID_<LABEL>` and friends | — | Per-inbox OAuth client, see [4.2](#42-optional-a-separate-client-per-inbox) |
| `GMAIL_QUERY` | `is:unread` | Which emails to process, using normal Gmail search syntax |
| `SAVE_ATTACHMENTS_TO_DISK` | `1` | Set to `0` to not write attachments to disk |
| `GMAIL_ACCOUNT` | `account1` | Label used by plain `npm start` |
| `GMAIL_TOKENS_DIR` | `tokens` | Alternative folder for saved connections |
| `GMAIL_ATTACHMENTS_DIR` | `attachments` | Alternative folder for attachments |

### Useful `GMAIL_QUERY` examples

```ini
# Only unread mail in the Inbox (skip Promotions/Social/other labels)
GMAIL_QUERY=is:unread in:inbox category:primary

# Only unread mail that has attachments
GMAIL_QUERY=is:unread has:attachment

# Only unread mail from one sender
GMAIL_QUERY=is:unread from:billing@example.com

# Only unread mail from the last 7 days
GMAIL_QUERY=is:unread newer_than:7d

# Safe test: only mail you tagged with a Gmail label "fetch-test"
GMAIL_QUERY=is:unread label:fetch-test
```

### Using your own labels instead of account1/2/3

```ini
GMAIL_ACCOUNTS=sales,support,billing
```

Then connect and run with:

```powershell
npm start -- --auth-only --account sales
npm start -- --auth-only --account support
npm start -- --auth-only --account billing

npm start -- --all                 # process all
npm start -- --account support     # process one
```

(The shortcuts `auth:1`, `fetch:1` etc. always refer to `account1`, `account2`, `account3`.)

---

## 10. Running automatically on a schedule (Windows)

To check the inboxes automatically, e.g. every 15 minutes:

1. Complete sections 3–5 first (accounts must already be connected).
2. Open **Task Scheduler** → **Create Task…**
3. **General** tab: name it `Gmail Unread Fetcher`; choose **Run whether user is logged on or not** if desired.
4. **Triggers** tab → **New…** → *Daily*, then tick **Repeat task every: 15 minutes** for a duration of **Indefinitely**.
5. **Actions** tab → **New…**
   - Program/script: `cmd.exe`
   - Add arguments:
     `/c npm run fetch:all >> run-log.txt 2>&1`
   - Start in: the full project folder path, e.g. `C:\gmail-unread-fetcher`
6. Click **OK**.

The output of every run is appended to `run-log.txt` in the project folder.

---

## 11. Troubleshooting

| Message / symptom | Cause and fix |
|---|---|
| `Missing required env var: GOOGLE_CLIENT_ID` | `.env` is missing, is still named `.env.example`, or still holds the placeholder values. Redo [section 4](#4-configure-the-tool). |
| `Unknown argument: ...` | A mistyped option. Run `npm start -- --help` to see the valid ones. |
| `Node ... cannot read .env by itself` | Node is older than 20.12. Upgrade Node, or run `node --env-file=.env index.js --all`. |
| Browser: **"Access blocked"** / **Error 403: access_denied** | That Gmail is not a test user. Add it in Google Cloud ([2.3](#23-configure-the-consent-screen)) and try again. |
| Browser: **"Google hasn't verified this app"** | Normal for a private project. Click **Continue**. |
| `OAuth error from Google: access_denied` | You clicked Cancel/Deny. Run the `auth` command again and approve. |
| `The OAuth client was not found` / `invalid_client` | Client ID or secret in `.env` is wrong or has extra spaces. Copy them again. |
| `Gmail API has not been used in project ... or it is disabled` | Enable the Gmail API ([2.2](#22-enable-the-gmail-api)), wait a minute, retry. |
| `Could not listen on port 3000` | Another program uses port 3000. Either paste the full address from the browser's address bar into the console when asked, or change `GOOGLE_REDIRECT_URI` to another port (e.g. `http://localhost:3010`). |
| Browser shows "This site can't be reached" after approving | The tool was not running or was closed. Copy the full address from the browser's address bar, run the `auth` command again, and paste it when asked for "Redirect URL or code". Or simply run the `auth` command again and re-approve. |
| `... token is expired or revoked. Delete the token file and authorize again.` | The saved connection stopped working (see note below). Delete `tokens\accountN.json` and run `npm run auth:N`. |
| `WARNING: "account2" and "account1" are both signed in as ...` | The same Gmail was chosen twice. See below. |
| `No unread messages.` | Nothing to do — the inbox has no emails matching `GMAIL_QUERY`. |

### Why a connection can expire after 7 days

While the Google Cloud project's consent screen is in **Testing** mode, Google expires saved connections after **7 days**. You then see the "expired or revoked" message and must reconnect (delete the token file and run `auth:N`).

To avoid this, in Google Cloud go to **OAuth consent screen / Audience** and click **Publish app** (set it to **In production**). For personal use you do not need to complete Google's verification; users will just see the "unverified app" notice when connecting.

A connection also stops working if the Gmail password is changed or access is removed at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Change which Gmail a label uses

1. Delete the file `tokens\accountN.json` (e.g. `tokens\account2.json`).
2. Run `npm run auth:N` (e.g. `npm run auth:2`) and choose the correct Gmail.

---

## 12. Security notes

- The tool requests the `gmail.modify` permission, which Google requires to mark emails as read. The tool itself only **reads** emails and **removes the "unread" flag**. It never sends, moves or deletes anything, and this permission does not allow permanent deletion.
- `.env` (client secret) and `tokens/` (inbox access) are excluded from Git by `.gitignore`. Do not email or share them.
- To revoke access at any time, open [myaccount.google.com/permissions](https://myaccount.google.com/permissions) with the Gmail account and remove the app, then delete the matching file in `tokens/`.
- If the client secret is ever exposed, reset it in Google Cloud (**Credentials → your OAuth client → Reset secret**), put the new value in `.env`, and reconnect the accounts.

---

## 13. Command reference

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (once) |
| `npm test` | Offline self-test with a simulated inbox; does not touch real accounts |
| `npm run auth:1` / `auth:2` / `auth:3` | Connect Gmail account 1 / 2 / 3 (no emails read) |
| `npm run auth:all` | Connect all accounts in `GMAIL_ACCOUNTS`, one after another |
| `npm run fetch:1` / `fetch:2` / `fetch:3` | Process unread mail for one account |
| `npm run fetch:all` | Process unread mail for all accounts, then print a summary |
| `npm start -- --account <label>` | Process one account by any label |
| `npm start -- --auth-only --account <label>` | Connect one account by any label |
| `npm start -- --all` | Same as `fetch:all` |
| `npm start -- --help` | List the available options |

Exit code is `0` on success and `1` if any account or email failed (useful for scheduled tasks and monitoring). Mistyped options are rejected instead of being ignored, so a typo can never silently run against the wrong inbox.

### For developers

`index.js` is an ES module. It exports `main(argv)` and the in-memory `attachments` array (each item: `account`, `messageId`, `filename`, `mimeType`, `size`, `data` as a `Buffer`), so the tool can be embedded in another Node.js program:

```js
import { main, attachments } from './index.js';

const results = await main(['--all']);
console.log(results, attachments.length);
```

Importing `index.js` loads `.env` automatically via Node's built-in `process.loadEnvFile` (existing environment variables are not overwritten). The only npm dependency is `googleapis`.
