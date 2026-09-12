# Contributing to Frosty Deno

Thank you for considering a contribution. Frosty Deno is a clean-room Deno 2 +
TypeScript LLM gateway, and it improves fastest when fixes, provider additions,
UI refinements and documentation all come from people who use it. Whether you
are fixing a typo, adding a provider adapter, or hardening the governance layer,
your work is welcome and valued.

## Ways to contribute

- **Report bugs** and **request features** through GitHub Issues using the issue
  forms in [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).
- **Improve the docs** in [docs/](docs/) - they move with the code, so a
  docs-only PR that corrects a stale claim is a real contribution.
- **Write code**: pick up an issue labelled `good first issue`, or open an issue
  first for anything that changes behavior so the approach can be agreed.

## Development setup

Full instructions live in [docs/getting-started/](docs/getting-started/) and
[docs/index.md](docs/index.md). The short version:

```bash
git clone <your-fork-url> klanker-gate
cd klanker-gate
deno task setup        # one-time bootstrap (installs esbuild for the UI build)
cp .env.example .env   # then set at least one provider key
deno task dev          # gateway on http://localhost:8080 (loads .env)
```

There is no `npm` / `node` toolchain. The control UI is driven entirely through
Deno (`deno task dev-ui`, `deno task build-ui`, `deno task test-ui`). Do not
reintroduce an npm CLI step.

## Before you open a pull request

Run the full gate yourself - there is no CI in this repository, so nothing runs
it for you and nothing blocks a pull request that skips it:

```bash
deno fmt --check
deno lint
deno task check        # backend typecheck
deno task test         # unit + contract + integration + e2e
deno task check-ui     # control-UI typecheck
deno task test-ui      # control-UI tests
deno task build-ui     # control-UI production build
```

- **Tests prove the behavior.** A fixed bug must come with a regression test
  that fails on the old code. New behavior needs tests in the matching suite.
- **Record your evidence.** Paste the exact commands you ran and their result in
  the PR. Missing evidence is treated as incomplete, not implied success.
- **Docs move with the code.** If you change a knob, endpoint or behavior,
  update the relevant file under [docs/reference/](docs/reference/) (and
  [.env.example](.env.example) for a new env var). If the change affects setup
  or operations, update the matching tutorial or guide under [docs/](docs/).
- **Check the register.** Deliberate divergences and accepted risks are recorded
  in [TODO.md](TODO.md), which replaced the numbered decision log retired on
  2026-07-30. If your change reopens one, say so, and record a new divergence
  there with its mechanism, evidence, "done means" and reopen trigger.

## Submission guidelines

- **Branches:** `feature/<short-name>` or `bugfix/<short-name>`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), for
  example `fix(gateway): reject empty Azure api-version` or
  `feat(providers): add <vendor> adapter`.
- **Pull requests:** fill out the
  [pull request template](.github/pull_request_template.md), link the issue it
  closes, and keep the change focused.
- **Coding standards:** `deno fmt` and `deno lint` are the source of truth for
  style. The control UI additionally follows
  [apps/control-ui/CONVENTIONS.md](apps/control-ui/CONVENTIONS.md) (design
  system `ds-r2`, `lucide-react` icons only, same-origin only, plain hyphens -
  no em or en dashes).

## Code of conduct

By participating you agree to uphold the standards in [CONDUCT.md](CONDUCT.md).

See also [AGENTS.md](AGENTS.md) for the deeper technical and agent-facing brief.
