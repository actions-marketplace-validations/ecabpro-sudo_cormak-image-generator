# Connect your Cormak account

These Actions use short-lived OAuth access tokens. Cormak does not issue
personal API keys; `CORMAK_API_KEY` is only the GitHub secret name. The browser
sign-in is interactive and the access token normally lasts up to one hour.
Use a separate connection per Action and repository.

1. In the **consumer** repository, create an Actions environment named
   `cormak`. In **Deployment branches and tags**, explicitly allow only the
   protected default branch. Enable a required reviewer where available.
   Restrict who can edit workflows. Do not substitute a repository-wide secret
   if environment protection is unavailable.
2. From this Action's reviewed release checkout, in a private terminal with
   Node 24 and an authenticated [GitHub CLI](https://cli.github.com/), run
   `node connect.mjs OWNER/REPOSITORY`. The repository argument is the
   consumer, where generation runs. The helper binds a loopback callback,
   registers an OAuth client, and prints a temporary browser URL and a
   non-secret client ID. Open the URL on the same computer. Sign in to the
   intended Cormak account, review the listed scopes and set a small nonzero
   generation limit for the connection.
3. The helper sends the access token directly through stdin to
   [`gh secret set`](https://cli.github.com/manual/gh_secret_set) in the
   `cormak` environment. It does not print the token or persist a refresh token.
   The authorized workflow supplies the secret at step scope only.
4. Keep the client ID locally. To replace an expired token, run
   `node connect.mjs OWNER/REPOSITORY EXISTING_CLIENT_ID` on the same callback
   port, using the same Cormak account. Reusing the client and account preserves
   the grant that owns its operation receipts. Do not replay generation on a
   different grant or account without reconciling the original operation.
   Revoke access at [Cormak connections](https://app.cormak.app/mcp).
5. Copy the selected workflow from `examples/`, replace `YOUR_ORG` and
   `REVIEWED_FULL_COMMIT_SHA` after release, and run it from the default branch.
   Generate an operation ID once (e.g. `uuidgen`); keep it with the reviewed
   inputs. A fresh UUID explicitly means a new generation.

The examples are manually triggered and use `contents: read`. Keep generated
files in a review step or a short-lived private artifact. Never run the
secret-bearing job on fork code or use it with `pull_request_target`. Only the
supplied prompt, facts or deliberately selected file should be shared with
Cormak. Files may contain confidential material the credential filter does not
recognize. Treat the output as an untrusted draft; review factual claims and
content before committing, rendering, or sharing an artifact.

A timeout does not cancel cloud work. Reuse the UUID and exact generation
inputs on the same connection; do not make a new UUID to get past a conflict,
unknown state, or a failure after submission. A previously written output path
is never overwritten; use a new draft path if you need to recover the same
result in that checkout.
