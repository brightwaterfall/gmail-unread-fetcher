import { EventEmitter } from 'node:events';

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

const MESSAGES = {
  'msg-1': fakeMessage('msg-1', ['receipt.pdf']),
  // duplicate names plus two hostile ones: a traversal attempt and a Windows device name
  'msg-2': fakeMessage('msg-2', ['scan.pdf', 'scan.pdf', '../escape.pdf', 'CON.txt']),
};
const BROKEN_ID = 'msg-broken';

/** Shared so mock-test.js can assert mark-read behaviour. */
export const modifyCalls = [];
export { ATT_BYTES, BROKEN_ID };

class FakeOAuth2 extends EventEmitter {
  setCredentials(tokens) {
    this.credentials = tokens;
  }
  generateAuthUrl() {
    return 'https://example.invalid/auth';
  }
  async getToken() {
    return { tokens: { access_token: 't', refresh_token: 'r' } };
  }
}

function fakeGmail({ auth }) {
  const account = auth.credentials.account;
  return {
    users: {
      async getProfile() {
        return { data: { emailAddress: `${account}@example.com` } };
      },
      messages: {
        async list({ pageToken }) {
          if (!pageToken) return { data: { messages: [{ id: 'msg-1' }], nextPageToken: 'p2' } };
          return { data: { messages: [{ id: 'msg-2' }, { id: BROKEN_ID }] } };
        },
        async get({ id }) {
          if (id === BROKEN_ID) throw new Error('simulated API failure');
          return { data: MESSAGES[id] };
        },
        async modify(opts) {
          modifyCalls.push({ account, ...opts });
          return { data: {} };
        },
        attachments: {
          async get() {
            return { data: { data: b64url(ATT_BYTES) } };
          },
        },
      },
    },
  };
}

export const google = {
  auth: { OAuth2: FakeOAuth2 },
  gmail: fakeGmail,
};
