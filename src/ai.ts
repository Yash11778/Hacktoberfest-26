import type { WebWorkerMLCEngine } from '@mlc-ai/web-llm';
import type { Place } from './places';

export interface ModelChoice {
  id: string;
  label: string;
  size: string;
}

/** Open-weight Gemma builds compiled for the browser by the MLC project. */
export const MODELS: ModelChoice[] = [
  { id: 'gemma3-1b-it-q4f16_1-MLC', label: 'Gemma 3 1B (light, for phones)', size: '~0.7 GB' },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B (better clues, for laptops)', size: '~1.4 GB' },
];

export const VIBES = ['playful', 'poetic', 'detective', 'for kids'] as const;
export type Vibe = (typeof VIBES)[number];

const VOICE: Record<Vibe, string> = {
  playful: 'light and playful, a little cheeky',
  poetic: 'quiet and poetic, like a haiku-ish nature note',
  detective: 'like a detective leaving a cryptic note',
  'for kids': 'simple words a 7-year-old understands, excited and kind',
};

/** `navigator.gpu` can exist with no usable adapter (blocklisted GPU, headless), so ask for one. */
export async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

let engine: WebWorkerMLCEngine | null = null;
let loadedId: string | null = null;

// WebLLM is ~6 MB of JS. Load it only when the model is actually needed.
const webllm = () => import('@mlc-ai/web-llm');

/** Remembered after a successful load so the home screen needn't pull in WebLLM to ask. */
export const isDownloaded = (id: string) => {
  try {
    return localStorage.getItem(`sq-ready-${id}`) === '1';
  } catch {
    return false;
  }
};

export async function loadModel(id: string, onProgress: (text: string, fraction: number) => void) {
  if (engine && loadedId === id) return;
  const worker = new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' });
  const { CreateWebWorkerMLCEngine } = await webllm();
  engine = await CreateWebWorkerMLCEngine(worker, id, {
    initProgressCallback: (r) => onProgress(r.text, r.progress),
  });
  loadedId = id;
  try {
    localStorage.setItem(`sq-ready-${id}`, '1');
  } catch {
    /* only affects the hint text */
  }
}

async function ask(prompt: string, maxTokens: number, temperature = 0.8): Promise<string> {
  if (!engine) throw new Error('Model not loaded');
  // Gemma has no system role, so every instruction travels in the user turn.
  const reply = await engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature,
    top_p: 0.9,
  });
  return reply.choices[0]?.message.content?.trim() ?? '';
}

export interface Clue {
  riddle: string;
  notice: string;
  /** True when the model failed and a template stepped in. */
  fallback: boolean;
}

function describe(p: Place): string {
  const parts = [`a ${p.kind}`];
  if (p.name) parts.push(`named "${p.name}"`);
  if (p.facts.length) parts.push(`(${p.facts.join('; ')})`);
  return parts.join(' ');
}

export async function writeClue(place: Place, vibe: Vibe): Promise<Clue> {
  const prompt = `You write clues for a real-world walking scavenger hunt.

The walker must find this place: ${describe(place)}.

Write:
1. A riddle of at most two short sentences that hints at the place without saying its name${place.name ? '' : ' or the word "' + place.kind + '"'}. Use what someone would see, hear or smell there.
2. One small thing to notice once they arrive, using their senses (look up, listen, touch, count something). One sentence.

Tone: ${VOICE[vibe]}. No emoji. No hashtags.

Reply in exactly this format and nothing else:
CLUE: <riddle>
NOTICE: <thing to notice>`;

  try {
    const text = await ask(prompt, 140);
    const riddle = text.match(/CLUE:\s*([\s\S]*?)(?:\n\s*NOTICE:|$)/i)?.[1]?.trim();
    const notice = text.match(/NOTICE:\s*([\s\S]*)$/i)?.[1]?.trim();
    if (riddle && notice && (!place.name || !riddle.toLowerCase().includes(place.name.toLowerCase()))) {
      return { riddle: clean(riddle), notice: clean(notice), fallback: false };
    }
  } catch {
    /* fall through to the template */
  }
  return { ...templateClue(place), fallback: true };
}

export async function writeFieldNote(stops: Place[], minutes: number, vibe: Vibe): Promise<string> {
  if (!engine) return templateNote(stops, minutes);
  const prompt = `Someone just finished a ${minutes}-minute walk near home and visited, in order: ${stops
    .map(describe)
    .join(', then ')}.

Write a three-line postcard to them about the walk. Mention at least two of the places. Tone: ${VOICE[vibe]}. No emoji, no hashtags, no greeting line, no sign-off.`;
  try {
    const text = await ask(prompt, 120, 0.9);
    return clean(text) || templateNote(stops, minutes);
  } catch {
    return templateNote(stops, minutes);
  }
}

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/^["']|["']$/g, '').trim();

/** Used without WebGPU, or when the model's answer can't be parsed. */
export function templateClue(p: Place): Pick<Clue, 'riddle' | 'notice'> {
  const byFamily: Record<Place['family'], [string, string]> = {
    green: ['Somewhere ahead, things grow without asking anyone.', 'Find the oldest-looking leaf you can and feel its edge.'],
    sacred: ['Shoes come off here, and voices go soft.', 'Listen for one sound that repeats.'],
    food: ['Follow your nose; someone nearby is feeding the street.', 'Read one thing on the menu or board you have never tried.'],
    history: ['This spot was here before you were, and will likely stay after.', 'Look for a date, a carving, or a crack that tells its age.'],
    art: ['Someone left their imagination on display for free.', 'Find one colour in it that also appears around you.'],
    water: ['Head toward where the air feels a little cooler.', 'Watch the surface for ten seconds and count what moves.'],
    culture: ['Stories live here, mostly quietly.', 'Spot one word on a sign you would like to look up later.'],
    play: ['Small people rule this place after school.', 'Count how many ways there are to go up or down.'],
  };
  const [riddle, notice] = byFamily[p.family];
  return { riddle, notice };
}

function templateNote(stops: Place[], minutes: number): string {
  const names = stops.map((s) => s.name ?? `a ${s.kind}`);
  return `${minutes} minute${minutes === 1 ? '' : 's'}, ${stops.length} places you'd walked past without stopping.\n${names.join(', ')}.\nSame streets, slightly different now.`;
}
