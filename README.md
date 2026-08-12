# Rally

Rally is a static React scheduling app. GitHub Pages hosts the client, while a Cloudflare Worker provides the API. Polls are stored in Workers KV, and SQLite-backed Durable Objects coordinate participant responses and optional organizer accounts.

## Local development

Edit `rally.config.json`, then run the static client with the JSON-file Express API:

```sh
npm install
npm run dev
```

Run `npm run config:check` after changing instance settings. The schema reference in
`rally.config.json` also provides validation and completion in supporting editors.

## Instance administration

Rally deliberately has no in-app administrator account or console. Repository maintainers
administer an instance by reviewing and committing `rally.config.json`. Git history provides the
audit trail; protecting the default branch and requiring pull-request review is recommended for
production instances.

The committed configuration contains public settings only:

| Setting | Purpose |
| --- | --- |
| `site` | Instance name, page metadata, and browser theme color |
| `deployment.workerName` | Cloudflare Worker service name |
| `deployment.apiBaseUrl` | HTTPS Worker URL used by the GitHub Pages client |
| `deployment.allowedOrigins` | Exact HTTPS browser origins allowed by Worker CORS |
| `accounts.mode` | `disabled`, `optional`, or `required` for poll creation |
| `accounts.registration` | `open` or `closed` self-service registration |
| `polls.maxDates` | Positive date limit, or `null` for no limit |
| `polls.maxResponses` | Positive response limit per poll |

When accounts are disabled, registration must be closed. In required mode, visitors must sign in
before creating a poll. Closing registration does not prevent existing accounts from signing in.
These policies are enforced by both APIs; the client only adapts the visible controls.

Never put credentials, tokens, namespace IDs, or other secrets in `rally.config.json`. The public
configuration is bundled into both deployments, and the non-deployment portion is available from
`GET /api/config`.

Before deployment, the workflow inspects Cloudflare's current Worker bindings. An existing instance
must keep the Worker already bound to its KV namespace because deploying under another name would
create fresh Durable Object namespaces and strand organizer accounts. For a new namespace, every
deployment converges on the same Worker name derived from a one-way hash of the namespace ID. If the
configured name differs, the workflow reports the required name; update both `deployment.workerName`
and `deployment.apiBaseUrl`, then rerun it. Moving an existing instance to a new Worker requires an
explicit account and Durable Object migration that Rally does not automate.

## Deployment setup

1. In Cloudflare **Workers & Pages**, register the account's one-time `workers.dev` subdomain.
2. Create a Workers KV namespace and copy its 32-character namespace ID.
3. In Cloudflare **Manage Account > Account API Tokens**, create a token from the **Edit Cloudflare Workers** template. Scope it to the deployment account. A custom token needs **Workers Scripts Write/Edit** and **Account Settings Read**.
4. Add GitHub Actions repository secrets named `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_KV_NAMESPACE_ID`.
5. Edit `rally.config.json`. Set the GitHub Pages and custom-domain origins, branding, and instance policies. Existing instances must retain their Worker name and URL.
6. Run `npm ci`, `npm run config:check`, and `npm test` locally.
7. Run **Deploy Cloudflare Worker**. For a fresh namespace, use the hash-derived Worker name reported by the first run to update `deployment.workerName` and its expected `https://<worker>.<subdomain>.workers.dev` URL, then rerun the workflow. It generates Wrangler configuration from the public config plus the KV secret and provisions the Durable Object namespaces.
8. Confirm the published Worker URL matches `deployment.apiBaseUrl`.
9. In repository Pages settings, choose **GitHub Actions** as the source, then run **Deploy GitHub Pages**.

No GitHub Actions repository variables are required. A custom Pages domain must also appear as an
exact origin in `deployment.allowedOrigins` before the Worker is redeployed. When public settings or
the API URL change, the Pages workflow waits until the deployed Worker reports the committed settings;
it will not publish a client ahead of a failed or pending Worker deployment.

Shared poll and account URLs use hash routing, such as `https://rally.quintelier.dev/#/p/abc123` and `https://rally.quintelier.dev/#/account`, so opening or refreshing them works on GitHub Pages. The static client sends account sessions to the cross-origin Worker as bearer tokens, so authentication does not depend on server-rendered routes or same-origin cookies.

## Managing polls

Creating a poll opens its private organizer page and adds it to **My polls** in that browser. Organizers can edit details and date options, close or reopen responses, copy the public invite, and permanently delete the poll. Registration is optional: signed-in organizers also see their account-owned polls after signing in on another browser.

For anonymous organizers, the management link contains a private organizer token in its URL hash. Anyone with that link can manage the poll, so keep a copy and share it only with trusted co-organizers. Signing in or registering claims anonymous polls already saved in that browser, after which account access no longer requires the management link. Clearing browser storage before a poll is claimed removes it from **My polls**, but a saved management link restores access. Polls created before organizer tokens were introduced cannot be managed.

## Persistence model

Workers KV stores poll definitions and a separate backup record for each participant response. A per-poll Durable Object is the strongly consistent response coordinator, so participants in different browser sessions see each other's updates without relying on eventually consistent KV key listings. Existing KV response records are merged into the coordinator as they become visible, preserving responses created before the Durable Object migration.

Each organizer account has its own Durable Object, which stores the account's poll index and authentication records. Passwords are stored as PBKDF2-SHA-256 hashes with random salts; the Worker uses Cloudflare's enforced maximum of 100,000 iterations, while the local Express API uses 310,000 iterations. Session secrets are also hashed at rest. Registration and sign-in attempts are rate limited, and each account retains at most 10 active sessions. The browser keeps only the opaque session token in tab-scoped session storage. The local Express API follows the same storage model in its JSON data files.

While a poll is open, the client refreshes shared results every five seconds in a visible tab and when the tab regains focus. Background refreshes do not replace unsaved name or vote edits.

Responses created by the earlier JSON-file implementation remain visible locally, but their public participant IDs cannot safely authorize edits. Those participants must submit again to receive a private edit token.