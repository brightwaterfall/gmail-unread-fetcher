'use strict';
/**
 * Virtual end-to-end test (no network). Stubs googleapis; runs real index.js
 * against a temp tokens/attachments folder so real credentials are never touched.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-fetcher-test-'));
const TOKENS = path.join(TMP, 'tokens');
const ATTACH = path.join(TMP, 'attachments');
const ACCOUNTS = ['account1', 'account2', 'account3'];
const ATT_BYTES = Buffer.from('%PDF-fake-attachment-content');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeMessage(id, attachmentNames) {
  return {
    id,
    snippet: 'snippet',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'Subject', value: `Virtual test email ${id}` },
        { name: 'Date', value: 'Mon, 28 Sep 2026 02:00:00 -0400' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url(`Hello from virtual inbox ${id}.`) } },
            { mimeType: 'text/html', body: { data: b64url('<p>Hi</p>') } },
          ],
        },
        ...attachmentNames.map((filename, i) => ({
          mimeType: 'application/pdf',
          filename,
          body: { attachmentId: `att-${i}`, size: ATT_BYTES.length },
        })),
      ],
    },
  };
}

// Page 1 → msg-1 (single attachment), page 2 → msg-2 (two attachments with the same name) + a broken message.
const MESSAGES = {
  'msg-1': fakeMessage('msg-1', ['receipt.pdf']),
  'msg-2': fakeMessage('msg-2', ['scan.pdf', 'scan.pdf']),
};
const BROKEN_ID = 'msg-broken';

const modifyCalls = [];

class FakeOAuth2 extends EventEmitter {
  setCredentials(tokens) { this.credentials = tokens; }
  generateAuthUrl() { return 'https://example.invalid/auth'; }
  async getToken() { return { tokens: { access_token: 't', refresh_token: 'r' } }; }
}

function fakeGmail({ auth }) {
  const account = auth.credentials.account;
  return {
    users: {
      async getProfile() { return { data: { emailAddress: `${account}@example.com` } }; },
      messages: {
        async list({ pageToken }) {
          if (!pageToken) return { data: { messages: [{ id: 'msg-1' }], nextPageToken: 'p2' } };
          return { data: { messages: [{ id: 'msg-2' }, { id: BROKEN_ID }] } };
        },
        async get({ id }) {
          if (id === BROKEN_ID) throw new Error('simulated API failure');
          return { data: MESSAGES[id] };
        },
        async modify(opts) { modifyCalls.push({ account, ...opts }); return { data: {} }; },
        attachments: {
          async get() { return { data: { data: b64url(ATT_BYTES) } }; },
        },
      },
    },
  };
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'googleapis') {
    return { google: { auth: { OAuth2: FakeOAuth2 }, gmail: fakeGmail } };
  }
  if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
  return origLoad.apply(this, arguments);
};

process.env.GOOGLE_CLIENT_ID = 'virtual.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'virtual-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000';
process.env.SAVE_ATTACHMENTS_TO_DISK = '1';
process.env.GMAIL_TOKENS_DIR = TOKENS;
process.env.GMAIL_ATTACHMENTS_DIR = ATTACH;
process.env.GMAIL_ACCOUNTS = ACCOUNTS.join(',');

fs.mkdirSync(TOKENS, { recursive: true });
for (const account of ACCOUNTS) {
  fs.writeFileSync(
    path.join(TOKENS, `${account}.json`),
    JSON.stringify({ access_token: 't', refresh_token: 'r', account })
  );
}

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const { main, attachments } = require('./index.js');

(async () => {
  try {
    const results = await main(['--all']);

    assert.strictEqual(results.length, 3, 'all three accounts ran');
    for (const r of results) {
      assert.ok(!r.error, `${r.account} had no fatal error`);
      assert.strictEqual(r.email, `${r.account}@example.com`, 'profile email reported');
      assert.strictEqual(r.processed, 2, `${r.account}: both pages processed`);
      assert.strictEqual(r.failed, 1, `${r.account}: broken message counted, run continued`);
    }

    assert.strictEqual(modifyCalls.length, 6, 'each good message marked read once per account');
    assert.ok(!modifyCalls.some((c) => c.id === BROKEN_ID), 'broken message left unread');
    assert.deepStrictEqual(modifyCalls[0].requestBody, { removeLabelIds: ['UNREAD'] });

    assert.strictEqual(attachments.length, 9, '3 attachments per account held in memory');
    for (const account of ACCOUNTS) {
      const one = path.join(ATTACH, account, 'msg-1', 'receipt.pdf');
      assert.ok(fs.readFileSync(one).equals(ATT_BYTES), `${account}: attachment bytes match`);
      assert.ok(fs.existsSync(path.join(ATTACH, account, 'msg-2', 'scan.pdf')), 'first duplicate kept');
      assert.ok(fs.existsSync(path.join(ATTACH, account, 'msg-2', 'scan (2).pdf')), 'second duplicate renamed');
    }

    const map = JSON.parse(fs.readFileSync(path.join(TOKENS, 'accounts.json'), 'utf8'));
    assert.deepStrictEqual(map, {
      account1: 'account1@example.com',
      account2: 'account2@example.com',
      account3: 'account3@example.com',
    });

    assert.strictEqual(unhandled, 0, 'no unhandled rejections');
    console.log('\nVIRTUAL TEST: PASS');
    process.exitCode = 0;
  } catch (err) {
    console.log('\nVIRTUAL TEST: FAIL —', err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
