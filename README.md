# Rally

Rally is a static React scheduling app. GitHub Pages hosts the client, while a Cloudflare Worker provides the API and stores polls and participant responses in Workers KV.

## Local development

Use the JSON-file Express API:

```sh
npm install
npm run dev
```

## Deployment setup

1. Create a Workers KV namespace in Cloudflare and copy its 32-character namespace ID.
2. Create a Cloudflare API token that can edit Workers scripts. Copy the Cloudflare account ID as well.
3. Add GitHub Actions repository secrets named `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_KV_NAMESPACE_ID`.
4. Keep the KV namespace name for your own reference; deployment only needs its 32-character namespace ID.
5. Run the **Deploy Cloudflare Worker** workflow once and copy the Worker URL from its job summary.
6. Add that HTTPS URL as the GitHub Actions variable `VITE_API_BASE_URL`.
7. In the repository Pages settings, choose **GitHub Actions** as the source, then run **Deploy GitHub Pages**.

Optional repository variables:

- `MAX_POLL_DATES`: a positive integer, `0`, `none`, or `unlimited`; defaults to unlimited.
- `MAX_POLL_RESPONSES`: a positive integer; defaults to 100 to bound API work and response size.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the API. It defaults to the repository owner's `github.io` origin during deployment.

Shared poll URLs use hash routing, such as `https://sujithq.github.io/doodle2/#/p/abc123`, so opening or refreshing a poll works on GitHub Pages.

## Persistence model

Workers KV is eventually consistent. Rally stores each poll and each participant response under separate keys, preventing concurrent voters from overwriting one another. Compact response metadata lets poll reads use KV key listings instead of one KV read per participant. Newly written data can still take time to appear in reads from another Cloudflare location; use Durable Objects or D1 if globally ordered, strongly consistent updates become necessary.

Responses created by the earlier JSON-file implementation remain visible locally, but their public participant IDs cannot safely authorize edits. Those participants must submit again to receive a private edit token.