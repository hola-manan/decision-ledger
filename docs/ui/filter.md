# Screen: Grade filter

A strip above the Decisions tree, in the Decision Ledger sidebar (D-021). It narrows which decisions the tree shows by grade. It is view-only: nothing is extracted, stored or deleted differently because of it.

## Purpose and primary action

Show only the decisions that matter right now, for example "only the hard-to-undo ones" (Reversibility 1–2). The primary action is dragging a handle.

## Layout

One block per parameter in `.ledger/config.json`, in config order:

```
Reversibility                                   1 – 2
[ ●━━━━━━━●- - - - - - - - - - - - - - - - - - - - ]
 1        2        3        4        5
practically irreversible            trivial to undo

Code span                                       1 – 5
[ ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● ]
 1        2        3        4        5
single line or function           whole codebase

Showing 7 of 36 decisions                       Reset
```

- **Name** on the left, the **selected range** on the right ("2 – 4", or "3" when both handles meet).
- **Track** with two handles. The part between the handles is filled with the primary colour; the rest is the border colour.
- **Grade marks** 1 to 5 under the track, aligned with the handle stops.
- **End labels**: the parameter's `low` text under 1 and its `high` text under 5, in secondary text, each truncated with an ellipsis at narrow widths (the full text is the handle's description).
- **Footer**: "Showing N of M decisions" and a text-style "Reset" button, shown only while a range is narrowed.

## Behaviour

- Handles snap to whole grades. They can meet (range "3") but never cross. Moving one past the other stops it there, except when they started together: then the move hands over to the other handle, so "3" can widen either way.
- The tree updates when a handle is released, or on each arrow-key step.
- A decision is shown only if its grade fits **every** narrowed parameter. A decision with no grade for a narrowed parameter is hidden.
- A node whose decisions are all hidden is hidden. The order of what remains never changes.
- The ranges are remembered per project and are still there after a reload.
- The tree's filter icon shows or hides the strip; hiding it does not clear the filter. While a range is narrowed the icon is the filled filter and the tree's description says "filtered".

## States

1. **Loading**: before the extension answers, a single secondary line, "Loading parameters…".
2. **Empty**: no decisions on this branch yet. The sliders still show (they're disabled); footer: "No decisions yet".
3. **Error**: `.ledger/config.json` can't be read. A danger callout with the reason and the button "Edit Decision Parameters" (runs `ledger.editParameters`). The tree is shown unfiltered.
4. **Success**: the sliders and the footer.
5. **Nothing matches** (in the tree, not the strip): when the filter hides every decision, the Decisions view says "No decisions match the grade filter." with a "Reset Grade Filter" link, instead of its usual welcome text. This shows even while the strip is hidden.

Without a `.ledger/config.json`, the strip shows the default parameters. Opening the strip never creates the file.

## Accessibility

- Each handle is a native `input type="range"` (keyboard: arrows, Home, End; screen readers announce the value).
- Labels: "Reversibility, lowest grade" and "Reversibility, highest grade"; `aria-valuetext` reads "2, practically irreversible" at the ends and the number between.
- Focus ring on the focused handle, using `--dl-color-focus`, shown at once: on `:focus`, so a handle clicked with the mouse also shows where the arrow keys will act.
- When two handles meet and the top one is moved past the other, the move hands over to the other handle (with the keyboard, focus follows), so a range like "3" can widen either way.
- After Reset, focus moves to the first handle (the button hides itself).
- The count is a polite live region.

## Copy reference

| Where | Text |
|---|---|
| Footer | Showing {n} of {m} decisions |
| Footer, nothing on the branch | No decisions yet |
| Reset | Reset |
| Loading | Loading parameters… |
| Error title | Can't read decision parameters |
| Error action | Edit Decision Parameters |
| Tree description while narrowed | on {branch} · filtered |
