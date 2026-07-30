# Design system — "Modal"

> Phosphor terminal in a darkened server room — the vivid green is the only
> light source.

Dark theme. Near-black canvas, phosphor-pale green type, one vivid lime accent
used sparingly for primary actions and status. Full reference in
[DESIGN.md](DESIGN.md).

## Files

| file | what it is |
|---|---|
| `DESIGN.md` | the reference — tokens, components, do's and don'ts, usage guidance |
| `theme.css` | Tailwind 4 `@theme` block. **This is the one the app consumes.** |
| `variables.css` | the same tokens as plain `:root` custom properties, for non-Tailwind use |
| `tokens.json` | W3C design-token format, for design tooling |

`theme.css`, `variables.css` and `tokens.json` are three encodings of the same
tokens. Change one and the others drift — treat `DESIGN.md` as the source of
truth and regenerate rather than hand-editing.

## How the web app uses it

`src/app/globals.css` imports `theme.css` directly, so every token is available
as a Tailwind utility: `bg-void-black`, `text-phosphor-white`,
`text-lime-pulse`, `px-32`, `rounded-xl`, `text-heading-lg`, and so on.

No build step, nothing copied — edit `theme.css` and it is picked up on the
next render.

**This folder has to live inside `web/`.** It was originally at the repo root,
which Turbopack rejects:

```
FileSystemPath("").join("../design/theme.css") leaves the filesystem root
```

CSS cannot be imported from outside the project root, so the design system sits
inside the app that consumes it.

It is also in `.prettierignore`: these files are tool exports, and reformatting
them would produce noise on every re-export.

## Fonts

The system specifies two faces, neither freely available:

| specified | substitute used | why |
|---|---|---|
| Goga (display, H1–H4) | **Inter Tight** | named as an approved substitute in DESIGN.md |
| Inter Variable (UI, body) | **Inter** | the variable font under its Google Fonts name |

Both are loaded via `next/font/google` in `web/src/app/layout.tsx` and bound to
the `--font-goga` and `--font-inter-variable` token names, so the token layer
stays honest about intent even though the rendered face is a substitute. If
Goga is ever licensed, swap the loader and nothing else changes.

Two OpenType features in the spec (`ss01` on Goga, `cv11` on Inter) are
Goga-specific and Inter-specific respectively; `cv11` is applied, `ss01` has no
effect on the substitute.

## Rules worth not re-reading the whole doc for

- **Ration the lime.** `--color-lime-pulse` is for primary CTAs, the logo,
  active state and single emphasis moments. If two lime things are visible at
  once, one is probably wrong.
- **Borders, not shadows.** Depth comes from hairline green-tinted borders
  (`--color-circuit-border`) and backdrop blur. One shadow token exists; it is
  rarely the answer.
- **Body copy is not white.** `--color-sage-60` is the default paragraph color
  on dark; `--color-phosphor-white` is for headings and high-emphasis text.
- **Tracking is negative** almost everywhere, tightening as size grows. The
  exception is 12px uppercase eyebrow labels at `+0.05em`.
