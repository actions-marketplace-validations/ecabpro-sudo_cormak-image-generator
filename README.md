# Cormak Image Generator

Create a single image from a text prompt in GitHub Actions. Use Cormak's
existing Store API to pick a model, aspect ratio and quality, then save the
returned PNG, JPEG or WebP. Designed for reviewed static site assets. Runs on
Node 24 without runtime packages.

**Release candidate:** use the checked-in mock tests while the repository and
Marketplace listing are being prepared.

Follow [the OAuth connection guide](CONNECTION.md) and allow `store:use`.
Use the [workflow example](examples/image.yml) and [static demo](demo/README.md).

| Input | Purpose |
| --- | --- |
| `prompt` | Text prompt, 3–1,500 characters. |
| `model` | `nano2` (default), `nano-pro`, `seedream`, or `nano`. |
| `quality` | `standard` (default) or `high`. The selected model determines the effect. |
| `aspect_ratio` | `1:1`, `3:4`, `4:3`, `16:9`, or `9:16`. |
| `request_id`, `allow_paid`, `max_credits` | Stable UUID, explicit opt-in, and ceiling for a new request. |
| `output_path` | New file stem below `generated/`; the extension comes from the validated image. |
| `resume_only` | Set to `true` to poll and download an existing request without starting generation. |

Outputs: `request_id`, `status`, `output_path`, and `credits_charged` if
returned. The Action reads the model's current price and submits the exact
quote. The account must be eligible for paid Store images; the one-time trial
is not used. The Store scopes receipts to the connection. If download fails
or the quote changed, use `resume_only: "true"` with the original UUID to
retrieve a fresh signed result URL. The workflow never prints that URL, sends
the bearer token to object storage, or accepts SVG or arbitrary file types.

Run offline tests: `node --test test.mjs oauth.test.mjs`.
