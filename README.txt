HAALAND MATCH INDEX — STATIC PWA

Files:
- index.html               entire app (HTML + CSS + JavaScript + match data)
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
The fixture and result lists in index.html are a manually maintained snapshot, not a live score feed. Only fixtures with a scheduled kickoff in the future appear in Upcoming and Next match. The page advances automatically at kickoff and refreshes when reopened or brought to the foreground. Update the recent list separately with verified final scores; elapsed time alone does not confirm a result.

LOCAL TEST
Opening index.html directly works for the UI, but browsers do not register service workers from file:// URLs. For a real PWA/offline-install test, serve this folder over HTTPS or localhost.

Run schedule regression checks with Node.js: node --test tests/match-schedule.test.cjs
