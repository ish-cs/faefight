# CI, preview links and targeted e2e (for agents)

## CI (GitHub Actions, `.github/workflows/ci.yml`)

Runs on every push to `main`, every PR to `main`, and every push to a branch under `ci/`.

- `unit`: `pnpm install` (cached), `tsc --noEmit`, `vite build`, `vitest`.
- `e2e`: Playwright in 4 parallel shards (`--shard i/4`). On failure each shard uploads
  `playwright-report-shard-<i>` (HTML report + traces): `gh run download <run-id> --repo ish-cs/faefight`.
- Linux runners have no GPU. With `CI` set, `playwright.config.ts` launches Chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`; WebGPU isn't available there, so three's
  `WebGPURenderer` falls back to WebGL2 on SwiftShader. Locally (no `CI`) nothing changes: real GPU, WebGPU.
- A newer push to the same ref cancels the running workflow; every job times out after 20 min.

To get a CI run before asking the steward to merge: push your work to a `ci/<name>` branch
(`git push origin HEAD:ci/<name>`), then `gh run watch --repo ish-cs/faefight` /
`gh run view <id> --log-failed --repo ish-cs/faefight`. **`main` only advances when CI is green.**

Reproduce the CI environment locally (Linux, no GPU) with Docker/OrbStack:

```bash
docker run --rm -v "$PWD":/src:ro mcr.microsoft.com/playwright:v1.65.1-noble bash -c '
  mkdir /work && cd /src && tar --exclude=./node_modules -cf - . | tar -xf - -C /work && cd /work &&
  npm i -g pnpm@9.15.9 >/dev/null && pnpm install --frozen-lockfile >/dev/null && CI=1 pnpm exec playwright test'
```

## Preview links (Vercel)

```bash
url=$(scripts/preview.sh | tail -1)   # or: pnpm preview:deploy
```

Deploys the current checkout (uncommitted changes included) as a **preview** deployment, never
production, and prints its URL as the last line. A worktree without `.vercel/` gets it copied from
the main checkout; `.vercel/` is gitignored and must never be committed. Needs the Vercel CLI logged in
(`vercel whoami`). Preview URLs sit behind Vercel deployment protection: open them logged in to Vercel,
or make a shareable link with the Vercel MCP `get_access_to_vercel_url` tool. Put the URL in your
handoff so the reviewer can play the branch.

## Targeted e2e

```bash
pnpm e2e:changed --dry   # which specs, and why
pnpm e2e:changed         # run them (still take the shared /tmp/faefight-heavy.lock first)
```

Maps `git diff --name-only main...HEAD` (plus uncommitted files) to specs with a path/keyword table in
`scripts/e2e-changed.mjs`. Core files (`main.ts`, `render.ts`, sim loop, config, deps) or anything not in
the table run the full suite; docs and unit-test-only changes run nothing but `smoke`. Add a row to the
table when you add a spec. Before a merge the full suite still runs in CI.
