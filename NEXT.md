# Next

_Updated 2026-09-20 — branch playlist-download_

## State
Batch now extracts ASR-gated videos: seed-once watch nav + Tier 1.7 player
coercion (`30ac102`; 1.6/1.7 wiring in `5d4376b`/`8ace6db`). Verified: 3-video
LL probe 2/3 with a real 556-cue Hegel SRT; LL spec **2 passed (46.7s)**.

## Open threads
- **Player-path flake**: Hegel succeeded 2/4 runs (attestation/readiness timing).
  Start: lengthen `seedWatchPage` readiness wait in `translation-manager.mjs`.
- **Public batch on ASR-only content** + **single-video ~1-in-4 flake**: still open.
- **Weekly CI smoke test** (public specs + auto-issue): designed, not written —
  needs `.github/workflows/weekly-e2e.yml` + `.puppeteer-profile/` gitignore line.

## Running / unfinished
- Nothing in background. Golden profile holds the working login (gitignored).

## Don't redo
- **Cold API calls can never serve ASR-gated tracks** (all clients → LOGIN_REQUIRED).
  Borrow player attestation (seed + coercion), don't rotate clients/headers.
- **Playlist pages have no `movie_player`** — Tier 1.7 needs the seeded watch page.
- **Do NOT copy cookies between profiles** (app-bound encryption); `npm run e2e:login`.
- **Row 0 of LL is not a fixture**; `_errors.txt`-only ZIP is a bug, not BotGuard.
- **Proxy must be up**; no `--disable-software-rasterizer`; `activeTab` suffices for tab nav.
- Full history in `docs/LESSONS.md`.
