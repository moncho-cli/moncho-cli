# Interface — the brand line, on the first row of the screen

> Original item: *show the moncho.png logo on the top right of the conversation,
> colors inverted (flip black and white) never larger than 200x200 px but if the
> window is small it can remain at 20%*
>
> First revision: *if it can't be a fixed-position RGB image overlay, then just one
> line with the text `MONCHO (v x.x.x)`.*
>
> Second revision: *actually, if you can show the real image do, if not don't show
> image, and the right aligned MONCHO and version would be the very first top line
> (displacing the conversation edge 1 line below).*

## No image: it cannot be shown truthfully here

The image was implemented first, and it could not be made honest. The reason is a
property of the front end, not of the code:

- **a terminal cell carries one colour, and blessed only has 256 of them.**
  `neo-blessed/lib/colors.js#hexToRGB` maps every hex colour onto the nearest
  xterm-256 index; there is no `38;2;r;g;b` path anywhere in the library, so a cell
  cannot carry a true-colour pixel, and there is no alpha channel to blend with;
- **a raster image therefore needs an out-of-band protocol** — kitty graphics
  (real RGBA, persistent placement), sixel, or iTerm2 inline — written to the tty
  *outside* the cell grid. neo-blessed speaks none of them, and the project ships no
  image library by design;
- **the half-block fallback degenerated.** Rendering the artwork as `█`/`▀`/`▄`
  glyphs at the size the region allows produced a ~24×24 sample grid: a glyph
  mosaic, recognisable as a disc but not as the drawing, and monochrome because
  there was no colour to draw with.

The author's rule is *show the real image or show no image*. No image is shown, and
the whole apparatus the attempt needed — a PNG decoder, the ink mask, the glyph
renderer, their probes — is **deleted**, not left unused.

## The line

`app/brand.js` is pure: no `fs`, no screen.

| Rule | Behaviour |
| ---- | --------- |
| **content** | `formatBrand()` paints `MONCHO (v <version>)` (`BRAND_NAME`, `BRAND_VERSION`). The version comes from `package.json` — imported with `with { type: 'json' }`, so there is one source of truth rather than a second copy in the code — and a blank or missing one falls back to the declared version instead of painting `MONCHO (v )`. |
| **colour** | `BRAND_COLOR` is `bright-white`, the brightest white there is: a mark on a dark terminal that does not shout over the conversation. |
| **fit** | `resolveBrandSize()` returns one row as wide as the line, **or `null`**. It is all-or-nothing: the line is a mark, not prose, so a window narrower than the line hides it rather than clipping or wrapping it. |

## The first row, and the displaced conversation

`app/brand-bar.js` is the only place that touches the screen:

- **row 0 is the mark's.** A borderless, one-row `blessed.box` at `top: BRAND_TOP`
  (0) and `right: BRAND_RIGHT` — the very first line of the screen, right-aligned
  against the same edge the status meter and the notices end on.
- **the conversation moves down, it is not covered.** The bar reports its own height
  through `reserve`; `app/tui-layout.js#setBrandRows` sets the transcript's `top` to
  that height, so the conversation's own border *is* the row below the mark. This is
  the difference from a floating overlay: the row belongs to the mark.
- **the row is given back.** Closing the bar — or a resize too narrow to hold the
  line — reports 0 rows, so the transcript returns to the top edge.
- **the colour is a `style.fg`, never an inline tag.** This is a blessed quirk, not
  a preference: `{bright-white-fg}…{/bright-white-fg}` makes neo-blessed count the
  tag's own bytes against the cell width, so a box sized to the visible line renders
  `MONCHO (v      ` with the version cut off. A style attribute has nothing to count.
- **notices hang below it.** The notice overlay (`docs/interface/notice-overlay`)
  takes an `anchor` and re-reads it on every paint, so a notice appears under the
  mark rather than over it, and follows the conversation back up when the mark hides.

The surface reaches the TUI as `brandBar` / `brandLine` / `brandSize`
(`app/tui-surface.js`), and `app/tui.js` repaints the bar on every resize, then the
notices that follow it.

## See also

- Implementation: `app/brand.js` (the pure line), `app/brand-bar.js` (the screen
  binding), `app/tui-layout.js` (the displaced conversation), `app/tui.js` (the
  wiring), `app/tui-surface.js` (the public surface)
- Spec of the overlay that hangs under the mark: `docs/interface/notice-overlay`
- Spec of the region the mark sits above: `docs/interface/tui`
- Proof: `tests/brand.test.js`, `tests/tui.test.js`