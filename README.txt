HAALAND MATCH INDEX — STATIC PWA

Files:
- index.html               entire app (HTML + CSS + JavaScript + match data)
- match-data.js            source fetch, match normalization, and saved data
- sw.js                    offline cache/service worker
- manifest.webmanifest     install metadata
- haaland-portrait.jpg     main photo
- icon-192.png / icon-512.png / apple-touch-icon.png
- favicon.svg
- og.png                   social sharing image

HOSTING
Upload the CONTENTS of this folder to any static HTTPS host. No build command is needed.

IPHONE INSTALL
1. Open the HTTPS site in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch it once while online so all core files are cached.
5. It will then continue to work offline.

UPDATING
Edit index.html and redeploy the folder. When the installed app is opened online, the service worker uses the latest network files and updates its cache. If you change the list of files cached by sw.js, also change the CACHE value (for example v1 -> v2).

MATCH DATA
The page fetches Manchester City and Norway fixtures and results from ESPN whenever it opens, returns to the foreground, restores from browser history, or reconnects. It also refreshes every minute while visible. The public, browser-accessible feed covers all competitions and needs no API key or backend. Each team's fixtures and results update together; a failed request preserves that team's last saved data and update time. Successful responses are saved on the device for offline use. The original August 29 snapshot is used only until a device has fetched data successfully. The on-page status identifies saved data and refresh failures.

Source: https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/teams/{382|464}/schedule?region=us&lang=en&contentorigin=espn (results); append &fixture=true for fixtures. ESPN's public endpoint is undocumented and may change. Only confirmed completed games with valid scores enter Recent. Haaland's latest goal count comes from the match summary when available; unavailable goal stats are never shown as zero. Unconfirmed kickoff times show Time TBC without a countdown.

LOCAL TEST
Opening index.html directly works for the UI, but browsers do not register service workers from file:// URLs. For a real PWA/offline-install test, serve this folder over HTTPS or localhost.

Run regression checks with Node.js: node --test tests/*.test.cjs
