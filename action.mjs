import { bounded, Problem, run } from './runner.mjs';

const formats = {
  'image/png': { suffix: '.png', check: data => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { suffix: '.jpg', check: data => data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) },
  'image/webp': { suffix: '.webp', check: data => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' },
};

async function download(row, fetcher, signal) {
  let url;
  try { url = new URL(row.url); } catch { throw new Problem('invalid_image_url'); }
  // Only the canonical signed object route returned by Cormak Store. The
  // GitHub secret is sent solely to Cormak's API, never to object storage.
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
    !/^\/storage\/v1\/object\/sign\/studio-images\/[a-z0-9_./-]+$/i.test(url.pathname) ||
    [...url.searchParams.keys()].join(',') !== 'token' || !url.searchParams.get('token')) throw new Problem('invalid_image_url');
  const format = formats[row.mime_type];
  if (!format || !Object.hasOwn(formats, row.mime_type)) throw new Problem('invalid_image_type');
  let response;
  try {
    response = await fetcher(url.href, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      headers: { Accept: row.mime_type },
    });
  } catch { throw new Problem('image_download_failed_reuse_request_id'); }
  if (!response.ok) throw new Problem('image_download_failed_reuse_request_id');
  if (response.headers.get('content-type')?.split(';')[0].trim() !== row.mime_type) throw new Problem('invalid_image_type');
  const bytes = await bounded(response, 24 * 1024 * 1024);
  if (bytes.length < 16 || !format.check(bytes)) throw new Problem('invalid_image_type');
  return { status: 'complete', suffix: format.suffix, bytes, credits: row.credits_charged };
}

export const action = {
  file: 'generated/image',
  extensions: [''],
  suffixes: ['.png', '.jpg', '.webp'],
  canResume: true,
  async execute({ post, poll, text, select, requestId, ceiling, fetcher, signal, resume }) {
    if (!resume) {
      const model = select('model', ['nano2', 'nano-pro', 'seedream', 'nano'], 'nano2');
      const quality = select('quality', ['standard', 'high'], 'standard');
      const aspect_ratio = select('aspect_ratio', ['1:1', '3:4', '4:3', '16:9', '9:16'], '1:1');
      const prompt = text('prompt', 3, 1500);
      const cap = ceiling();
      const account = await post('/store', { action: 'account' });
      if (account.can_pay_images !== true) throw new Problem('image_account_not_eligible');
      const price = account.prices?.images?.[model]?.[quality];
      if (!Number.isSafeInteger(price) || price < 1 || price > cap) throw new Problem('credit_limit_exceeded');
      const body = { action: 'image_start', request_id: requestId, mode: 'prompt', prompt, model, quality, aspect_ratio, expected_credits: price,
        use_free_photo: false };
      const start = await poll(() => post('/store', body), () => true, 10_000);
      if (start.request_id !== requestId) throw new Problem('invalid_image_receipt');
      if (!['running', 'complete'].includes(start.status)) throw new Problem('image_generation_' +
        (start.status === 'unknown' ? 'unknown' : 'not_complete'));
    }
    const status = await poll(() => post('/store', { action: 'image_status', request_ids: [requestId] }), result => {
      if (result.images?.length !== 1 || result.images[0]?.request_id !== requestId) throw new Problem('invalid_image_receipt');
      return result.images[0].status !== 'running';
    });
    const row = status.images[0];
    if (row.status !== 'complete') {
      const state = ['unknown', 'not_found', 'failed'].includes(row.status) ? row.status : 'not_complete';
      throw new Problem('image_generation_' + state);
    }
    return download(row, fetcher, signal);
  },
};
export const execute = options => run(action, options);
