# Rally

Rally is a static React scheduling app. GitHub Pages hosts the client, while a Cloudflare Worker provides the API. Polls are stored in Workers KV, and SQLite-backed Durable Objects coordinate participant responses and optional organizer accounts.

## Local development

Use the JSON-file Express API:

```sh
npm install
npm run dev
```

## Deployment setup

1. In Cloudflare **Workers & Pages**, register the account's one-time `workers.dev` subdomain. The deployed API URL will use this account-wide name.
2. Create a Workers KV namespace in Cloudflare and copy its 32-character namespace ID.
3. In Cloudflare **Manage Account > Account API Tokens**, create a token from the **Edit Cloudflare Workers** template. Scope its account resources to the same account whose ID you copy. A custom token must include at least **Workers Scripts Write/Edit**, **Workers KV Storage Write/Edit**, and **Account Settings Read** for that account.
4. Add GitHub Actions repository secrets named `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_KV_NAMESPACE_ID`.
5. Keep the KV namespace name for your own reference; deployment only needs its 32-character namespace ID.
6. Run the **Deploy Cloudflare Worker** workflow once. Wrangler provisions the poll and account Durable Object namespaces during this deployment; copy the Worker URL from the job summary.
7. Add that HTTPS URL as the GitHub Actions variable `VITE_API_BASE_URL`.
8. In the repository Pages settings, choose **GitHub Actions** as the source, then run **Deploy GitHub Pages**.

Optional repository variables:

- `MAX_POLL_DATES`: a positive integer, `0`, `none`, or `unlimited`; defaults to unlimited.
- `MAX_POLL_RESPONSES`: a positive integer; defaults to 100 to bound API work and response size.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the API. Include the Pages custom-domain origin when one is configured; it defaults to the repository owner's `github.io` origin during deployment.

Shared poll and account URLs use hash routing, such as `https://rally.quintelier.dev/#/p/abc123` and `https://rally.quintelier.dev/#/account`, so opening or refreshing them works on GitHub Pages. The static client sends account sessions to the cross-origin Worker as bearer tokens, so authentication does not depend on server-rendered routes or same-origin cookies.

## Managing polls

Creating a poll opens its private organizer page and adds it to **My polls** in that browser. Organizers can edit details and date options, close or reopen responses, copy the public invite, and permanently delete the poll. Registration is optional: signed-in organizers also see their account-owned polls after signing in on another browser.

For anonymous organizers, the management link contains a private organizer token in its URL hash. Anyone with that link can manage the poll, so keep a copy and share it only with trusted co-organizers. Signing in or registering claims anonymous polls already saved in that browser, after which account access no longer requires the management link. Clearing browser storage before a poll is claimed removes it from **My polls**, but a saved management link restores access. Polls created before organizer tokens were introduced cannot be managed.

## Persistence model

Workers KV stores poll definitions and a separate backup record for each participant response. A per-poll Durable Object is the strongly consistent response coordinator, so participants in different browser sessions see each other's updates without relying on eventually consistent KV key listings. Existing KV response records are merged into the coordinator as they become visible, preserving responses created before the Durable Object migration.

Each organizer account has its own Durable Object, which stores the account's poll index and authentication records. Passwords are stored as PBKDF2-SHA-256 hashes with random salts; the Worker uses Cloudflare's enforced maximum of 100,000 iterations, while the local Express API uses 310,000 iterations. Session secrets are also hashed at rest. Registration and sign-in attempts are rate limited, and each account retains at most 10 active sessions. The browser keeps only the opaque session token in tab-scoped session storage. The local Express API follows the same storage model in its JSON data files.

While a poll is open, the client refreshes shared results every five seconds in a visible tab and when the tab regains focus. Background refreshes do not replace unsaved name or vote edits.

Responses created by the earlier JSON-file implementation remain visible locally, but their public participant IDs cannot safely authorize edits. Those participants must submit again to receive a private edit token.