import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { authorize } from './oauth.mjs';

const client = '12345678-1234-4234-8234-123456789abc';
const fixture = prefix => prefix + 'x'.repeat(43);

test('OAuth checks loopback state and exchanges a PKCE-bound code without exposing tokens', async () => {
  let browser;
  let query;
  let count = 0;
  const scopes = ['store:use'];
  const result = await authorize({
    name: 'Cormak Test', scopes, port: 0,
    show: (url, id) => {
      assert.equal(id, client);
      query = new URL(url).searchParams;
      browser = (async () => {
        const cb = new URL(query.get('redirect_uri'));
        const code = fixture('cmcp_c_');
        cb.searchParams.set('code', code);
        cb.searchParams.set('state', 'invalid');
        assert.equal((await fetch(cb)).status, 400);
        cb.searchParams.set('state', query.get('state'));
        const response = await fetch(cb);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /cmcp_/);
      })();
    },
    fetcher: async (url, config) => {
      assert.equal(config.redirect, 'error');
      if (++count === 1) {
        assert.equal(url, 'https://mcp.cormak.app/mcp/register');
        assert.match(JSON.parse(config.body).redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return Response.json({ client_id: client });
      }
      assert.equal(url, 'https://mcp.cormak.app/mcp/token');
      assert.equal(config.body.get('client_id'), client);
      assert.equal(config.body.get('code'), fixture('cmcp_c_'));
      assert.equal(query.get('scope'), 'store:use');
      assert.equal(createHash('sha256').update(config.body.get('code_verifier')).digest('base64url'), query.get('code_challenge'));
      return Response.json({ access_token: fixture('cmcp_a_'), refresh_token: fixture('cmcp_r_'), token_type: 'Bearer',
        expires_in: 3600, scope: 'store:use' });
    },
  });
  await browser;
  assert.equal(count, 2);
  assert.deepEqual(result, { access: fixture('cmcp_a_'), expiresIn: 3600, client });
});
