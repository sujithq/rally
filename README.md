# Rally

Rally is a static React scheduling app. GitHub Pages hosts the client, while a Cloudflare Worker provides the API. Polls are stored in Workers KV and participant responses are coordinated by SQLite-backed Durable Objects.

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
6. Run the **Deploy Cloudflare Worker** workflow once. Wrangler provisions the Durable Object namespace during this deployment; copy the Worker URL from the job summary.
7. Add that HTTPS URL as the GitHub Actions variable `VITE_API_BASE_URL`.
8. In the repository Pages settings, choose **GitHub Actions** as the source, then run **Deploy GitHub Pages**.

Optional repository variables:

- `MAX_POLL_DATES`: a positive integer, `0`, `none`, or `unlimited`; defaults to unlimited.
- `MAX_POLL_RESPONSES`: a positive integer; defaults to 100 to bound API work and response size.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the API. It defaults to the repository owner's `github.io` origin during deployment.

Shared poll URLs use hash routing, such as `https://quintelier.dev/doodle2/#/p/abc123`, so opening or refreshing a poll works on GitHub Pages.

## Persistence model

Workers KV stores poll definitions and a separate backup record for each participant response. A per-poll Durable Object is the strongly consistent response coordinator, so participants in different browser sessions see each other's updates without relying on eventually consistent KV key listings. Existing KV response records are merged into the coordinator as they become visible, preserving responses created before the Durable Object migration.

While a poll is open, the client refreshes shared results every five seconds in a visible tab and when the tab regains focus. Background refreshes do not replace unsaved name or vote edits.

Responses created by the earlier JSON-file implementation remain visible locally, but their public participant IDs cannot safely authorize edits. Those participants must submit again to receive a private edit token.