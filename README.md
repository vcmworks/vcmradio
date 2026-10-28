# Tarang Radio

Live Telugu radio in the browser. Station list comes from the open Radio Browser directory; audio streams straight from each broadcaster to your browser. Also supports Hindi, Tamil, Kannada and Malayalam via the language menu.

## Run it

| Where | Command | Open |
|---|---|---|
| Any machine with Node 20+ | `node server.js` | `http://localhost:8080` |
| Docker | `docker build -t tarang-radio .` then `docker run -d -p 8080:8080 --restart unless-stopped tarang-radio` | `http://localhost:8080` |
| Phone on the same Wi-Fi | run either command above on your PC, allow port 8080 in Windows Firewall | `http://<PC-IP>:8080` |

Windows firewall rule (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Tarang Radio" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

## Features

| Feature | Notes |
|---|---|
| Live playback | MP3, AAC, Ogg and HLS (.m3u8, loaded on demand via hls.js) |
| Browse | Search, genre chips, location filter, sort by listeners, votes, name or bitrate |
| Player | Sticky bar, previous/next, stop/play, volume, mute, sleep timer, space bar toggles, `/` focuses search |
| Phone controls | Lock-screen and headset buttons via the Media Session API |
| Favorites | Saved in the browser |
| Add stream | Paste any direct stream URL; saved in the browser |
| Etiquette | Reports each play to the directory, as its API asks |

## Host it on GitHub Pages (free)

1. Create a **public** repository on GitHub and push this folder to the `main` branch.
2. In the repository: **Settings, Pages, Build and deployment, Source: GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) publishes the `public/` folder on every push.
4. Your site appears at `https://<username>.github.io/<repository>/` after about a minute (see the **Actions** tab).

Pages is HTTPS only, so plain-http streams are hidden there (see below). Private repositories need a paid GitHub plan for Pages.

## Important: HTTP vs HTTPS

Many radio streams are plain `http://`. Browsers block those on an `https://` page ("mixed content").

- On `http://localhost` or `http://<LAN-IP>` every station can play.
- If you later host it on a public `https://` domain, the site hides plain-http stations automatically and shows how many were hidden. Only https streams will play.
- A server-side stream proxy would lift that limit, but it also turns your server into an open relay, so it is deliberately not included.

## Tests

`npm test` runs an end-to-end test in Chromium with a mocked directory and a generated audio stream. It needs Playwright (`npm i -D playwright && npx playwright install chromium`).

## Files

| File | Purpose |
|---|---|
| `public/index.html`, `style.css`, `app.js` | The whole site, no build step |
| `server.js` | Zero-dependency static server with a content security policy |
| `tests/e2e.cjs` | Browser test |
