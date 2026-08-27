# blog/medium/

Medium-ready copies of the posts in `blog/`, produced by the `publisher` agent
via `/blog-medium`. These are **generated** — do not hand-edit them, edit the
source post and re-run.

Each `NN-slug.md` here is the matching `../NN-slug.md` with three changes and
nothing else:

- every mermaid diagram replaced by `![alt](assets/NN-dNN.png)` (Medium renders
  no mermaid); the `.svg` beside each `.png` is the archive copy
- every markdown table reflowed to a fixed-width fenced block or a bullet list
  (Medium renders no tables)
- every repo-relative link rewritten to an absolute `github.com/...` URL

Plus a header block carrying the title and subtitle Medium expects, and the
project disclaimer appended from `../README.md`.

## Pasting into Medium

Medium's import-from-file does not carry local images. So:

1. New story, paste the whole `.md`.
2. The image lines land as literal `![...](assets/...)` text — delete each and
   drag the matching PNG from `assets/` in at that spot, in order.
3. The first `#` becomes the title, the first `###` the subtitle.

## Regenerating

```sh
cd blog && pnpm install        # first time only; pulls a headless Chromium
/blog-medium 01 --ref main
```

`assets/*.mmd` are the extracted diagram sources, kept so a render is
reproducible without the original post.
