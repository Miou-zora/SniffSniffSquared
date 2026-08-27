---
description: Port a blog/ post to a Medium-ready copy under blog/medium/ — mermaid rendered to PNG, tables reflowed, links made absolute, header and disclaimer added. Source is never touched.
argument-hint: "[01 | blog/01-....md] [--ref main] [--medium NN=https://... ...]"
---

Produce a Medium-pasteable version of one blog post. Arguments: `$ARGUMENTS`

Scope: a bare number means that post (`01` → `blog/01-*.md`), a path means that
file. No `all` — port one post per run so its diagram render and prose diff can
be checked before the next.

`--ref <git-ref>` sets the branch or tag that absolute GitHub links point at.
Default `main`. The series currently lives on `docs/blog-series`; pass
`--ref docs/blog-series` until it is merged, or the links 404.

`--medium NN=<url>` supplies the published Medium URL of a sibling post, repeatable.
Any sibling link without a mapping falls back to the GitHub source file and is
flagged in the report.

## Prerequisites

The `publisher` agent shells out to `mmdc`. Check it resolves first:

```sh
cd blog && pnpm exec mmdc --version
```

If `blog/node_modules` is absent, run `cd blog && pnpm install` once. The first
run downloads a headless Chromium for mermaid-cli (~150 MB into
`blog/node_modules`, which is gitignored). If the install or `--version` fails,
stop and tell the user — do not spawn the agent to fail slowly.

## Isolate before running

The agent writes to `blog/medium/`. A background session that has not isolated
has its writes rejected, wasting the spawn. Unless the working directory is
already under `.claude/worktrees/`, create a worktree from the current HEAD (a
default `fresh` worktree branches from `main`, where `blog/` on the series
branch is absent):

```sh
git worktree add <path> HEAD -b <name>
```

then `EnterWorktree` with that `path`.

## Run

Spawn the `publisher` agent once, with:

- the resolved source path
- the output dir `blog/medium/`
- the `ref` (default `main`)
- the repo README URL for the header line:
  `https://github.com/Miou-zora/SniffSniffSquared/blob/<ref>/blog/README.md`
- the `--medium` map, if any
- the post's number and that the series is 6 posts, for the "Post N of 6" line

Pass nothing else. The agent does not need the conversation context; it needs
the source file and the four parameters above.

**It is a format port, not an edit.** The prompt must say so in those words: the
agent copies prose verbatim and only writes the header block, image alt text
that restates existing captions, and the disclaimer copied from
`blog/README.md`. If it reports a sentence in the source looks wrong, that is a
finding for the user, not a licence for the agent to fix it.

## After the agent reports

Print its receipt verbatim, then run the checks yourself rather than trusting
the report:

```sh
src=<source path>; out=blog/medium/$(basename "$src")

test -f "$out" || echo "NO OUTPUT FILE"
grep -n '^```mermaid' "$out" && echo "LEFTOVER MERMAID"
grep -nE '^\|.*\|$'    "$out" && echo "LEFTOVER PIPE TABLE"
grep -oE '\]\([^)]+\)' "$out" | grep -vE '\]\((https?://|#|assets/)' && echo "RELATIVE LINK"
grep -oE '\]\(assets/[^)]+\)' "$out" | sed 's/.*(//;s/)//' \
  | while read p; do [ -e "blog/medium/$p" ] || echo "MISSING ASSET $p"; done
n=$(grep -c '^```' "$out"); [ $((n%2)) -eq 0 ] || echo "ODD FENCES $out"

# prose parity: drop header (to first ---), disclaimer (from last ---),
# and image lines from the output; drop mermaid/table blocks from the source;
# diff the remainder — must be empty
```

Do the prose-parity diff by hand and report whether it is empty. A non-empty
diff means the port changed wording; that blocks the result.

List the rendered assets with sizes (`ls -la blog/medium/assets/`) and confirm
each mermaid block in the source has a corresponding PNG.

## Report

- output path, and asset count (PNG + archived SVG)
- every link that fell back to a GitHub source file because no `--medium` URL
  was given for it — these are the ones to revisit once more posts are published
- the "PASTE NOTE": Medium's import-from-file does not carry local images, so
  the workflow is create story → paste markdown → drag each `assets/*.png` in at
  its placeholder, in order
- anything the agent flagged about the source (a diagram with no lead-in
  sentence, a missing "What it answers" line, a sentence that reads wrong) — as
  open questions for the source post, not things this command fixed

Do not commit.
