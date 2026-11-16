import { appendFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const origin = 'https://mcp.cormak.app';
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const accessToken = /^cmcp_a_[A-Za-z0-9_-]{43}$/;
const secretPattern = /(?:cmcp_[arc]_[\w-]{30,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[\w]{30,}|-----BEGIN [^\n]*PRIVATE KEY-----|(?:api[_ -]?key|secret|password|access[_ -]?token)\s*[:=]\s*["']?[A-Za-z0-9_+/.-]{20,})/i;
export class Problem extends Error {
  constructor(code, retry = false) { super(code); this.retry = retry; }
}
export function plain(value, min = 1, max = 120_000) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max && !value.includes('\0');
}
export function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }

export async function bounded(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw new Problem('invalid_response');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > limit) throw new Problem('invalid_response');
      chunks.push(value);
    }
  } finally {
    // Also abort oversized or partial downloads.
    await reader.cancel().catch(() => {});
  }
}

const serverErrors = new Set(['ai_consent_required', 'content_blocked', 'idempotency_conflict', 'image_quote_changed',
  'quote_changed', 'limit_reached', 'insufficient_credits', 'permission_denied', 'operation_not_found',
  'access_revoked', 'result_unknown', 'account_unavailable', 'rate_limit_reached', 'free_photo_model',
  'generation_limit_reached', 'generation_not_found', 'approval_expired', 'approval_rejected', 'connection_limit_reached']);
export function apiError(code) {
  return new Problem(serverErrors.has(code) ? code : 'cormak_request_failed', code === 'rate_limit_reached');
}

export function createClient(token, fetcher, signal, deadline) {
  return async function post(route, data, headers = {}, sse = false) {
    if (!['/blog', '/store', '/mcp'].includes(route)) throw new Problem('invalid_endpoint');
    let res;
    try {
      res = await fetcher(origin + route, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
        body: JSON.stringify(data),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(deadline - Date.now(), 110_000)))]),
      });
    } catch { throw new Problem('network_or_timeout', true); }
    if (res.status === 401) throw new Problem('oauth_token_expired_or_invalid');
    if (res.status === 403) throw new Problem('permission_denied');
    if (res.status === 429) throw new Problem('rate_limit_reached', true);
    if (res.status >= 500) throw new Problem('cormak_unavailable', [502, 503, 504].includes(res.status));
    if (res.status === 202 && (data.method === 'notifications/initialized')) return null;
    let payload;
    try {
      const body = (await bounded(res, 512_000)).toString('utf8');
      if (sse && res.headers.get('content-type')?.includes('text/event-stream')) {
        for (const event of body.split(/\r?\n\r?\n/)) {
          const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
          if (!lines.length) continue;
          const frame = JSON.parse(lines.map(line => line.slice(5).trimStart()).join('\n'));
          if (frame?.id === data.id) { payload = frame; break; }
        }
      } else payload = JSON.parse(body);
    } catch { throw new Problem('invalid_response', true); }
    if (!record(payload)) throw new Problem('invalid_response');
    if (typeof payload.error === 'string') throw apiError(payload.error);
    if (!res.ok) throw new Problem('cormak_http_' + res.status);
    return payload;
  };
}

async function location(pathname, root, prefix, exts, create) {
  if (typeof pathname !== 'string' || pathname.length > 200 || !pathname.startsWith(prefix + '/') ||
      !pathname.split('/').every(part => /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(part) && !part.endsWith('.')) ||
      !exts.includes(path.extname(pathname))) throw new Problem('invalid_workspace_path');
  const directory = await realpath(root);
  const parts = pathname.split('/');
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (create) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(current).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Problem('unsafe_workspace_path');
  }
  return path.join(current, parts.at(-1));
}

export function rejectSecrets(value, token) {
  // This is a backstop. Send only explicitly reviewed material to Cormak.
  if (secretPattern.test(value) || (token && value.includes(token))) throw new Problem('possible_secret_detected');
}
export async function readContext(name, root, token) {
  const file = await location(name, root, 'docs-input', ['.md', '.txt'], false);
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 20_000) throw new Problem('invalid_context_file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(20_001);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) throw new Problem('invalid_context_file');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
    if (!plain(value, 1, 5_500)) throw new Problem('invalid_context_file');
    rejectSecrets(value, token);
    return value;
  } finally { await handle.close(); }
}

export async function run(action, { env = process.env, fetcher = fetch, log = console.log, pause = sleep } = {}) {
  const input = (key, fallback = '') => (env['INPUT_' + key.toUpperCase()] || fallback).trim();
  const select = (key, choices, fallback) => {
    const value = input(key, fallback);
    if (!choices.includes(value)) throw new Problem('invalid_' + key);
    return value;
  };
  const token = env.CORMAK_API_KEY;
  const checkText = (key, min, max, fallback = '') => {
    const value = input(key, fallback);
    if (!plain(value, min, max) && !(min === 0 && value === '')) throw new Problem('invalid_' + key);
    rejectSecrets(value, token);
    return value;
  };
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const requestId = input('request_id').toLowerCase();
  if (!accessToken.test(token || '')) throw new Problem('missing_or_invalid_oauth_token');
  if (!uuid.test(requestId)) throw new Problem('invalid_request_id');
  const resume = action.canResume && select('resume_only', ['true', 'false'], 'false') === 'true';
  if (!resume && select('allow_paid', ['true', 'false'], 'false') !== 'true') throw new Problem('paid_run_disabled');
  const output = input('output_path', action.file);
  const target = await location(output, root, 'generated', action.extensions, true);
  for (const suffix of action.suffixes ?? ['']) {
    if (await lstat(target + suffix).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      throw new Problem('output_already_exists');
    }
  }
  const deadline = Date.now() + 6 * 60_000;
  const signal = AbortSignal.timeout(6 * 60_000);
  const post = createClient(token, fetcher, signal, deadline);
  const poll = async (call, done, delay = 5_000) => {
    while (Date.now() < deadline) {
      try {
        const value = await call();
        if (done(value)) return value;
      } catch (error) {
        if (!(error instanceof Problem) || !error.retry) throw error;
        if (error.message === 'rate_limit_reached') {
          const wait = Math.min(deadline - Date.now(), 60_000);
          if (wait > 0) await pause(wait);
          continue;
        }
      }
      const wait = Math.min(deadline - Date.now(), delay);
      if (wait > 0) await pause(wait);
    }
    throw new Problem('poll_timed_out_reuse_request_id');
  };
  const ceiling = () => {
    const raw = input('max_credits');
    if (!/^(?:0|[1-9]\d?)$/.test(raw)) throw new Problem('invalid_max_credits');
    return Number(raw);
  };
  log('Cormak request: ' + requestId);
  const result = await action.execute({ input, select, text: checkText, ceiling, poll, post, requestId, root, token, fetcher, signal, resume });
  const outputs = { request_id: requestId, status: result.status };
  if (result.status === 'awaiting_confirmation') {
    if (!/^https:\/\/app\.cormak\.app\/mcp\?approval_id=[a-f0-9-]{36}$/i.test(result.approvalUrl ?? '')) {
      throw new Problem('invalid_approval_link');
    }
    outputs.approval_url = result.approvalUrl;
    log('Approve in your Cormak connection dashboard, then rerun with the same request ID. No file was written.');
  } else {
    if (result.status !== 'complete') throw new Problem('invalid_response');
    if (typeof result.bytes === 'string') rejectSecrets(result.bytes, token);
    const suffix = result.suffix ?? '';
    if (!(action.suffixes ?? ['']).includes(suffix)) throw new Problem('invalid_output_type');
    const handle = await open(target + suffix, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(result.bytes); } finally { await handle.close(); }
    outputs.output_path = output + suffix;
    if (Number.isSafeInteger(result.credits) && result.credits >= 0) outputs.credits_charged = result.credits;
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''));
  return outputs;
}

export async function main(action) {
  try { await run(action); }
  catch (error) {
    // No upstream messages, prompts, headers, signed URLs or stack traces.
    const code = error instanceof Problem ? error.message : 'action_failed';
    console.error('Cormak: ' + code + '. If work may have started, reuse the same request ID and inputs.');
    process.exitCode = 1;
  }
}
