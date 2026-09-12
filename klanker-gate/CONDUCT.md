# Conduct and Contribution Quickstart

This file collects the practical contribution and collaboration rules for Frosty
Deno. Community behavior expectations still apply through the separate
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## How you can contribute

- Report bugs through the forms in
  [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).
- Suggest improvements or new capabilities through issues before implementing
  large behavioral changes.
- Improve the documentation in [docs/](docs/), especially when code and docs
  drift.
- Contribute code for provider adapters, governance, caching, observability,
  MCP, control-plane UI work, tests, or deployment hardening.

## Development setup

Detailed tutorials live under [docs/getting-started/](docs/getting-started/).
The shortest verified setup is:

```bash
git clone <your-fork-url> klanker-gate
cd klanker-gate
deno task setup
cp .env.example .env
docker compose up -d postgres
deno task dev
```

Important repo-specific notes:

- Deno 2.9.x is the primary toolchain.
- The gateway and control UI are driven through Deno, not the npm CLI.
- PostgreSQL is a hard dependency on the production bootstrap path.
- `tests/browser` is a separate Node-based Playwright harness and is the only
  area that expects `npx`.

## Submission guidelines

- Branches should follow `feature/<name>` or `bugfix/<name>`.
- Commits should follow
  [Conventional Commits](https://www.conventionalcommits.org/).
- Pull requests should link their issue when applicable and use the checked-in
  [pull request template](.github/pull_request_template.md).
- Run the validation gate locally before opening the PR:

```bash
deno fmt --check
deno lint
deno task check
deno task test
deno task check-ui
deno task test-ui
deno task build-ui
```

- If the change affects dependencies, regenerate the SBOM with
  `deno run -A scripts/generate_sbom.ts`.
- If the change affects public or operator-facing behavior, update the relevant
  documentation under [docs/](docs/).

## Coding standards

- Preserve the canonical error envelope and shared request/response contracts.
- Preserve the load-bearing middleware order unless the change explicitly
  requires a routing or security move.
- Keep same-origin control-plane assumptions intact.
- Follow [apps/control-ui/CONVENTIONS.md](apps/control-ui/CONVENTIONS.md) for UI
  work.
