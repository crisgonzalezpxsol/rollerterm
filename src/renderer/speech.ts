// Voz del asistente: lee las respuestas con las voces de macOS (speechSynthesis, sin red).
// Lee de a una oración: Chromium corta las lecturas largas a mitad de camino, y así además
// se puede parar en seco y suena con pausas más naturales.

/** Las voces llegan tarde en Chromium: se piden una vez y se cachean al cargarse. */
let voice: SpeechSynthesisVoice | null = null;
let preferred: string | null = null;
let rate = 1.05;
const NOVELTY = /eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|bahh|fred|junior|kathy|ralph/i;
const QUALITY = /premium|enhanced|mejorad|siri/i;

/** Calidad de una voz, para ordenar y para mostrarla en Configuración. */
export function voiceQuality(v: SpeechSynthesisVoice): "premium" | "normal" | "personaje" {
  return QUALITY.test(v.name) ? "premium" : NOVELTY.test(v.name) ? "personaje" : "normal";
}

/** Las voces en español: primero las mejoradas, después rioplatense, latinoamericano y el resto. */
export function spanishVoices(): SpeechSynthesisVoice[] {
  const rank = (v: SpeechSynthesisVoice) => {
    const lang = v.lang.toLowerCase();
    const region = lang.includes("ar") ? 0 : lang.includes("mx") || lang.includes("419") || lang.includes("us") ? 1 : 2;
    const quality = { premium: 0, normal: 1, personaje: 2 }[voiceQuality(v)];
    return quality * 3 + region;
  };
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("es"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function pickVoice(): SpeechSynthesisVoice | null {
  const all = spanishVoices();
  return all.find((v) => v.name === preferred) ?? all[0] ?? null;
}
speechSynthesis.addEventListener("voiceschanged", () => (voice = pickVoice()));
voice = pickVoice();

/** La voz y la velocidad elegidas en Configuración. */
export function setVoicePrefs(name: string | null, r: number): void {
  preferred = name;
  rate = Math.min(2, Math.max(0.5, r || 1));
  voice = pickVoice();
}

/** Markdown a texto para leer: sin bloques de código, links ni símbolos de formato. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (bloque de código) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "un link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~|]+/g, "")
    // Números de ticket y horas como se dicen: «el 381», «a las 15:30».
    .replace(/#(\d+)/g, "el $1")
    .replace(/\s+→\s+/g, ", ")
    .replace(/\n{2,}/g, ".\n")
    .trim();
}

/** Oraciones (y renglones) para leer de a una; las muy largas se parten en comas. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?…])\s+|\n+/)) {
    let rest = part.trim();
    while (rest.length > 220) {
      const cut = Math.max(rest.lastIndexOf(", ", 220), rest.lastIndexOf("; ", 220), rest.lastIndexOf(" ", 220));
      out.push(rest.slice(0, cut > 40 ? cut + 1 : 220));
      rest = rest.slice(cut > 40 ? cut + 1 : 220).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** Cada lectura tiene su número: al empezar otra o pararla, la anterior deja de encadenar. */
let reading = 0;

export function speak(markdown: string, onEnd?: () => void): void {
  stopSpeaking();
  const parts = sentences(speakable(markdown));
  if (!parts.length) return onEnd?.();
  const mine = ++reading;
  const next = (i: number) => {
    if (mine !== reading) return;
    if (i >= parts.length) {
      reading++;
      return onEnd?.();
    }
    const u = new SpeechSynthesisUtterance(parts[i]);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "es-AR";
    u.rate = rate;
    u.addEventListener("end", () => next(i + 1));
    u.addEventListener("error", () => {
      if (mine === reading) {
        reading++;
        onEnd?.();
      }
    });
    speechSynthesis.speak(u);
  };
  next(0);
}

export function stopSpeaking(): void {
  reading++;
  speechSynthesis.cancel();
}

/** Lectura de prueba (Configuración). */
export function preview(): void {
  speak("Hola, soy tu asistente. Tenés dos reuniones hoy y el ticket #381 está esperando respuesta.");
}

export const isSpeaking = () => speechSynthesis.speaking;
