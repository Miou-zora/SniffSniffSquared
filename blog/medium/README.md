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

## Banner

`assets/banner-NN.{html,png}` is the story's preview card — a 3000×1500 PNG
(1500×750 at 2x) rendered from a self-contained HTML file by `../tools/shot.mjs`.
Unlike the `.md`, this one is **authored by hand** during the same `/blog-medium`
run, not by the `publisher` agent: it is a designed image, not a verbatim port.

The recipe is fixed. Copy `assets/banner-01.html` and change only four things —
`h1` (the post title, shortened if it overflows), `.sub` (the "What it answers"
line compressed to one sentence), `.kicker` (`... · post N of 6`), and the
`.dump` panel (a real captured artifact from that post with its one
load-bearing detail lit via `.hit` / `.hitbg`). Everything else — the pixel
mark, the `#7fee64` / `#ddffdc` palette, the layout — stays byte-for-byte, so
the six cards read as one set. Render with:

```sh
cd blog && node tools/shot.mjs medium/assets/banner-NN.html medium/assets/banner-NN.png
```

## Pasting into Medium

Medium's import-from-file does not carry local images. So:

1. New story, paste the whole `.md`.
2. The image lines land as literal `![...](assets/...)` text — delete each and
   drag the matching PNG from `assets/` in at that spot, in order.
3. The first `#` becomes the title, the first `###` the subtitle.
4. Set `assets/banner-NN.png` as the story's preview image, and paste the
   Preview title / Sub-preview title / 5 topics the `/blog-medium` run reported
   into the story settings.

## Regenerating

```sh
cd blog && pnpm install        # first time only; pulls a headless Chromium
/blog-medium 01 --ref main
```

`pnpm install` also pulls `puppeteer`, the dep `tools/shot.mjs` uses for the
banner. If a render errors `ERR_MODULE_NOT_FOUND ... puppeteer`, the lockfile
gained it after `node_modules` was built — run `pnpm install` again.

`assets/*.mmd` are the extracted diagram sources, kept so a render is
reproducible without the original post. `assets/banner-NN.html` is likewise
kept beside its PNG so the card can be re-rendered without rebuilding it.
