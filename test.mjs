import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from './action.mjs';

const request_id = '12345678-1234-4234-8234-123456789abc';
const asset = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/studio-images/synthetic/test.png?token=fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WlM0AAAAASUVORK5CYII=', 'base64');
const env = async overrides => ({
  GITHUB_WORKSPACE: await mkdtemp(join(tmpdir(), 'cormak-image-')),
  CORMAK_API_KEY: 'cmcp_a_' + 'x'.repeat(43), INPUT_REQUEST_ID: request_id,
  INPUT_ALLOW_PAID: 'true', INPUT_MAX_CREDITS: '3', INPUT_PROMPT: 'A lamp against a dark backdrop',
  INPUT_MODEL: 'seedream', INPUT_QUALITY: 'high', INPUT_ASPECT_RATIO: '16:9', ...overrides,
});
const silence = () => {};
const image = (overrides = {}) => ({ request_id, status: 'complete', mime_type: 'image/png', url: asset, credits_charged: 3, ...overrides });
const json = Response.json;

test('Quote selected model, retry one identical dispatch, poll, and save verified PNG without sending bearer to storage', async () => {
  const inputs = await env();
  const requests = [];
  const result = await execute({ env: inputs, log: silence, pause: silence, fetcher: async (url, opts) => {
    if (url === asset) {
      assert.equal(opts.headers.Authorization, undefined);
      assert.equal(opts.redirect, 'error');
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    assert.equal(url, 'https://mcp.cormak.app/store');
    const body = JSON.parse(opts.body); requests.push(body);
    switch (requests.length) {
      case 1: return json({ can_pay_images: true, prices: { images: { seedream: { high: 3 } } } });
      case 2: assert.deepEqual(body, { action: 'image_start', request_id, mode: 'prompt', prompt: inputs.INPUT_PROMPT,
        model: 'seedream', quality: 'high', aspect_ratio: '16:9', expected_credits: 3, use_free_photo: false });
        throw new Error('response lost');
      case 3: assert.deepEqual(body, requests[1]); return json({ request_id, status: 'running', credits_max: 3 }, { status: 202 });
      case 4: assert.deepEqual(body, { action: 'image_status', request_ids: [request_id] });
        return json({ images: [image({ status: 'running' })] });
      case 5: return json({ images: [image()] });
      default: throw new Error('unexpected call');
    }
  } });
  assert.deepEqual(result, { request_id, status: 'complete', output_path: 'generated/image.png', credits_charged: 3 });
  assert.deepEqual(await readFile(join(inputs.GITHUB_WORKSPACE, result.output_path)), png);
});

test('Resume is read only; never resubmit an unknown outcome', async () => {
  const inputs = await env({ INPUT_RESUME_ONLY: 'true', INPUT_ALLOW_PAID: 'false' });
  const requests = [];
  await assert.rejects(execute({ env: inputs, log: silence, fetcher: async (_url, opts) => {
    requests.push(JSON.parse(opts.body));
    return json({ images: [image({ status: 'unknown' })] });
  } }), /image_generation_unknown/);
  assert.deepEqual(requests, [{ action: 'image_status', request_ids: [request_id] }]);
});
test('Reject external result URLs and mislabeled bytes', async () => {
  const inputs = await env({ INPUT_RESUME_ONLY: 'true' });
  await assert.rejects(execute({ env: inputs, log: silence, fetcher: async url => {
    assert.equal(url, 'https://mcp.cormak.app/store');
    return json({ images: [image({ url: 'https://example.org/asset.png' })] });
  } }), /invalid_image_url/);
  await assert.rejects(execute({ env: inputs, log: silence, fetcher: async url => url === asset
    ? new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/png' } })
    : json({ images: [image()] }) }), /invalid_image_type/);
});

test('Reject a symlinked output directory before contacting the API', async () => {
  const inputs = await env();
  const other = join(inputs.GITHUB_WORKSPACE, 'other');
  await mkdir(other);
  await symlink(other, join(inputs.GITHUB_WORKSPACE, 'generated'), 'dir');
  await assert.rejects(execute({ env: inputs, log: silence, fetcher: () => assert.fail('no network') }), /unsafe_workspace_path/);
});
