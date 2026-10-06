import './style.css';
import { MODELS, VIBES, hasWebGPU, isDownloaded, loadModel, templateClue, writeClue, writeFieldNote, type Clue, type Vibe } from './ai';
import { bearing, compass, currentPosition, distance, roundDistance, type LatLng } from './geo';
import { fetchPlaces, type Place } from './places';
import { loopMinutes, planLoop, searchRadius } from './route';

interface Stop {
  place: Place;
  clue: Clue;
  found: boolean;
}

interface Quest {
  home: LatLng;
  minutes: number;
  vibe: Vibe;
  stops: Stop[];
  current: number;
  startedAt: number;
}

interface LogEntry {
  date: string;
  minutes: number;
  places: string[];
  note: string;
}

const app = document.querySelector<HTMLDivElement>('#app')!;
const params = new URLSearchParams(location.search);
/** `?at=lat,lng` fakes the start point; `?sim` adds a "teleport" button. For demos and desktop testing. */
const fakeHome = params.get('at')?.split(',').map(Number);
const sim = params.has('sim');

const settings = {
  minutes: 30,
  vibe: 'playful' as Vibe,
  model: localStorage.getItem('sq-model') ?? MODELS[0].id,
};

let quest: Quest | null = null;
let watchId: number | null = null;
let here: LatLng | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function readLog(): LogEntry[] {
  try {
    return JSON.parse(localStorage.getItem('sq-log') ?? '[]');
  } catch {
    return [];
  }
}

function saveLog(entry: LogEntry) {
  try {
    localStorage.setItem('sq-log', JSON.stringify([entry, ...readLog()].slice(0, 30)));
  } catch {
    /* private mode: the walk still happened */
  }
}

// ---------- Home ----------

async function renderHome() {
  stopWatching();
  const gpu = await hasWebGPU();
  const log = readLog();
  app.innerHTML = `
    <main class="screen home">
      <header>
        <p class="kicker">Side Quest</p>
        <h1>Go find something<br/>you walk past every day.</h1>
        <p class="lede">A short walking hunt around where you're standing, with clues written by an AI that runs on this phone. Your location never leaves it.</p>
      </header>

      <section>
        <h2>How long have you got?</h2>
        <div class="chips" id="minutes">
          ${[15, 30, 45, 60].map((m) => `<button class="chip ${m === settings.minutes ? 'on' : ''}" data-v="${m}">${m} min</button>`).join('')}
        </div>
      </section>

      <section>
        <h2>Clue style</h2>
        <div class="chips" id="vibe">
          ${VIBES.map((v) => `<button class="chip ${v === settings.vibe ? 'on' : ''}" data-v="${v}">${v}</button>`).join('')}
        </div>
      </section>

      ${
        gpu
          ? `<section>
              <h2>Model</h2>
              <select id="model">
                ${MODELS.map((m) => `<option value="${m.id}" ${m.id === settings.model ? 'selected' : ''}>${m.label} · ${m.size}</option>`).join('')}
              </select>
              <p class="hint" id="model-state">Checking…</p>
            </section>`
          : `<p class="warn">This browser has no WebGPU, so the AI can't run here. You'll get simple built-in clues instead. Chrome on Android 12+ or desktop Chrome/Edge will run the model.</p>`
      }

      <button class="primary" id="go">Make my quest</button>
      <p class="status" id="status" role="status"></p>

      ${
        log.length
          ? `<section class="log">
              <h2>Your walks</h2>
              ${log
                .slice(0, 5)
                .map((l) => `<article><p class="meta">${esc(l.date)} · ${l.minutes} min</p><p>${esc(l.places.join(' → '))}</p></article>`)
                .join('')}
            </section>`
          : ''
      }
      <footer>Map data © OpenStreetMap contributors · Gemma runs locally via WebLLM</footer>
    </main>`;

  bindChips('minutes', (v) => (settings.minutes = Number(v)));
  bindChips('vibe', (v) => (settings.vibe = v as Vibe));
  const select = document.querySelector<HTMLSelectElement>('#model');
  if (select) {
    const showState = () => {
      const m = MODELS.find((x) => x.id === settings.model)!;
      document.querySelector('#model-state')!.textContent = isDownloaded(m.id)
        ? 'Downloaded. Works offline.'
        : `First run downloads ${m.size} once, then it's cached on this device.`;
    };
    select.onchange = () => {
      settings.model = select.value;
      localStorage.setItem('sq-model', select.value);
      showState();
    };
    showState();
  }
  document.querySelector<HTMLButtonElement>('#go')!.onclick = () => startQuest(gpu);
}

function bindChips(id: string, set: (v: string) => void) {
  const group = document.getElementById(id)!;
  group.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.onclick = () => {
      group.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      set(b.dataset.v!);
    };
  });
}

function status(text: string, isError = false) {
  const el = document.querySelector<HTMLElement>('#status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------- Building a quest ----------

async function startQuest(gpu: boolean) {
  const go = document.querySelector<HTMLButtonElement>('#go')!;
  go.disabled = true;
  try {
    status('Finding where you are…');
    const home = fakeHome?.length === 2 ? { lat: fakeHome[0], lng: fakeHome[1] } : await getHome();

    status('Looking at the map around you…');
    const places = await fetchPlaces(home, searchRadius(settings.minutes));
    const route = planLoop(home, places, settings.minutes);
    if (route.length < 2) {
      status(`Only found ${route.length} walkable spot${route.length === 1 ? '' : 's'} on the map near you. Try a longer walk, or OpenStreetMap may be thin here.`, true);
      go.disabled = false;
      return;
    }

    let useModel = gpu;
    if (useModel) {
      try {
        await loadModel(settings.model, (_text, f) => status(f < 1 ? `Waking up the model… ${Math.round(f * 100)}%` : 'Model ready.'));
      } catch (e) {
        console.error(e);
        useModel = false;
        status("The model couldn't start here, so these clues are the simple built-in ones.");
      }
    }

    const stops: Stop[] = [];
    for (const [i, place] of route.entries()) {
      if (useModel) status(`Writing clue ${i + 1} of ${route.length}…`);
      const clue = useModel ? await writeClue(place, settings.vibe) : { ...templateClue(place), fallback: true };
      stops.push({ place, clue, found: false });
    }

    quest = { home, minutes: loopMinutes(home, route), vibe: settings.vibe, stops, current: 0, startedAt: Date.now() };
    here = home;
    renderStop();
    watch();
  } catch (e) {
    status(errorText(e), true);
    go.disabled = false;
  }
}

async function getHome(): Promise<LatLng> {
  const pos = await currentPosition();
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && (e as GeolocationPositionError).code === 1)
    return 'Side Quest needs your location to plan a walk. It stays on this phone.';
  if (e instanceof Error && /webgpu|gpu/i.test(e.message))
    return "The model couldn't start on this device's GPU. Try the lighter model.";
  console.error(e);
  return e instanceof Error ? e.message : 'Something went wrong.';
}

// ---------- On the walk ----------

function renderStop() {
  if (!quest) return;
  const stop = quest.stops[quest.current];
  const n = quest.stops.length;
  app.innerHTML = `
    <main class="screen walk">
      <div class="progress">${quest.stops.map((s, i) => `<span class="${s.found ? 'done' : i === quest!.current ? 'now' : ''}"></span>`).join('')}</div>
      <p class="kicker">Stop ${quest.current + 1} of ${n}</p>
      <blockquote class="riddle">${esc(stop.clue.riddle)}</blockquote>
      ${stop.clue.fallback ? '<p class="meta">Built-in clue: the model was not available for this one.</p>' : ''}
      <p class="heading" id="heading"></p>
      <p class="pocket">Put the phone away. It buzzes when you're close, if the screen is on. Otherwise check back when you think you're there.</p>
      <div class="actions">
        <button class="primary" id="here">I think I'm here</button>
        <button class="ghost" id="hint">Stuck? Show the answer</button>
        ${sim ? '<button class="ghost" id="teleport">Teleport (demo)</button>' : ''}
      </div>
      <p class="status" id="status" role="status"></p>
      <button class="link" id="quit">End the walk</button>
    </main>`;
  updateHeading();
  document.querySelector<HTMLButtonElement>('#here')!.onclick = checkArrival;
  document.querySelector<HTMLButtonElement>('#hint')!.onclick = () => {
    const p = stop.place;
    const label = p.name ? `${p.name} (${p.kind})` : `A ${p.kind}`;
    status('');
    document.querySelector('#hint')!.outerHTML = `<p class="answer">${esc(label)} · <a href="geo:${p.lat},${p.lng}?q=${p.lat},${p.lng}" target="_blank" rel="noopener">open in maps</a></p>`;
  };
  document.querySelector<HTMLButtonElement>('#teleport')?.addEventListener('click', () => {
    here = { lat: stop.place.lat, lng: stop.place.lng };
    arrive();
  });
  document.querySelector<HTMLButtonElement>('#quit')!.onclick = () => {
    quest = null;
    renderHome();
  };
}

function updateHeading() {
  const el = document.querySelector('#heading');
  if (!el || !quest || !here) return;
  const target = quest.stops[quest.current].place;
  const d = distance(here, target);
  el.textContent = `About ${roundDistance(d)}, roughly ${compass(bearing(here, target))}.`;
}

function arrivalRadius(accuracy = 0) {
  return Math.max(40, Math.min(accuracy, 80));
}

function watch() {
  stopWatching();
  if (fakeHome || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!quest) return;
      const target = quest.stops[quest.current]?.place;
      if (target && distance(here, target) <= arrivalRadius(pos.coords.accuracy)) arrive();
      else updateHeading();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

function stopWatching() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

async function checkArrival() {
  if (!quest) return;
  const target = quest.stops[quest.current].place;
  if (fakeHome) {
    status(`You're ${roundDistance(distance(here!, target))} away. (Demo mode: use Teleport.)`);
    return;
  }
  status('Checking…');
  try {
    const pos = await currentPosition();
    here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const d = distance(here, target);
    if (d <= arrivalRadius(pos.coords.accuracy) + 20) arrive();
    else {
      updateHeading();
      status(`Not quite. Still about ${roundDistance(d)} to go.`);
    }
  } catch (e) {
    status(errorText(e), true);
  }
}

function arrive() {
  if (!quest) return;
  const stop = quest.stops[quest.current];
  if (stop.found) return;
  stop.found = true;
  navigator.vibrate?.([120, 80, 120]);
  const p = stop.place;
  const last = quest.current === quest.stops.length - 1;
  app.innerHTML = `
    <main class="screen found">
      <p class="kicker">Found it</p>
      <h1>${esc(p.name ?? `A ${p.kind}`)}</h1>
      ${p.name ? `<p class="meta">${esc(p.kind)}</p>` : ''}
      <section class="notice">
        <h2>Before you move on</h2>
        <p>${esc(stop.clue.notice)}</p>
      </section>
      <button class="primary" id="next">${last ? 'Head home' : 'Next clue'}</button>
    </main>`;
  document.querySelector<HTMLButtonElement>('#next')!.onclick = () => {
    if (!quest) return;
    if (last) return finish();
    quest.current++;
    renderStop();
  };
}

async function finish() {
  if (!quest) return;
  stopWatching();
  const q = quest;
  const places = q.stops.map((s) => s.place);
  const minutes = Math.max(1, Math.round((Date.now() - q.startedAt) / 60000));
  app.innerHTML = `
    <main class="screen done">
      <p class="kicker">Quest complete</p>
      <h1>${q.stops.length} places, ${minutes} min.</h1>
      <blockquote class="postcard" id="note">Writing your postcard…</blockquote>
      <ol class="route">${places.map((p) => `<li>${esc(p.name ?? `A ${p.kind}`)}</li>`).join('')}</ol>
      <button class="primary" id="again">Another one</button>
    </main>`;
  document.querySelector<HTMLButtonElement>('#again')!.onclick = () => {
    quest = null;
    renderHome();
  };
  const note = await writeFieldNote(places, minutes, q.vibe);
  const el = document.querySelector('#note');
  if (el) el.textContent = note;
  saveLog({
    date: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    minutes,
    places: places.map((p) => p.name ?? p.kind),
    note,
  });
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

renderHome();
