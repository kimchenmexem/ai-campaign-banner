# MEXEM banner — reference design rules

Extracted from 5 production reference banners (4 leaderboards + 1 portrait) supplied by the brand team. These are the **target rules** the AI Visual Planner + renderer should produce. Where current behavior differs, this doc flags the mismatch.

---

## 0. Critical brand-spec mismatch (read this first)

The reference banners use **YELLOW** as the dominant accent color, not the red `#D81222` listed in [brand-input/brand-spec/brand-spec.json](../brand-input/brand-spec/brand-spec.json) (where red is documented as the *IBKR* partnership color).

Estimated yellow from screenshots: **`#F5C518`** (similar to brand yellow used on MEXEM's website / app BUY button).

Action items:
1. Confirm with brand team whether yellow is now the primary accent.
2. If yes — add yellow to `brand-spec.json` under `colors.accent` and regenerate `brand-kit-lite.generated.json`.
3. Red (`#D81222`) stays as the dedicated IBKR partnership color and shouldn't be used for general accent.

Until that's confirmed, the renderer keeps using red. After confirmation, swap accent → yellow and the rules below become directly executable.

---

## 1. Color palette (target)

| Token | Hex | Usage |
|---|---|---|
| Primary navy darkest | `#00122C` | Background top-left, gradient start |
| Primary navy bright | `#006A97` | Background bottom-right, gradient end |
| Accent yellow | `#F5C518` | Headline emphasis word, CTA band (leaderboard), highlight elements |
| Pure white | `#FFFFFF` | Headline non-emphasis text, sub-text, disclaimer, CTA pill (portrait) |
| Disclaimer white | `#FFFFFF` @ 0.85 opacity | Disclaimer line |
| IBKR red | `#D81222` | Reserved for "Powered by InteractiveBrokers" lockup ONLY |
| CTA dark text | `#0A0F1F` (near-black) | Text on yellow CTA band, text on white CTA pill |

**Hard rule:** outside the IBKR partnership lockup, red is **not used**. Yellow is the only accent.

---

## 2. Background (all formats)

- **Linear gradient**, ~135° (top-left → bottom-right) from `#00122C` → `#006A97`.
- The right side of the canvas (where the visual sits in leaderboards) is slightly LIGHTER, creating a subtle vignette behind the device mockup.
- Subtle ghost candlestick pattern in the unused canvas region at very low opacity (~0.06–0.08). Optional. Used in the portrait example below the CTA, in the bottom 30% of the canvas.
- **No motif** (no chart silhouette, no wave curve, no node network). The references are intentionally clean — visual variety comes from the device mockup, not from generated SVG ornaments.

---

## 3. Logo placement

### Leaderboard (1200×628)
- MEXEM wordmark only (white, landscape variant).
- Position: top-left, padding ~50px from edges.
- Size: ~200px wide × ~50px tall (about 17% of canvas width).
- **No "Powered by InteractiveBrokers" sub-lockup on the leaderboard.**

### Portrait (1080×1920)
- MEXEM wordmark, centered horizontally near the top.
- Size: ~700px wide (much larger — ~65% of canvas width).
- **WITH "Powered by InteractiveBrokers" sub-lockup directly below**, including the small red "IB" icon.
- Vertical position: top ~10–15% of canvas.

### Square (1080×1080)
- Not in the references. Best estimate: MEXEM wordmark centered top, ~50% of canvas width, with optional "Powered by IB" sub-lockup below.

---

## 4. Headline — the most distinctive rule

### Two-color split
The headline ALWAYS has TWO colors:
- **First part = the "key claim"** → rendered in **yellow** (`#F5C518`)
- **Rest of the headline** → rendered in **white** (`#FFFFFF`)

Examples from references:
| Yellow part | White part |
|---|---|
| `ONE INVESTING ACCOUNT.` | `ACCESS ACROSS EVERY DEVICE.` |
| `GLOBAL INVESTING,` | `LOCAL SUPPORT.` |
| `INVEST BEYOND STOCKS` | `WITH OPTIONS TRADING` |
| `ACCESS FUTURES TRADING` | `IN ONE PLATFORM` |
| `BUILD YOUR ISA AND GET UP TO £1000 IN CASH!` (portrait) | (single color in this case — portrait variant treats the £1000 as the visual emphasis instead) |

The yellow part is typically the **first sentence/clause** ending in a comma or period. The white part is the supporting clause.

### Typography
- **ALL CAPS** always.
- Sans-serif, bold (700+).
- Tight letter-spacing (negative tracking ~ -1 to -2).
- Multi-line wrap is fine — wrap at natural word boundaries.
- **No drop shadow.** No outline. Pure flat type.
- Line-height ~1.05 (lines hugging close).

### Sizing
| Format | Headline font-size |
|---|---|
| 1200×628 leaderboard | ~85–95 px |
| 1080×1080 square | ~70–80 px (estimated) |
| 1080×1920 portrait | ~120–160 px (the references show very large portrait headlines) |

### Mega-stat treatment (portrait only)
When the headline contains a numeric/currency figure (`£1000`, `$0`, `150+`), that figure can be rendered at **2× the surrounding headline size** as a "stat hero" — see the ISA reference. Other lines wrap around it.

---

## 5. Disclaimer

- **Color:** white (`#FFFFFF`) at full opacity.
- **Font size:** ~22–26px on leaderboard, ~28–32px on portrait.
- **Placement:** ALWAYS between the headline block and the CTA — NOT at the very bottom under the CTA.
- **Wrapping:** single line on leaderboard ("Caution. Investing involves risk of loss."). Two lines on portrait if longer.
- **Centered alignment** on portrait. **Left-aligned** on leaderboard (matching the headline's text-block).
- No legal-band rectangle behind it. Just text on the gradient.

---

## 6. CTA — two completely different forms

### Leaderboard CTA = full-width yellow band (NEW)
- **Position:** anchored to the bottom edge of the canvas. Full width.
- **Height:** ~80–90 px (about 13% of 1200×628 canvas height).
- **Background color:** yellow `#F5C518`.
- **Text:** "START INVESTING TODAY >" (or similar) — ALL CAPS, dark navy/black `#0A0F1F`, ~26–32px font, centered horizontally within the band.
- **Chevron:** unicode `>` or simple SVG chevron, immediately after the text with a small gap.
- **Border-radius:** 0 (sharp corners — touches the canvas edges).
- **Replaces** the current pill-shaped CTA centered on the gradient.

### Portrait CTA = white pill button
- **Background:** white `#FFFFFF`.
- **Text:** "START INVESTING" — ALL CAPS, dark navy/black `#0A0F1F`, ~36px font, centered.
- **Border-radius:** half-height (full pill).
- **Width:** ~60% of canvas width, horizontally centered.
- **Position:** vertically below the headline, above the disclaimer (NOT bottom-anchored).
- **No chevron** in the portrait example.
- This stays close to today's renderer behavior, just with white fill instead of brand-blue.

---

## 7. Visual region (the device mockup)

### Leaderboard
- **Position:** right side of canvas, x ≈ 50–55% of canvas width onward.
- **Width:** about 40–45% of canvas width.
- **Vertical:** centered or slightly below middle, leaving room for the CTA band at bottom.
- **Content variants:**
  - Single phone (with chart) + accessory props (headphones, chat bubbles with country flags).
  - Multi-device (laptop + phone + watch) clustered together.
  - Two phones side by side (one app screen, one login screen).
- **Drop shadow:** subtle, soft shadow under devices.
- **No frame, no decoration around** — devices float on the gradient.

### Portrait
- **Position:** bottom of canvas, centered horizontally.
- **Width:** ~60–70% of canvas width.
- **Vertical:** bottom 25–30% of canvas.
- **Content:** single phone, larger.
- **Background under phone:** the subtle ghost candlestick pattern fills around the phone for context.

---

## 8. Layout grids

### Leaderboard (1200×628) — text-leading + bottom-band CTA

```
╔════════════════════════════════════════════════════════════╗
║ ┌──────────┐                                               ║   ← top: 50px padding
║ │  MEXEM   │                                               ║
║ └──────────┘                                               ║
║                                                            ║
║   YELLOW HEADLINE LINE 1,                ┌─────────────┐  ║   ← headline starts ~y=220
║   WHITE HEADLINE LINE 2.                 │             │  ║
║                                          │   DEVICE    │  ║
║   Caution. Investing involves...         │   MOCKUP    │  ║
║                                          │             │  ║
║                                          └─────────────┘  ║
║                                                            ║
║ ╔══════════════════════════════════════════════════════╗  ║   ← CTA band starts ~y=540
║ ║       START INVESTING TODAY  >                       ║  ║   yellow #F5C518, full-width
║ ╚══════════════════════════════════════════════════════╝  ║
╚════════════════════════════════════════════════════════════╝
1200 × 628
```

| Region | x | y | w | h |
|---|---|---|---|---|
| Logo | 50 | 50 | ~200 | ~50 |
| Headline block | 50 | 200 | ~600 | ~260 |
| Disclaimer | 50 | 470 | ~600 | ~30 |
| Visual region | 700 | 80 | ~450 | ~440 |
| CTA band | 0 | 540 | 1200 | 88 |

### Portrait (1080×1920) — centered editorial + bottom phone

```
╔══════════════════════════╗
║                          ║
║       ┌──MEXEM──┐        ║   ← logo block centered, ~y=140
║       │ Powered │        ║
║       │  by IB  │        ║
║       └─────────┘        ║
║                          ║
║   BUILD YOUR ISA         ║   ← headline starts ~y=400
║   AND GET UP TO          ║
║                          ║
║      £ 1 0 0 0           ║   ← mega-stat ~y=700
║                          ║
║       IN CASH!           ║   ← y=950 ish
║                          ║
║   ┌──────────────┐       ║   ← white pill CTA ~y=1180
║   │ START INVEST │       ║
║   └──────────────┘       ║
║                          ║
║   Caution. Investing...  ║   ← disclaimer ~y=1300
║                          ║
║      ┌──────────┐        ║   ← phone mockup, bottom ~y=1380
║      │   AAPL   │        ║
║      │  chart   │        ║
║      └──────────┘        ║
║                          ║
║  (subtle candlestick     ║
║   pattern @ 0.07 opa)    ║
╚══════════════════════════╝
1080 × 1920
```

| Region | x | y | w | h |
|---|---|---|---|---|
| Logo + sub-lockup | 190 | 140 | 700 | 220 |
| Headline block (centered) | 60 | 400 | 960 | 700 |
| CTA pill (centered) | 290 | 1180 | 500 | 80 |
| Disclaimer (centered) | 60 | 1290 | 960 | 60 |
| Phone mockup (centered) | 280 | 1380 | 520 | 540 |
| Background candlestick texture | 0 | 1200 | 1080 | 720 (low opacity) |

### Square (1080×1080) — extrapolated from leaderboard pattern

Reference uses a similar text-leading + visual-right layout, scaled. Logo top-center is also valid given square's symmetric proportions. Best to A/B test once we have a real square reference.

---

## 9. Decorative elements

The references are **deliberately minimal**:
- No motifs (chart_silhouette, wave_curve, etc.) — except the very subtle candlestick texture in the portrait background.
- No patterns (diagonal lines, dot grid).
- No corner brackets.
- No badges or chips.

Visual variety comes from:
1. Device mockup choice (single phone vs multi-device vs phone+headphones)
2. Subtle background gradient direction (lighter on the right where visual is)
3. The 2-color headline split

**Implication for the AI Visual Planner:** for campaigns matching this reference style, primary_visual should be `mockup` or `screenshot`, motif should be `none`, pattern should be `none`. The current "motif-led" output style does NOT match these references.

---

## 10. Differences vs current renderer (action list)

| Property | Current renderer | Reference target | Priority |
|---|---|---|---|
| Accent color | Red `#D81222` | Yellow `#F5C518` | **HIGH** — confirm with brand team first |
| Headline | Single color (white on dark) | 2-color split (yellow first part, white rest) | **HIGH** — needs new manifest field + AI prompt rule |
| CTA on leaderboard | Centered pill or filled rectangle | Full-width bottom band | **HIGH** — new layout primitive |
| CTA on portrait | Filled pill, brand-blue | White pill, dark text | MEDIUM — easy color swap |
| Disclaimer position | Below CTA | Above CTA, between headline and CTA | MEDIUM — small layout change |
| Decorative motifs | Often visible (chart, wave, etc.) | None or very subtle candlestick texture | MEDIUM — already a knob (use_motif) |
| Logo on portrait | Top-left, small | Top-center, large, with IBKR sub-lockup | MEDIUM — new orientation rule |
| Visual region | Various sizes | Right ~40–45% on leaderboard, bottom ~25–30% on portrait | LOW — close to today |
| Background gradient | 135° navy gradient | Same — already matches | ✓ |
| Typography | Poppins, ALL CAPS, bold | Same — already matches | ✓ |

---

## 11. Recommended implementation order

If brand team confirms yellow as accent:

1. **Color first** — add yellow to `brand-spec.json`, regenerate `brand-kit-lite.generated.json`. Replace `accent_usage` color resolution to use yellow instead of red. Red stays only on the IBKR sub-lockup.
2. **Two-color headline** — add a `headline_emphasis_split` field to the manifest's headline element. Renderer wraps the first sentence in yellow `<span>`, rest in white. AI prompt teaches the rule.
3. **Leaderboard CTA band** — add a new CTA layout primitive `bottom_band` (full-width, sharp corners, anchored to canvas bottom). Add `cta_strategy.placement="bottom_band"` enum value or treat as a refinement of `bottom_center` when format=leaderboard.
4. **Portrait CTA color** — when format=1080×1920, default CTA fill to white (with dark text) instead of brand-blue.
5. **Logo orientation** — when format=1080×1920, render logo top-center with `Powered by InteractiveBrokers` sub-lockup beneath.
6. **Disclaimer positioning** — move disclaimer to between headline and CTA (above CTA), not below.
7. **Motif suppression** — for campaigns marked "production" / "reference-style", default motif to `none` and pattern to `none`.

Each item is a small, self-contained change. None require renderer rewrites — they're additions to the existing primitives.

---

## 12. AI prompt addendum (when implementing)

When the system prompt is updated for reference-style banners, it should include:

```
HEADLINE STRUCTURE — 2-color split mandatory:
  - The first clause (ending in comma or period) is the "key claim" and renders in YELLOW.
  - The remaining clause(s) render in WHITE.
  - Examples:
    "ONE INVESTING ACCOUNT." (yellow) + "ACCESS ACROSS EVERY DEVICE." (white)
    "GLOBAL INVESTING," (yellow) + "LOCAL SUPPORT." (white)
  - Write headlines that have a natural break where the emphasis ends.
  - ALL CAPS always. No drop shadow.

DECORATIVE LAYERS — minimal by default:
  - No motif unless the brief explicitly asks for "data feel" or "chart aesthetic".
  - No pattern unless the brief asks for "texture-led".
  - The visual variety comes from the device mockup choice + the headline split, not from generated SVG.

CTA — two forms:
  - Leaderboard (1200x628): full-width yellow band at canvas bottom, dark text, "START INVESTING TODAY >".
  - Portrait (1080x1920): white pill, dark text, centered horizontally between headline and disclaimer.
```

---

## 13. References

The 5 reference banners this document is built from:
1. Portrait — "Build your ISA and get up to £1000 in cash!" + AAPL phone mockup
2. Leaderboard — "Global Investing, Local Support." + phone+headphones+flags
3. Leaderboard — "One Investing Account. Access across every device." + multi-device
4. Leaderboard — "Invest Beyond Stocks With Options Trading" + laptop+phone
5. Leaderboard — "Access Futures Trading In One Platform" + two phones

Saved by the operator on 2026-05-06.
