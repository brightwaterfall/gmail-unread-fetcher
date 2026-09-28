/**
 * Gmail unread fetcher (multi-account)
 * OAuth2 per account → unread → log body + attachments → mark read → exit.
 *
 * Usage:
 *   npm start -- --account account2       one inbox
 *   npm start -- --all                    every inbox in GMAIL_ACCOUNTS
 *   npm start -- --auth-only --account account1   sign in only, don't touch mail
 *
 * Tokens: tokens/<account>.json  (one file per Gmail inbox)
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const SAVE_TO_DISK = process.env.SAVE_ATTACHMENTS_TO_DISK !== '0';
const TOKENS_DIR = path.resolve(process.env.GMAIL_TOKENS_DIR || path.join(__dirname, 'tokens'));
const ATTACHMENTS_DIR = path.resolve(process.env.GMAIL_ATTACHMENTS_DIR || path.join(__dirname, 'attachments'));
const ACCOUNTS_FILE = path.join(TOKENS_DIR, 'accounts.json');
const QUERY = process.env.GMAIL_QUERY || 'is:unread';

/** In-memory store of every attachment found this run. */
const attachments = [];

function parseArgs(argv) {
  const opts = { all: false, authOnly: false, account: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--auth-only') opts.authOnly = true;
    else if ((a === '--account' || a === '-a') && argv[i + 1]) opts.account = argv[++i];
  }
  return opts;
}

function resolveAccounts(opts) {
  if (opts.all) {
    const list = (process.env.GMAIL_ACCOUNTS || 'account1,account2,account3')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(sanitizeAccount);
    if (!list.length) throw new Error('GMAIL_ACCOUNTS is empty');
    return list;
  }
  const name = opts.account || process.env.GMAIL_ACCOUNT || process.env.GMAIL_ACCOUNT_DEFAULT || 'account1';
  return [sanitizeAccount(name)];
}

function sanitizeAccount(name) {
  const cleaned = String(name).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned) throw new Error('Account name is empty after sanitizing');
  if (cleaned === 'accounts') throw new Error('"accounts" is reserved; pick another account label');
  return cleaned;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || /^your-/i.test(value)) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    requireEnv('GOOGLE_REDIRECT_URI')
  );
}

function tokenPathFor(account) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  return path.join(TOKENS_DIR, `${account}.json`);
}

function readAccountsMap() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Remember which Gmail address each label maps to; warn if two labels share one inbox. */
function recordAccountEmail(account, email) {
  const map = readAccountsMap();
  const clash = Object.keys(map).find((k) => k !== account && map[k] === email);
  if (clash) {
    console.warn(
      `WARNING: "${account}" and "${clash}" are both signed in as ${email}. ` +
        `Delete ${tokenPathFor(account)} and re-authorize with a different Gmail.`
    );
  }
  if (map[account] !== email) {
    map[account] = email;
    fs.mkdirSync(TOKENS_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(map, null, 2));
  }
}

function persistRefreshedTokens(oAuth2Client, tokenPath, initial) {
  let current = initial;
  oAuth2Client.on('tokens', (fresh) => {
    current = { ...current, ...fresh };
    fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2));
  });
}

/**
 * Load tokens/<account>.json if present; otherwise browser + code flow once for that inbox.
 */
async function authorize(oAuth2Client, account) {
  const tokenPath = tokenPathFor(account);

  if (fs.existsSync(tokenPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2Client.setCredentials(tokens);
    persistRefreshedTokens(oAuth2Client, tokenPath, tokens);
    console.log(`Using saved tokens for "${account}" (${tokenPath})`);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SCOPES,
  });

  console.log(`\nAuthorize Gmail for account label "${account}" by visiting:\n`);
  console.log(authUrl);
  console.log('\nPick the Gmail inbox that should map to this label in the account chooser.');
  console.log('After approving, the tab should say "Auth complete". If it does not,');
  console.log('paste the full redirect URL (or just the code= value) below.\n');

  const code = await obtainAuthCode();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  persistRefreshedTokens(oAuth2Client, tokenPath, tokens);
  console.log(`Tokens saved to ${tokenPath}\n`);
  return oAuth2Client;
}

function extractCode(pasted) {
  if (!pasted) throw new Error('No authorization code provided');
  if (!pasted.includes('://') && !pasted.includes('code=')) return pasted;
  try {
    const code = new URL(pasted).searchParams.get('code');
    if (code) return code;
  } catch {
    /* not a URL */
  }
  const match = pasted.match(/[?&]code=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return pasted;
}

/**
 * Wait for the OAuth code: either the browser hits the local redirect server,
 * or the user pastes the redirect URL / code into the terminal. Whichever comes first wins.
 */
function obtainAuthCode() {
  let redirect = null;
  try {
    redirect = new URL(requireEnv('GOOGLE_REDIRECT_URI'));
  } catch {
    /* fall back to paste */
  }
  const canListen =
    redirect &&
    redirect.protocol === 'http:' &&
    (redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1');

  return new Promise((resolve, reject) => {
    let settled = false;
    let server = null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const done = (err, code) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (server) {
        server.close();
        server.closeAllConnections?.();
      }
      if (err) reject(err);
      else resolve(code);
    };

    rl.question('Redirect URL or code: ', (answer) => {
      const pasted = String(answer || '').trim();
      if (!pasted) {
        if (!server) done(new Error('No authorization code provided'));
        return;
      }
      try {
        done(null, extractCode(pasted));
      } catch (err) {
        done(err);
      }
    });

    if (!canListen) return;

    const port = Number(redirect.port || 80);
    const expectedPath = redirect.pathname || '/';

    server = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      if (expectedPath !== '/' && reqUrl.pathname !== expectedPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const oauthError = reqUrl.searchParams.get('error');
      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth error: ${oauthError}`);
        done(new Error(`OAuth error from Google: ${oauthError}`));
        return;
      }
      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code parameter');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Auth complete.</h2><p>You can close this tab.</p></body></html>');
      process.stdout.write('\n(Received code from browser.)\n');
      done(null, code);
    });

    server.on('error', (err) => {
      console.log(`\n(Could not listen on port ${port}: ${err.code || err.message} — paste the redirect URL instead.)`);
      server = null;
    });

    server.listen(port, '127.0.0.1');
  });
}

function decodeBase64Url(data) {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function walkParts(part, messageId, bag) {
  if (!part) return;

  const disposition =
    (part.headers || []).find((h) => h.name.toLowerCase() === 'content-disposition')?.value || '';
  const isAttachment =
    Boolean(part.filename) ||
    Boolean(part.body && part.body.attachmentId) ||
    /attachment/i.test(disposition);

  if (part.mimeType === 'text/plain' && part.body?.data && !isAttachment) {
    bag.textParts.push(decodeBase64Url(part.body.data).toString('utf8'));
  } else if (part.mimeType === 'text/html' && part.body?.data && !isAttachment) {
    bag.htmlParts.push(decodeBase64Url(part.body.data).toString('utf8'));
  }

  if (isAttachment && (part.body?.attachmentId || part.body?.data)) {
    bag.attachmentParts.push({
      messageId,
      filename: part.filename || 'unnamed',
      mimeType: part.mimeType || 'application/octet-stream',
      attachmentId: part.body.attachmentId || null,
      inlineData: part.body.data || null,
      size: part.body.size || 0,
    });
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) walkParts(child, messageId, bag);
  }
}

function htmlToRoughText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** "a.pdf" → "a (2).pdf" when a name is already taken within the same message. */
function uniqueFileName(name, used) {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'unnamed';
  let candidate = safe;
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function fetchAttachmentBytes(gmail, messageId, meta) {
  if (meta.inlineData) return decodeBase64Url(meta.inlineData);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: meta.attachmentId,
  });
  return decodeBase64Url(res.data.data);
}

async function listUnreadIds(gmail) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q: QUERY, maxResults: 500, pageToken });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function processMessage(gmail, messageId, account) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = res.data;
  const headers = msg.payload?.headers || [];
  const bag = { textParts: [], htmlParts: [], attachmentParts: [] };
  walkParts(msg.payload, messageId, bag);

  let body = bag.textParts.join('\n\n').trim();
  if (!body && bag.htmlParts.length) body = htmlToRoughText(bag.htmlParts.join('\n'));
  if (!body && msg.snippet) body = msg.snippet;

  console.log('======== UNREAD MESSAGE ========');
  console.log(`Account: ${account}`);
  console.log(`ID:      ${messageId}`);
  console.log(`From:    ${headerValue(headers, 'From')}`);
  console.log(`Subject: ${headerValue(headers, 'Subject')}`);
  console.log(`Date:    ${headerValue(headers, 'Date')}`);
  console.log('-------- BODY --------');
  console.log(body || '(empty body)');
  console.log('-------- ATTACHMENTS --------');

  const usedNames = new Set();
  for (const meta of bag.attachmentParts) {
    const data = await fetchAttachmentBytes(gmail, messageId, meta);
    const filename = uniqueFileName(meta.filename, usedNames);
    const item = {
      account,
      messageId,
      filename,
      mimeType: meta.mimeType,
      size: data.length,
      data,
    };
    attachments.push(item);
    console.log(`- ${item.filename} (${item.mimeType}, ${item.size} bytes)`);

    if (SAVE_TO_DISK) {
      const dir = path.join(ATTACHMENTS_DIR, account, messageId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), data);
    }
  }
  if (!bag.attachmentParts.length) console.log('(none)');
  console.log('===============================\n');

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function runAccount(account, { authOnly }) {
  console.log(`\n##### Gmail account label: ${account} #####`);

  const oAuth2Client = await authorize(createOAuthClient(), account);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  console.log(`Signed in as: ${email}`);
  recordAccountEmail(account, email);

  if (authOnly) return { account, email, processed: 0, failed: 0 };

  const ids = await listUnreadIds(gmail);
  if (!ids.length) {
    console.log('No unread messages.');
    return { account, email, processed: 0, failed: 0 };
  }

  console.log(`Found ${ids.length} unread message(s).\n`);
  let processed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await processMessage(gmail, id, account);
      processed++;
    } catch (err) {
      failed++;
      console.error(`Failed on message ${id} (left unread): ${describeError(err)}`);
    }
  }

  console.log(`Done. ${processed} message(s) processed for "${account}"${failed ? `, ${failed} failed` : ''}.`);
  if (SAVE_TO_DISK && processed) {
    console.log(`Attachments written under: ${path.join(ATTACHMENTS_DIR, account)}`);
  }
  return { account, email, processed, failed };
}

function describeError(err) {
  const msg = err?.response?.data?.error_description || err?.message || String(err);
  if (/invalid_grant/i.test(msg) || /invalid_grant/i.test(JSON.stringify(err?.response?.data || ''))) {
    return `${msg} — the saved token is expired or revoked. Delete the token file and authorize again.`;
  }
  return msg;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const accounts = resolveAccounts(opts);
  const results = [];

  for (const account of accounts) {
    try {
      results.push(await runAccount(account, opts));
    } catch (err) {
      console.error(`[${account}] Fatal: ${describeError(err)}`);
      results.push({ account, error: describeError(err) });
    }
  }

  if (accounts.length > 1) {
    console.log('\n======== SUMMARY ========');
    for (const r of results) {
      if (r.error) console.log(`${r.account}: ERROR — ${r.error}`);
      else if (opts.authOnly) console.log(`${r.account}: ${r.email} (authorized)`);
      else console.log(`${r.account}: ${r.email} — ${r.processed} processed${r.failed ? `, ${r.failed} failed` : ''}`);
    }
  }
  if (!opts.authOnly) console.log(`Attachments held in memory: ${attachments.length}`);

  return results;
}

module.exports = { main, attachments };

if (require.main === module) {
  main()
    .then((results) => {
      process.exitCode = results.some((r) => r.error || r.failed) ? 1 : 0;
    })
    .catch((err) => {
      console.error('Fatal:', err.message || err);
      process.exitCode = 1;
    });
}
