# Chromebook → Twitch

A one-page, no-dependency web app that captures your screen and streams it
straight to Twitch — no desktop app, no watermark. It's built to be pushed to
GitHub and hosted free on GitHub Pages, so it runs entirely in your Chromebook's
browser.

## Setup (5 minutes)

1. Create a new GitHub repo (public or private both work for Pages).
2. Add `index.html` from this project to the repo root, and commit/push it.
3. In the repo, go to **Settings → Pages**. Under "Build and deployment," set
   **Source** to "Deploy from a branch," pick your main branch and `/ (root)`,
   then save.
4. GitHub gives you a URL like `https://yourname.github.io/repo-name/`. Open
   that on your Chromebook, in Chrome.

## Using it

1. Get your stream key from the
   [Twitch dashboard](https://dashboard.twitch.tv/settings/stream), under
   **Settings → Stream**. Treat it like a password — anyone with it can stream
   to your channel.
2. Paste the key into the app.
3. Click **Share screen** and pick the screen, window, or tab to broadcast.
4. Click **Go live**. The status dot turns red once Twitch confirms the
   connection.
5. Click **Stop** when you're done (or just close Chrome's "stop sharing" bar).

## How it works

- **Capture**: `getDisplayMedia()` is the same browser API that OS-level
  screen recorders use — it's what triggers Chrome's native "share your
  screen" picker. No extension needed.
- **Delivery**: Twitch has an (unofficial, but functional) WHIP endpoint —
  WebRTC-HTTP Ingestion Protocol, the same standard OBS uses for its own WHIP
  output. The page turns your capture into a WebRTC connection and sends
  Twitch one HTTP request to set it up. After that, video flows directly from
  your browser tab to Twitch's servers.
- **No watermark**: there's no third-party app in the loop to brand the
  output — it's your own code talking directly to Twitch with your own key.

## Things to know

- **This depends on a beta/unofficial Twitch feature.** Twitch's WHIP ingest
  (`g.webrtc.live-video.net`) isn't officially documented the way RTMP is —
  it's the same endpoint OBS's built-in WHIP output uses, and it's been
  working consistently, but Twitch could change or restrict it without
  notice. If the app suddenly stops connecting, that's the most likely cause.
- **Twitch's WHIP endpoint requires H264 video + Opus audio.** The app forces
  Chrome to offer H264, which it supports out of the box, so this should be
  transparent — but it's why the codec-preference code in `index.html` exists.
- **No scenes, overlays, or multi-guest calls.** This is a screen encoder, not
  a production suite — think "OBS's stream button," not "StreamYard." If you
  want overlays or multiple sources later, that's a separate feature to add.
- **System audio while sharing "Entire Screen" varies by ChromeOS version.**
  Sharing a specific **Chrome tab** with "Share tab audio" checked is the most
  reliable way to capture app/game sound. The microphone toggle always works
  regardless.
- **Closing the tab ends the stream.** There's no background service — the
  browser tab is the encoder, so it needs to stay open while you're live.
- **Nothing is stored anywhere.** The stream key lives only in the page's
  memory for that session; there's no backend, database, or analytics.

## Troubleshooting

- **"Twitch rejected the connection"**: double check the stream key was
  copied correctly and hasn't been reset on the dashboard.
- **Connects but no video on Twitch**: open Chrome's DevTools console (F12)
  for errors — a codec negotiation failure is the most likely cause on
  unusual hardware.
- **CORS error in the console**: this would mean Twitch's WHIP endpoint has
  changed its cross-origin policy; the fix would be a small relay server
  rather than a code tweak here.
