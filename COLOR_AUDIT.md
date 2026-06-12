# Color Audit — jb-directory explorer

A map of how color is used today, so palette/semantic decisions can be made precisely.
All colors are CSS vars in `src/style.css :root` (plus a few inline hex in `src/*.js`).

## 1. Palette

| Var | Hex | |
|---|---|---|
| `--c-teal` | `#1a8a8a` | strong teal |
| `--c-teal-light` | `#6ec4c4` | light teal |
| `--c-green` | `#3d7a5a` | green |
| `--c-green-light` | `#82b89e` | light green |
| `--c-pink` | `#c43550` | pink/red |
| `--c-pink-light` | `#eda3b0` | light pink |
| `--c-orange` | `#b8602e` | orange/rust |
| `--c-orange-light` | `#cca080` | light orange |
| `--c-black` | `#2c2018` | near-black (text) |
| `--c-black-light` | `#7d6858` | brown-grey (muted) |
| bg / card / depth | `#f6c9c0` / `#fcd0c2` / `#f2c0b0` | salmon page, lighter card, deeper panel |
| muted-2/3/4 | `#7d5a4e` / `#a88878` / `#e8bfae` | text greys (warm) |

## 2. Usage frequency (style.css)

`--c-pink-light` 109 (borders, everywhere) · `--c-teal` **100** · `--muted-2` 126 (body text) ·
`--c-pink` 39 · `--c-black` 39 · `--c-black-light` 22 · `--c-green` 23 · `--c-orange` 20 ·
`--c-teal-light` 17 · `--c-green-light` 9 · `--c-orange-light` 8.

Takeaway: **teal is the dominant accent (100 uses)** and pink-light is the universal border.

## 3. What each color *means* today (derived from usage)

- **Teal (`--c-teal`)** = "interactive / live / selected / primary". 54× as text (links, active
  tab, hovers), ~37× as borders (active/selected/focus outlines), 8× as fills (primary button
  `.create-btn.primary`, connected-wallet badge, step dots, shop qty badge). Mapped:
  `--selected-border: teal`.
- **Teal-light (`--c-teal-light`)** = the FILL counterpart of teal — "selected / positive state":
  `--selected-bg`, `.paybox-slippage-btn.active`, `.pay-routing-tag.amm`,
  `.detail-activity-type--payout`, `.bridge-status--claimable`, `.buyback-indicator.terminal-mint`,
  create badges. Also the **Issuance price** chip dot (`#6ec4c4`).
- **Green (`--c-green` / `-light`)** = "write / transact / pay". `--write`, `--transact-bg`,
  `--payable-bg`, the **Pay button**, payable method badges.
- **Orange (`--c-orange` / `-light`)** = "read / query / warning / focus". `--read`, `--query-bg`,
  `--warning`, `--focus-ring`, testnet-selected, **AMM price chip dot** (`#b8602e`).
- **Pink (`--c-pink`)** = "error/destructive" (`--error`) + brand title accents. **Pink-light** =
  default border / neutral chrome (109×).
- **Black / black-light / muted-2..4** = text hierarchy. Cash-out chip dot = `--c-black-light`.

## 4. The core problem: teal is overloaded AND inconsistent across the two "route" surfaces

There are **two places** that express the same concept (Issuance vs AMM routing), and they assign
color in **opposite** ways:

| Concept | Price chip **dot** (`renderPriceChart`) | "You get" **routing tag** (`renderRoutingTag`) |
|---|---|---|
| Issuance | **teal-light** `#6ec4c4` | **neutral grey** (`.pay-routing-tag` base) |
| AMM | **orange** `#b8602e` | **teal-light** `.pay-routing-tag.amm` |

So **AMM is orange in one view and teal in another**, and **teal means "Issuance" in the chips but
"AMM" in the tag**. That direct inversion is the precise reason the AMM tag feels wrong — the eye
has already learned "teal dot = issuance" two inches away.

On top of that, **teal-light is the global "selected/active" fill** (`--selected-bg`,
`.paybox-slippage-btn.active`). So:
- The **AMM tag** (a *passive status* — "the preview chose the AMM route") is wearing the
  *selected-toggle* fill, making it read as clickable/active when it isn't.
- It sits **right next to** the slippage `1%` button, which uses the *same* teal-light fill but IS a
  selected toggle. Two identical chips, two different meanings (status vs selection) → confusion.

## 5. Decision points (options, not prescriptions)

1. **Pick ONE identity per route and use it everywhere.** e.g. Issuance = teal, AMM = orange — then
   make the routing tag match the chip dots (AMM tag → orange-tinted, Issuance tag → teal-tinted),
   or vice-versa. Kills the inversion.
2. **Reserve teal/teal-light for interaction only** (links, active tab, selected toggles, primary
   button). Don't use it for passive category labels. Give status tags (AMM/Issuance, payout,
   claimable) their own *non-interactive* treatment — e.g. tinted text on a faint same-hue wash with
   no solid fill, so they read as labels, not buttons.
3. **Differentiate "status chip" vs "selectable chip" grammar.** Selected toggles (slippage) = solid
   fill + border (current teal-light). Status labels (AMM) = outline or text-only, no solid fill.
   Then the AMM tag stops competing with the slippage button.
4. Optional: introduce a dedicated semantic var (e.g. `--route-amm`, `--route-issuance`) so the
   chips and tags reference the same source of truth and can't drift again.

## Inline (JS) colors of note
- Chain badges: Optimism `#FF0420`, others via icons.
- Charts (depth/price) use a matplotlib-ish categorical set (`#1f77b4 #ff7f0e #2ca02c …`) —
  independent of the brand palette; fine to leave, but not brand-aligned.
