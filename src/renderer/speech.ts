// Voz del asistente: lee las respuestas con las voces de macOS (speechSynthesis, sin red).

/** Las voces llegan tarde en Chromium: se piden una vez y se cachean al cargarse. */
let voice: SpeechSynthesisVoice | null = null;
const NOVELTY = /eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
  if (!voices.length) return null;
  // Primero las voces "mejoradas"/"premium" que se bajan en Configuración, después las comunes y
  // al final las "de personaje" (Grandpa, Rocko…); dentro de cada grupo, rioplatense, después
  // latinoamericano y por último cualquier español.
  const rank = (v: SpeechSynthesisVoice) => {
    const lang = v.lang.toLowerCase();
    const region = lang.includes("ar") ? 0 : lang.includes("mx") || lang.includes("419") || lang.includes("us") ? 1 : 2;
    const quality = /premium|enhanced|mejorad/i.test(v.name) ? 0 : NOVELTY.test(v.name) ? 2 : 1;
    return quality * 3 + region;
  };
  return voices.sort((a, b) => rank(a) - rank(b))[0];
}
speechSynthesis.addEventListener("voiceschanged", () => (voice = pickVoice()));
voice = pickVoice();

/** Markdown a texto para leer: sin bloques de código, links ni símbolos de formato. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (bloque de código) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "un link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\n{2,}/g, ".\n")
    .trim();
}

let current: SpeechSynthesisUtterance | null = null;

export function speak(markdown: string, onEnd?: () => void): void {
  stopSpeaking();
  const text = speakable(markdown);
  if (!text) return onEnd?.();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? "es-AR";
  u.rate = 1.05;
  const end = () => {
    if (current === u) current = null;
    onEnd?.();
  };
  u.addEventListener("end", end);
  u.addEventListener("error", end);
  current = u;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  current = null;
  speechSynthesis.cancel();
}

export const isSpeaking = () => current !== null;
