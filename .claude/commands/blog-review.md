---
description: Run the Player / Arranger / Integrator / Redactor loop over blog/ — a reader finds the confusing parts, a structural pass finds material in the wrong post, both get triaged into verified tasks, then applied
argument-hint: "[all | 05 | blog/05-....md] [--report-only] [--no-arrange]"
---

Run the four-stage review loop over the posts in `blog/`. Arguments: `$ARGUMENTS`

Scope: a bare number means that post (`05` → `blog/05-*.md`), a path means that
file, `all` or empty means every post plus `blog/README.md`.
`--report-only` stops after stage 3 and applies nothing.
`--no-arrange` skips stage 2, for a pass over wording only.

The four agents are defined in `.claude/agents/`. Run them **in series** — each
stage consumes the previous one's output. Do not run them in parallel and do not
start a stage before the previous one has reported.

**Isolate before stage 4.** The `redactor` writes to `blog/`, and a background
session that has not isolated has its writes rejected — which wastes a whole
redactor spawn re-running. Unless `--report-only`, and unless the working
directory is already under `.claude/worktrees/`, call `EnterWorktree` before
spawning the redactor. The blog series is on the `docs/blog-series` branch, so a
default `fresh` worktree branches from the wrong ref and `blog/` is absent —
create the worktree from the current HEAD instead (`git worktree add <path> HEAD
-b <name>`, then `EnterWorktree` with that `path`).

## Stage 1 — `player`

Spawn the `player` agent.

**Give it the file list and nothing else.** No summary of the project, no
explanation of what a sniffer is, no context from this conversation, no
description of what the posts are about. Its entire value is that it arrives
knowing only Dofus, and anything you tell it up front is something the posts no
longer have to say for themselves. If you find yourself writing a helpful
sentence of background into that prompt, delete it.

Print its report to the user verbatim before continuing. It is the most
interesting artifact of the four and it is short.

## Stage 2 — `arranger`

Spawn the `arranger` agent with the scope and the player's report **verbatim**.

It answers a different question from every other stage: not "is this explained
well" but "is this in the right file". It reads all seven posts regardless of
scope, because placement cannot be judged from one side, and it proposes only
moves, splits, merges and deduplications — never new content.

Print the map (one thesis per post, plus what each section is doing for that
thesis) and every proposal with its cost line. That structured content is how
the user checks the judgement rather than taking it. Do **not** relay the
arranger's surrounding prose verbatim — the map, the proposals and the
rejections are the artifact; reproduce those, not the connective narration.

Skip this stage entirely on `--no-arrange`.

## Stage 3 — `integrator`

Spawn the `integrator` agent and pass it **both** the player's report and the
arranger's proposals, verbatim, not your summary of either. Your paraphrase
would smuggle in your own knowledge of the repo, which is what the player's
ignorance was protecting against.

Tell it that the arranger's proposals are already structural and need verifying,
not re-deriving: it should confirm each move's `FROM`/`TO` blocks exist where
stated, check the cost and breakage list is complete, and reject any proposal
whose moved text carries a number that would stop tracing to its source.

Print the resulting task list as a table, and separately print what it rejected
and why — the rejections are how the user sees whether triage was sane. Print
those two structures; do not relay the integrator's prose verbatim.

**Stop here if `--report-only`.**

## Checkpoint

Before any file is edited, show the user:

- how many tasks, by size (S / M / L)
- which posts they touch
- **every structural task**, listed separately from the content tasks, with the
  cost line the arranger attached and the links it breaks. These are the only
  tasks that can lose text or change a filename, so they get their own yes or no
- whether any structural task renumbers a file, which invalidates published
  links and should be a deliberate choice, never a default
- every task the integrator marked L, which its own definition says needs a
  human decision
- any task whose `SOURCE` is `not in the repository`, since those change the
  posts by cutting a claim or stating a limit rather than by explaining more

Ask whether to apply all, apply a subset, or stop. Do not proceed on silence.
Approving the content tasks is not approving the structural ones.

## Stage 4 — `redactor`

Spawn the `redactor` agent once, with the approved tasks passed verbatim.
It applies them one at a time and verifies as it goes.

**Order the tasks content-first, structural last**, and say so in the prompt.
Content tasks are anchored to a post and a line; a move performed first would
strand those anchors in another file. Applying the moves at the end means the
fixes travel with the text.

Tell it that moved prose moves **verbatim** — only the lead-in and lead-out
sentences are rewritten — and that after any move it re-checks `blog/README.md`
and every cross-post reference the arranger listed as breaking.

If it **refuses** a task, do not re-prompt it into compliance and do not do the
edit yourself. A refusal means the cited source did not support the task, which
is the guard working. Report it to the user as an open question.

## Report

Print the redactor's per-task receipts, then run the checks yourself rather than
trusting the report:

```sh
for f in blog/*.md; do n=$(grep -c '^```' "$f"); [ $((n%2)) -eq 0 ] || echo "ODD FENCES $f"; done
cd blog && grep -oE '\]\((\.\./)?[A-Za-z0-9_./-]+\)' *.md | sed 's/.*(//;s/)$//' \
  | grep -v '^http' | sort -u | while read p; do [ -e "$p" ] || echo "MISSING $p"; done
cd .. && grep -rn '0[1-9]-[a-z]' blog/*.md | grep -v '^blog/README'
grep -nEi '\b(easy|easily|simply|quick|very|really)\b' blog/*.md
git diff --stat blog/
```

The third check lists every cross-post reference in the series; after a move,
read it and confirm each one still points at the post that now holds the
material.

Finish with the net line-count change per post. The house preference is that
posts get shorter and carry more of their meaning in diagrams, so a review round
that grew every file is a result worth stating plainly rather than burying. A
round that moved text between posts should net near zero across the series —
if the total grew, the move became a rewrite somewhere.

Do not commit.
