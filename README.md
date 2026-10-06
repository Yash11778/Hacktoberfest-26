# Side Quest

A short walking scavenger hunt around wherever you're standing. The clues are written
by **Gemma, running entirely in your browser** (WebGPU via [WebLLM](https://github.com/mlc-ai/web-llm)).
Your location never leaves the phone.

Built for the [Hacktoberfest Open-Source AI Challenge, Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05).

## How it works

1. Pick how long you have (15–60 min) and a clue style (playful, poetic, detective, for kids).
2. The app finds interesting places nearby from **OpenStreetMap** and **Wikipedia**:
   parks, temples, murals, old trees, bookshops, historic buildings.
3. A small planner picks a loop of 2–4 varied stops that fits your time.
4. **Gemma writes a riddle for each stop** plus one small thing to notice when you get there.
5. Put the phone away. Check in when you think you've found it (it buzzes if the screen is on).
6. At the end, Gemma writes you a three-line postcard of the walk, saved only on your device.

## Why open matters here

- **Privacy.** A hosted model would need your live location for every clue. Here the model
  runs on your device. The only network requests are map lookups for a **bounding box
  snapped to a ~1 km grid**, never your exact point.
- **Works offline after the first run.** Model weights are cached in the browser. Map results
  are cached per area for a week.
- **Costs nothing.** No API keys, no accounts, no server. It's a static site.
- **Swappable.** Choose Gemma 3 1B (~0.7 GB, for phones) or Gemma 2 2B (~1.4 GB, better clues).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. You need a browser with WebGPU (Chrome or Edge on desktop,
Chrome on Android 12+). Without WebGPU it still works, with built-in template clues.

Testing at your desk:

- `?at=18.5195,73.8553` fakes your start point (Shaniwar Wada, Pune).
- `?sim` adds a **Teleport** button that jumps you to the current stop.

```
http://localhost:5173/?at=18.5195,73.8553&sim
```

Location access needs HTTPS on a phone, so deploy it (any static host: Vercel, Netlify,
GitHub Pages) to try it outside.

## Stack

- TypeScript + Vite, no framework, ~20 kB of app code
- [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) running Gemma in a Web Worker
- OpenStreetMap via the public Overpass API, plus the Wikipedia geosearch API (both keyless)

## Known limits

- Browsers pause GPS when the screen is off, so it can only buzz on arrival while the
  screen is on. Otherwise tap **I think I'm here**.
- Public Overpass servers are often overloaded. The app tries three of them, falls back to
  Wikipedia alone, and caches each area.
- How good the walk is depends on how well your area is mapped in OpenStreetMap.

## License

MIT. Map data © OpenStreetMap contributors (ODbL). Wikipedia text is CC BY-SA.
Gemma is used under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
