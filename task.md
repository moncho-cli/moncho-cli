status: done

# Brand line: `MONCHO (v x.y.z)` on the first row of the screen

The backlog item asked for the `moncho.png` logo to be shown as an inverted image,
never larger than 200x200 px. Two revisions later the rule is: **show the real image
or show no image**, and the mark is one line of text on the very first row of the
screen, with the conversation displaced one line below it.

> if it cant be a fixed position top right rgb image overlay, then just one line with
> the text MONCHO (v x.x.x)
>
> actually, if you can show the real image do, if not dont show image, and the right
> aligned MONCHO and version would be the very first top line (displacing the
> conversation edge 1 line below)

- [x] show the moncho.png logo on the top right of the conversation, colors inverted (flip black and white) never larger than 200x200 px but if the window is small it can remain at 20%

## Why there is no image

- a terminal cell carries **one** colour, and neo-blessed's
  `lib/colors.js#hexToRGB` maps every colour onto the nearest xterm-256 index; the
  library has no `38;2;r;g;b` path, and a cell has no alpha, so a true-colour,
  blended raster image cannot be composited into the conversation;
- a real image would need an out-of-band protocol — kitty graphics (the only one
  with real RGBA and persistent placement), sixel, iTerm2 inline — that blessed does
  not speak, and the project ships no image library by design;
- the half-block fallback that was built instead degenerated into a ~24x24 glyph
  stencil: recognisable as a disc, but a mosaic, not the drawing.

So no image is shown, and all the image apparatus (the PNG decoder, the ink mask, the
size rule, the glyph renderer, their probes) is deleted rather than left unused. The
one thing that *is* shown faithfully is a line of text.

## What the line does

| Rule | Behaviour |
| ---- | --------- |
| **content** | `app/brand.js#formatBrand` paints `MONCHO (v <version>)`; the version is imported from `package.json` (`with { type: 'json' }`) so there is one source of truth, and a blank one falls back to the declared version instead of `MONCHO (v )`. |
| **colour** | `BRAND_COLOR` is `bright-white`, applied as the box's **`style.fg`** — never an inline tag, because blessed counts a tag's own bytes towards the cell width and would clip the version. |
| **place** | row **0**, right-aligned (`BRAND_TOP`, `BRAND_RIGHT`): the very first line of the screen, ending on the same edge the status meter ends on. |
| **displacement** | `app/brand-bar.js` reports its height through `reserve`, and `app/tui-layout.js#setBrandRows` moves the transcript's `top` by it — so the conversation edge is one line below the mark, and its border *is* the row under it. |
| **fit** | `resolveBrandSize` returns one row as wide as the line, or **`null`**: all-or-nothing, so a narrow window hides the mark and puts the conversation back on the top edge rather than clipping the line. |
| **notices** | the notice overlay takes an `anchor` (re-read on every paint) and hangs one row under the mark, so a notice never covers it. |

## Files

| Action | Path |
| ------ | ---- |
| added | `app/brand.js`, `app/brand-bar.js`, `tests/brand.test.js`, `docs/interface/brand-line/*` |
| rewritten | `app/tui-layout.js` (`setBrandRows` now displaces the transcript instead of padding it), `app/brand-bar.js`, `app/notice-bar.js` (the `anchor`) |
| rewired | `app/tui.js`, `app/tui-surface.js` (`brandBar`/`brandLine`/`brandSize`), `docs/index.yaml`, `docs/interface/{tui,notice-overlay}`, `tests/{README,tui.test}.md`/`.js`, `README.md` |
| deleted | `app/logo.js`, `app/logo-panel.js`, `utils/png.js`, `utils/png-scanlines.js`, `utils/png-error.js`, `tests/logo.test.js`, `tests/png-decode.test.js`, `tests/support/png-fixture.js`, `docs/interface/logo-panel/`, `agent/utils/probe-logo-render.mjs` |

## Done when

- row 0 carries `MONCHO (v x.y.z)` from `package.json`, right-aligned, and the
  conversation starts on row 1 — proved inside a real pty;
- a window too narrow to hold the line hides the mark and returns the row;
- the behaviour is described by `docs/interface/brand-line` with real `path#symbol`
  references and the exact test cases that prove it;
- `npm test` is green (312 pass / 0 fail), `tests/docs-realm.test.js` included;
- every file touched stays under 300 lines (longest: `app/tui.js`, 262);
- no image is shown anywhere in the terminal.