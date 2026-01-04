# ccenv

![Demo](assets/demo.gif)

Claude Code Environment Manager. `ccenv` lets you swap logical working states in a single Git checkout without worktrees.

## Requirements

- Bun v1.1+
- Git
- tar

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/masudahiroto/ccenv/main/install.sh | bash
```

Or manually clone the repo and run via Bun:

```sh
bun ./src/ccenv.ts --help
```

Optional: add a shell alias:

```sh
alias ccenv="bun /path/to/ccenv/src/ccenv.ts"
```

## Usage

Create and use an environment:

```sh
ccenv create feature-a
ccenv enter feature-a
# ...make changes...
ccenv exit
```

Activate for convenience:

```sh
eval "$(ccenv activate feature-a)"
ccenv enter
```

Run a one-off command inside an environment:

```sh
ccenv run --env feature-a sh -c "echo hello > example.txt"
```

Apply environment changes onto the current workspace:

```sh
ccenv apply feature-a
```

## How it works

`ccenv` snapshots Git state into `.ccenv/envs/<name>`:

- `staged.patch` for staged changes
- `unstaged.patch` for unstaged changes
- `untracked.tar.gz` for untracked files
- `info.json` for metadata

`enter` stores the current workspace as `default`, cleans the tree, and restores the target env.  
`exit` saves the env, cleans the tree, and restores `default`.

## Tests

```sh
bun test
```

## Notes

- `.ccenv/` is untracked by default. Avoid storing other data inside it.
