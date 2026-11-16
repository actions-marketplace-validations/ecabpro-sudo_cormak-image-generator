import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { accessToken, bounded, origin, uuid, Problem } from './runner.mjs';
const resource = origin + '/mcp';

async function post(fetcher, path, body) {
  const form = body instanceof URLSearchParams;
  const reply = await fetcher(resource + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? body : JSON.stringify(body),
  });
  if (!reply.ok) throw new Problem('oauth_rejected');
  return JSON.parse((await bounded(reply, 32_768)).toString('utf8'));
}

export async function authorize({ name, scopes, port, existingClient = '', show, fetcher = fetch }) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(verifier).digest('base64url');
  let finish, timer;
  const callback = new Promise(resolve => { finish = resolve; });
  let authority = '';
  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, (req, res) => {
    const url = new URL('http://127.0.0.1' + (req.url?.startsWith('/') ? req.url : '/'));
    const received = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    const code = url.searchParams.get('code') ?? '';
    const valid = req.method === 'GET' && req.headers.host === authority && url.pathname === '/callback' &&
      received.length === expected.length && timingSafeEqual(received, expected);
    res.writeHead(valid ? 200 : 400, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end(valid ? 'Return to your terminal.' : 'Invalid authorization callback.');
    if (valid) finish(/^cmcp_c_[A-Za-z0-9_-]{43}$/.test(code) ? code : '');
  });
  server.maxConnections = 12;
  try {
    server.listen({ host: '127.0.0.1', port });
    await once(server, 'listening');
    authority = '127.0.0.1:' + server.address().port;
    const redirect = 'http://' + authority + '/callback';
    const client = existingClient || (await post(fetcher, '/register', {
      client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    })).client_id;
    if (!uuid.test(client ?? '')) throw new Problem('invalid_oauth_client');
    const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, resource,
      scope: scopes.join(' '), state, code_challenge: digest, code_challenge_method: 'S256' });
    timer = setTimeout(() => finish(''), 5 * 60_000);
    show(resource + '/authorize?' + query, client);
    const code = await callback;
    if (!code) throw new Problem('oauth_callback_missing_or_denied');
    const data = await post(fetcher, '/token', new URLSearchParams({
      grant_type: 'authorization_code', client_id: client, redirect_uri: redirect, resource, code, code_verifier: verifier,
    }));
    if (!accessToken.test(data.access_token ?? '') || data.token_type !== 'Bearer' ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 ||
      typeof data.scope !== 'string' || data.scope.split(' ').sort().join(' ') !== [...scopes].sort().join(' ')) {
      throw new Problem('invalid_oauth_response_or_scope');
    }
    // Discard the rotating refresh token. Reauthorization can preserve a grant
    // by using the same client, registered callback, and account.
    return { access: data.access_token, expiresIn: data.expires_in, client };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

async function save(repo, access) {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  delete env.GH_DEBUG;
  delete env.DEBUG;
  delete env.NODE_DEBUG;
  const gh = spawn('gh', ['secret', 'set', 'CORMAK_API_KEY', '--env', 'cormak', '--repo', 'github.com/' + repo], {
    stdio: ['pipe', 'ignore', 'ignore'], env,
  });
  gh.stdin.on('error', () => {});
  gh.stdin.end(access);
  const [code] = await once(gh, 'exit');
  if (code !== 0) throw new Problem('github_secret_write_failed');
}

export async function connect(config, args = process.argv.slice(2)) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error('Run the setup in a private interactive terminal.');
    process.exitCode = 1;
    return;
  }
  const [repo, client = ''] = args;
  if (args.length > 2 || !/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(repo ?? '') ||
    (client && !uuid.test(client))) {
    console.error('Usage: node connect.mjs OWNER/REPOSITORY [EXISTING_CLIENT_ID]');
    process.exitCode = 1;
    return;
  }
  try {
    console.error('This setup stores a short-lived token as CORMAK_API_KEY in the cormak environment of ' + repo + '.');
    const result = await authorize({ ...config, existingClient: client, show: (url, id) => {
      console.error('Keep this non-secret client ID for future sign-ins: ' + id);
      console.error('Open this temporary authorization URL locally and verify the requested scopes:\n' + url);
    } });
    await save(repo, result.access);
    console.error('Secret saved. The token expires in about ' + Math.floor(result.expiresIn / 60) + ' minutes.');
  } catch (error) {
    console.error('Connection setup failed (' + (error instanceof Problem ? error.message : 'local_setup_failed') +
      '). Check your local GitHub CLI login, the protected environment and callback port.');
    process.exitCode = 1;
  }
}
