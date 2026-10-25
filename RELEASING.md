# Releasing abb-rws-daemon

How a version of abb-rws-daemon gets to npm. The steps are written for 0.1.0; a
later version follows them with its own numbers.

The commands are for PowerShell on Windows, the shell the package is published
from. Step 1 says where the shell matters. Run them in the repository's folder.

## The release check

`scripts/release-check.mjs` prints one `ok` or `FAIL` line per check and ends with
status 1 when a check failed.

| Command | When | What it adds |
|---|---|---|
| `node scripts/release-check.mjs` (`npm run release:check`) | any time, and in every CI run | the every-day checks |
| `node scripts/release-check.mjs --release` | step 5, and again by `prepublishOnly` | the release rules |
| `node scripts/release-check.mjs --commits <range>` | before a push | the commits of the range |

The every-day checks:

- **Public content.** Every text file that could be committed is read: the tracked
  files and the untracked ones that are not ignored (a new file counts before it is
  ever added), without `package-lock.json`. It fails on authoring-tool and vendor
  names, attribution trailers, private-range network addresses, machine names,
  Windows profile paths and e-mail addresses. The few texts of those shapes that
  belong here are listed at the top of the script, each with its reason. Everything
  that is private to you alone (the names of your folders, documents and trackers,
  your network, your machines) is not in the script: it is in your private list,
  below, which only you pass.
- **Package sanity.** The `bin` target, the `files` entries, the documents and the
  manifest fields; once `dist/` is built, also that the bin file starts with its
  `#!` line and that every built file still has its source.
- **Consistency.** README names the package version and the snapshot schema version,
  every `abb-rws-daemon@<version>` in it is the package version and no install line
  leaves the version out; CHANGELOG has a section for the version; the schema
  history lists the schema version; the exported schema is up to date. While the
  package version carries a development suffix (`0.2.0-dev`), README may name the
  last released version instead (the newest dated CHANGELOG heading): that is the
  one npm has.

`--deny-file <path>` adds your private list: what must not appear anywhere, one entry
per line. An entry is an exact string (matched whole, in any case: your machine
name, your user name, an address on your network, the name of a private folder or
document) or a regular expression written `/.../` with its flags after the closing
slash (`/(?<![A-Za-z0-9])XK-\d{1,3}(?![A-Za-z0-9])/` for a ticket shape, `/.../i` to
ignore case, `/^.../m` for a line start); a line that starts with `#` is a comment.
Keep that file outside the repository: the check refuses one that is inside and not
ignored. The environment variable `ABB_RWS_RELEASE_DENY_FILE` names it too; the
option wins. A hit is reported as `entry <n>` of the list, never by its text, and a
pattern that does not compile fails the check by its number. Without a list the check
says `no private list given`: that is what CI runs, so the private names are checked
only when you pass the list. Pass it on every run you make yourself.

Before a push, read the commits as well:

```powershell
node scripts/release-check.mjs --commits origin/master..HEAD --deny-file C:\somewhere\private\deny-list.txt
```

(with your own path to the list). A commit's message gets the whole content scan. Its author, committer and
`Signed-off-by` lines are held to the private list and to the tool-name and
attribution rules only: those lines carry a real e-mail address by design.

## What starts a CI run

`.github/workflows/ci.yml` runs on Ubuntu with Node.js 22 and 24. A run starts on:

- a push to `master` or to a branch named `release/...`;
- a push of a tag named `v...`;
- a pull request;
- a manual start (`workflow_dispatch`).

GitHub offers the manual start only for a workflow file that is already on the
default branch. While the workflow file exists only on another branch, get a run by
pushing that branch under a `release/` name or by opening a draft pull request into
`master`.

While `package.json` takes abb-rws-client from the folder beside this one
(`file:../abb-rws-client`), the job checks the client out there at the ref named by
`CLIENT_REF` in the workflow file and builds it. That ref has to exist in the
client's public repository. Once the dependency is a registry range, the job skips
those two steps, and its last step installs the packed tarball globally and runs
`abb-rws-daemon --version`: the proof that the installed command starts on Linux.

## Before step 1

- **abb-rws-client 1.5.1 is published first**, and its `v1.5.1` tag is in its
  public repository:

  ```powershell
  npm view abb-rws-client@1.5.1 version
  ```

  must answer `1.5.1`.
- **The branch is pushed and CI is green on it.** Push it as `release/<version>`, or
  open a draft pull request; the manual start works only once the workflow file is
  on `master`. For 0.1.0 this waits for abb-rws-client 1.5.1 on npm: see below.
- The working tree is clean (`git status --short` prints nothing), and the checks
  against controllers planned for this version have been run.
- The release check has been run with your private list and the commits of the
  branch (the command under "The release check"), and says `ok` on every line.

### 0.1.0: what is left, in order

Steps 1 to 3 are in the tree: `package.json` names `"^1.5.1"` and has no `private`
field, the version is `0.1.0`, the README has no sibling-client block, the CHANGELOG
heading is dated and schema 0.14 is marked released. `package-lock.json` already
takes abb-rws-client 1.5.1 from the registry: it was made before that version was
on npm, from the tarball packed from the client's release commit, and names the
registry tarball with that tarball's integrity. Until abb-rws-client 1.5.1 is on
npm, `npm ci`, and CI with it, fails on this branch, so the branch is pushed only
after the client is published. On release day:

1. After abb-rws-client 1.5.1 is on npm (`npm view abb-rws-client@1.5.1 version`
   answers `1.5.1`), check that npm serves the tarball the lock names:

   ```powershell
   npm view abb-rws-client@1.5.1 dist.integrity
   node -p "require('./package-lock.json').packages['node_modules/abb-rws-client'].integrity"
   ```

   The two must be the same. If they differ, the published tarball is not the one
   the lock was made from: run `npm install abb-rws-client@1.5.1`, check that
   `npm pkg get dependencies.abb-rws-client` still prints `"^1.5.1"`, and commit
   `package-lock.json`.
2. `npm ci`, then `npm ls abb-rws-client`: it must show 1.5.1 without a link to
   another folder.
3. Steps 4 to 6: build from nothing, then
   `node scripts/release-check.mjs --release --deny-file C:\somewhere\private\deny-list.txt`
   with every line `ok`, then read `npm pack --dry-run`.
4. Push the branch as `release/0.1.0`.
5. Wait until CI on that commit is green.
6. `git tag v0.1.0` and `git push origin v0.1.0` (step 7).
7. `npm publish --access public` (step 8).
8. Step 9, including the merge of `release/0.1.0` into `master`.

## Steps

1. **Take the client from the registry.** Open `package.json` in an editor and make
   the dependency line read

   ```json
   "abb-rws-client": "^1.5.1"
   ```

   Type it into the file. Do not set it with `npm pkg set` and the range on a
   command line: `cmd.exe` swallows an unquoted `^`, and PowerShell hands the
   argument to `npm.cmd` through `cmd.exe`, so the caret can be lost in either shell
   and leave an exact pin. Read it back:

   ```powershell
   npm pkg get dependencies.abb-rws-client
   ```

   must print `"^1.5.1"`. Then

   ```powershell
   npm install
   npm ls abb-rws-client
   ```

   The lock file now names the registry tarball, and `npm ls` shows the client
   without a link to another folder.

   In `README.md`, in the part about building from source, delete the block between
   `<!-- sibling-client:start -->` and `<!-- sibling-client:end -->`, the two marker
   lines included.

2. **Make it public and give it its version.**

   ```powershell
   npm pkg delete private
   npm version 0.1.0 --no-git-tag-version
   ```

   Done for 0.1.0: skip this step. `npm version` stops with "Version not changed"
   on a package that already has the version.

3. **Date the release.** In `CHANGELOG.md` the heading becomes
   `## [0.1.0] - YYYY-MM-DD` with today's date. In `schema/history/index.json` set
   `"released": true` on the `0.14` entry, then

   ```powershell
   npm run schema
   ```

   It must report no problem; it may write the index again in its own layout. From
   now on a change to the wire shape needs schema 0.15.

4. **Build from nothing.**

   ```powershell
   Remove-Item -Recurse -Force dist
   npm run build
   npm test
   ```

   The compiler never deletes an output, and the package ships all of `dist/`: a
   module that was renamed or removed would otherwise travel in the tarball.

5. **Run the release check.**

   ```powershell
   node scripts/release-check.mjs --release --deny-file C:\somewhere\private\deny-list.txt
   ```

   Every line must say `ok`. The `release: client dependency` line prints the range
   it found: it must show `"^1.5.1"`. The private list is yours to pass: the
   `prepublishOnly` run in step 8 gets it from `ABB_RWS_RELEASE_DENY_FILE`, so set
   that variable in the shell you publish from.

6. **Read the file list once with your own eyes.**

   ```powershell
   npm pack --dry-run
   ```

7. **Commit, push, wait, then tag.** Commit and push the branch. Wait for CI on that
   commit: it now takes the client from the registry, installs the tarball and runs
   the command. Only when that run is green:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

   CI runs once more, on the tag. A red run therefore never leaves a tag to move.

8. **Publish.**

   ```powershell
   npm publish --access public
   ```

   `prepublishOnly` runs the release check again, and `prepack` builds and tests.
   The check runs first and so sees the `dist/` of step 4.

9. **Afterwards.**
   - On a machine that has neither repository: `npx abb-rws-daemon@0.1.0 --version`.
   - `npm deprecate abb-rws-daemon@0.0.1 "placeholder; use 0.1.0 or later"`. The
     name was reserved with a 0.0.1 that has no working command.
   - A GitHub release for the tag, with the 0.1.0 section of the changelog.
   - Merge the release branch into `master`: GitHub shows `master`'s README, and the
     manual CI start needs the workflow file there.
   - Set the next development version when work on it starts, for example
     `npm version 0.2.0-dev --no-git-tag-version`, and give it its CHANGELOG
     heading (`## [0.2.0] - unreleased`) in the same commit. README keeps naming
     0.1.0, the version npm has: the every-day check accepts the last released
     version while the package version carries a development suffix, and holds
     README to the new version again at its release.

## Between the push and the publish

From step 7 to step 8 the public README names `abb-rws-daemon@0.1.0` while npm does
not have it yet. Someone who tries an install line in those minutes gets "no
matching version", never the 0.0.1 placeholder. That gap is accepted. Do not close
it by taking the version out of the install lines: a line without a version is
exactly what would fetch the placeholder, and the release check refuses it.

## What the release rules add

- `private` is gone, the version is a plain `x.y.z`, the CHANGELOG heading for it
  carries a date, and README has neither wording of an unreleased state nor the
  sibling-client block.
- The abb-rws-client dependency is a registry range that starts with `^` or `~` and
  that the client installed in `node_modules` satisfies. A bare `1.5.1` fails: that
  is what a range looks like after a shell has eaten its caret. The lock file has no
  linked package and no path that leaves the folder.
- The schema version is marked released in the schema history.
- The files `npm pack` would ship: only `package.json`, `README.md`, `CHANGELOG.md`,
  `LICENSE`, `NOTICE`, `TRADEMARKS.md` (the NOTICE points to it), `dist/` and
  `schema/`; no source map, recording, tarball, config file or token; nothing from
  `tests/`, `scripts/`, `.github/` or a `recordings/` folder; `dist/cli.js` is there,
  is what `bin` names, and starts with `#!/usr/bin/env node` ending in LF; under 2 MB
  unpacked; no shipped `.js` or `.d.ts` file ends in a source-map comment (the build,
  `tsconfig.build.json`, writes neither maps nor comments); and the content scan
  passes over every shipped file.
- The built command answers `--version` with the package version and `--help` with
  status 0, and `dist/index.js` imports.

No rule looks at a file mode. On Windows npm reports mode 0644 for every file, the
bin target included, so such a rule would fail every release made from Windows. npm
makes the bin target executable when it installs the package, and the last step of
the CI job is the proof.

## If something is wrong after publishing

Publish a fixed patch version and `npm deprecate` the bad one. Do not unpublish.
