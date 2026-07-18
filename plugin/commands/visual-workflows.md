---
description: Open the visual-workflows dashboard — start the local bridge if it is not already running and confirm this session is connected.
allowed-tools: Bash(curl:*), Bash(npm:*), Bash(npx:*), Bash(sleep:*)
---

Bring up the visual-workflows live dashboard for this session. Follow these
steps exactly:

1. Check whether the bridge is already running (default port 4777, or
   `$VW_PORT` if set):

   ```
   curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:4777/health
   ```

2. If that printed `200`, the bridge is up — skip to step 4.

3. If the bridge is down, start it in the background (do NOT block on it):
   - If a local clone of the visual-workflows repo is available, run
     `npm run start --prefix <path-to-visual-workflows-repo>` as a
     background task.
   - Otherwise tell the user the bridge is not running and ask them to
     start it from a clone (`npm start`); the packages are not on npm yet,
     so there is no `npx` install path.

   Then wait a moment (`sleep 2`) and re-run the health check from step 1.
   If it still fails after ~10 seconds, report the failure and stop — do
   not retry forever.

4. Tell the user the dashboard is ready:
   - Print the URL: **http://127.0.0.1:4777**
   - Confirm that this session's hooks are forwarding events (the plugin's
     hooks POST to the bridge automatically; a healthy bridge means new
     events from this session will appear once the next tool call runs).
   - Mention the hands-off option: `visual-workflows connect --auto-open`
     makes the dashboard open by itself whenever a session spawns agents and
     offer to close when the run ends, so this command is not needed each time.

Keep the output short: the URL, bridge status (already running / started
just now), and one line about what the user will see.
