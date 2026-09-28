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
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load .env via Node's built-in API (no dotenv). Does not override vars already set. */
function loadEnvFile() {
  const envPath = [path.join(__dirname, '.env'), path.join(process.cwd(), '.env')].find((p) =>
    fs.existsSync(p)
  );
  if (!envPath) return;
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(
      `Node ${process.versions.node} cannot read .env by itself. ` +
        'Upgrade to Node 20.12+, or run with: node --env-file=.env index.js'
    );
    return;
  }
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* unreadable or malformed — requireEnv will report what is missing */
  }
}

loadEnvFile();

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const SAVE_TO_DISK = process.env.SAVE_ATTACHMENTS_TO_DISK !== '0';
const TOKENS_DIR = path.resolve(process.env.GMAIL_TOKENS_DIR || path.join(__dirname, 'tokens'));
const ATTACHMENTS_DIR = path.resolve(process.env.GMAIL_ATTACHMENTS_DIR || path.join(__dirname, 'attachments'));
const ACCOUNTS_FILE = path.join(TOKENS_DIR, 'accounts.json');
const QUERY = process.env.GMAIL_QUERY || 'is:unread';

/** Windows refuses these as file or folder names. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const USAGE = `Usage: node index.js [options]

  -a, --account <label>  inbox label to use (default: GMAIL_ACCOUNT, else account1)
      --all              every label listed in GMAIL_ACCOUNTS
      --auth-only        sign in only; do not read or mark any mail
  -m, --max <n>          process at most n emails per inbox (0 = no limit,
                         overrides GMAIL_MAX_MESSAGES)
  -h, --help             show this message`;

/** In-memory store of every attachment found this run. */
export const attachments = [];

function parseArgs(argv) {
  const opts = { all: false, authOnly: false, account: null, max: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--auth-only') opts.authOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--account' || a === '-a') {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${a}.\n\n${USAGE}`);
      opts.account = value;
    } else if (a === '--max' || a === '-m') {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${a}.\n\n${USAGE}`);
      opts.max = value;
    } else {
      throw new Error(`Unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return opts;
}

/** Highest number of emails to handle per inbox. 0 means no limit. */
function resolveMaxMessages(opts) {
  const raw = opts.max ?? process.env.GMAIL_MAX_MESSAGES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Message limit must be a whole number of 0 or more (got "${raw}"). ` +
        'Set GMAIL_MAX_MESSAGES in .env or pass --max <n>; 0 means no limit.'
    );
  }
  return value;
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
  if (RESERVED_NAMES.test(cleaned)) {
    throw new Error(`"${cleaned}" is a reserved device name; pick another account label`);
  }
  return cleaned;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || /^your-/i.test(value)) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** Prefer ACCOUNT1-style vars, then fall back to the shared GOOGLE_* vars. */
function envForAccount(account, base) {
  const upper = String(account).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const specific = process.env[`${base}_${upper}`];
  if (specific && !/^your-/i.test(specific)) return specific;
  return requireEnv(base);
}

function credentialsFor(account) {
  return {
    clientId: envForAccount(account, 'GOOGLE_CLIENT_ID'),
    clientSecret: envForAccount(account, 'GOOGLE_CLIENT_SECRET'),
    redirectUri: envForAccount(account, 'GOOGLE_REDIRECT_URI'),
  };
}

function createOAuthClient(account) {
  const { clientId, clientSecret, redirectUri } = credentialsFor(account);
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
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

  const code = await obtainAuthCode(credentialsFor(account).redirectUri);
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
function obtainAuthCode(redirectUri) {
  let redirect = null;
  try {
    redirect = new URL(redirectUri || requireEnv('GOOGLE_REDIRECT_URI'));
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

/**
 * Make a sender-supplied filename safe to write, then "a.pdf" → "a (2).pdf"
 * when the name is already taken within the same message.
 */
function uniqueFileName(name, used) {
  let cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '') // Windows silently drops trailing dots and spaces
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') cleaned = 'unnamed';

  const ext = path.extname(cleaned).slice(0, 20);
  let stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length) || 'unnamed';
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  if (stem.length > 120) stem = stem.slice(0, 120);

  let candidate = `${stem}${ext}`;
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

async function listUnreadIds(gmail, limit = 0) {
  const ids = [];
  let pageToken;
  do {
    const maxResults = limit ? Math.min(500, limit - ids.length) : 500;
    const res = await gmail.users.messages.list({ userId: 'me', q: QUERY, maxResults, pageToken });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && (!limit || ids.length < limit));
  return limit ? ids.slice(0, limit) : ids;
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

async function runAccount(account, { authOnly, maxMessages = 0 }) {
  console.log(`\n##### Gmail account label: ${account} #####`);

  const oAuth2Client = await authorize(createOAuthClient(account), account);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  console.log(`Signed in as: ${email}`);
  recordAccountEmail(account, email);

  if (authOnly) return { account, email, processed: 0, failed: 0 };

  const ids = await listUnreadIds(gmail, maxMessages);
  if (!ids.length) {
    console.log('No unread messages.');
    return { account, email, processed: 0, failed: 0 };
  }

  const capped = maxMessages && ids.length === maxMessages;
  console.log(
    `Found ${ids.length} unread message(s)${capped ? ` (limit of ${maxMessages} reached; the rest stay unread)` : ''}.\n`
  );
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
  const data = err?.response?.data;
  const msg =
    data?.error_description ||
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : null) ||
    err?.message ||
    String(err);
  if (data?.error === 'invalid_grant' || /invalid_grant/i.test(msg)) {
    return `${msg} — the saved token is expired or revoked. Delete the token file and authorize again.`;
  }
  return msg;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return [];
  }

  const accounts = resolveAccounts(opts);
  const maxMessages = resolveMaxMessages(opts);
  const results = [];

  for (const account of accounts) {
    try {
      results.push(await runAccount(account, { ...opts, maxMessages }));
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

/** True only when this file was the script node was told to run. */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (isEntryPoint()) {
  main()
    .then((results) => {
      process.exitCode = results.some((r) => r.error || r.failed) ? 1 : 0;
    })
    .catch((err) => {
      console.error('Fatal:', err.message || err);
      process.exitCode = 1;
    });
}
