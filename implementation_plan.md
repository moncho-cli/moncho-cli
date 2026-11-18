# Brand line: MONCHO (v x.y.z) on the first row of the screen

status: done

## Steps

- [x] Settle the image question for good: neo-blessed maps every hex colour to an xterm-256 index (no 24-bit SGR path) and speaks no graphics protocol, so a blended raster image is impossible and the half-block art degenerates into a ~24x24 stencil. Show the real image or nothing -> nothing, and delete the whole PNG path.
- [x] Write `app/brand.js`: `formatBrand` over the version `package.json` declares (JSON import, one source of truth), `resolveBrandSize` (one row, all-or-nothing), `BRAND_TOP`/`BRAND_RIGHT` pinned to row 0 and the right edge.
- [x] Write `app/brand-bar.js`: the borderless one-row box on row 0, the colour applied as `style.fg` (an inline tag would be counted against the cell width and clip the version), the reserved row and its release.
- [x] Displace the conversation instead of covering it: `setBrandRows` moves the transcript's `top`, so the mark is a line above the conversation; the notice bar takes an `anchor` and hangs one row under the mark.
- [x] Rewire the TUI: `createBrandBar` in `app/tui.js` (the whole screen is its room, repaint on resize, notices re-anchored after it), `brandBar`/`brandLine`/`brandSize` in `app/tui-surface.js`.
- [x] Add `tests/brand.test.js` (formatting, fit rule, displacement, row 0 in a real TUI) and update `docs/interface/brand-line`, `docs/interface/tui`, `docs/interface/notice-overlay`, `docs/index.yaml`, `tests/README.md`, `README.md`.
- [x] Verify: `node --check` on every touched file, `npm test` green (312 pass / 0 fail, docs-realm included), every file under 300 lines.

## Notes

- The blessed width quirk is the one non-obvious finding and it is documented in the
  code: `{bright-white-fg}MONCHO (v 1.0.0){/bright-white-fg}` in a box sized to the
  visible line renders `MONCHO (v      `, with the version cut off, because the tag's
  own bytes are counted as cells. `style.fg` has nothing to count.
- The notice overlay's anchor is a *function*, not a number: the brand line can hide
  on a narrow window, and the notices have to follow the conversation back up.
- Files touched, longest first: `app/tui.js` (262), `app/notice-bar.js` (157),
  `app/tui-surface.js` (155), `app/tui-layout.js` (154), `tests/brand.test.js` (154),
  `app/brand-bar.js` (147), `app/brand.js` (89).