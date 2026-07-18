# Assets

## demo.gif (README hero)

`assets/demo.gif` is the animated hero at the top of the root
[README](../README.md) (referenced there as `<img src="assets/demo.gif">`): the
built-in 7-agent demo run (planner, research, two parallel coders, test, review,
fix, retest, present), dark theme, overview mode, with the `DEMO` badge visible
throughout.

It is a heavy file (~6.5 MB) because it is the pitch and must be self-explanatory
with no docs. If you regenerate it, keep it around that budget so the README loads
reasonably. Switching the hero to a `<video>`/WebM would cut the payload
substantially and is a possible future swap.

### Regenerating the GIF

- Content: the scripted demo run end to end, ~15 seconds, loopable.
- Dark theme, overview mode; make sure the attention rail is visible when the
  failure hits.
- 800 px wide.
- The `DEMO` badge must be visible (simulated data is always labeled).
- No real code, paths, or machine-identifying details in frame; the scripted demo
  content is safe by construction.

After recording, replace `assets/demo.gif` in place — the README `<img>` already
points at it.

## screenshots/

Stills captured from the demo run (empty state, mid-run dark/light, attention
rail, completed run) for use in docs and issues. Not currently embedded in the
README. Same honesty rule: `DEMO` badge visible, no real paths or secrets in
frame.
