/**
 * Virtual end-to-end test (no network). Stubs googleapis via mock-register.js;
 * runs real index.js against a temp tokens/attachments folder.
 *
 * Run: npm test  →  node --import ./mock-register.js mock-test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { modifyCalls, ATT_BYTES, BROKEN_ID } from './fake-googleapis.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-fetcher-test-'));
const TOKENS = path.join(TMP, 'tokens');
const ATTACH = path.join(TMP, 'attachments');
const ACCOUNTS = ['account1', 'account2', 'account3'];

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
process.on('unhandledRejection', () => {
  unhandled++;
});

const { main, attachments } = await import('./index.js');

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

  assert.strictEqual(attachments.length, 15, '5 attachments per account held in memory');
  for (const account of ACCOUNTS) {
    const one = path.join(ATTACH, account, 'msg-1', 'receipt.pdf');
    assert.ok(fs.readFileSync(one).equals(ATT_BYTES), `${account}: attachment bytes match`);

    const msgDir = path.join(ATTACH, account, 'msg-2');
    assert.ok(fs.existsSync(path.join(msgDir, 'scan.pdf')), 'first duplicate kept');
    assert.ok(fs.existsSync(path.join(msgDir, 'scan (2).pdf')), 'second duplicate renamed');
    assert.ok(fs.existsSync(path.join(msgDir, '.._escape.pdf')), 'traversal flattened into the message folder');
    assert.ok(!fs.existsSync(path.join(ATTACH, account, 'escape.pdf')), 'nothing written outside the message folder');
    assert.ok(fs.existsSync(path.join(msgDir, '_CON.txt')), 'Windows device name prefixed');
  }

  const map = JSON.parse(fs.readFileSync(path.join(TOKENS, 'accounts.json'), 'utf8'));
  assert.deepStrictEqual(map, {
    account1: 'account1@example.com',
    account2: 'account2@example.com',
    account3: 'account3@example.com',
  });

  assert.deepStrictEqual(await main(['--help']), [], '--help prints usage and does nothing else');
  await assert.rejects(() => main(['--bogus']), /Unknown argument/, 'typo-ed flags are rejected');
  await assert.rejects(() => main(['--account']), /Missing value/, 'a flag without its value is rejected');

  assert.strictEqual(unhandled, 0, 'no unhandled rejections');
  console.log('\nVIRTUAL TEST: PASS');
  process.exitCode = 0;
} catch (err) {
  console.log('\nVIRTUAL TEST: FAIL —', err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
