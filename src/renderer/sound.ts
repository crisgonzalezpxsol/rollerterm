// Sonidos del pomodoro sintetizados con Web Audio (sin archivos): el tictac de un reloj
// mecánico y un timbre de mostrador.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  ctx ??= new AudioContext();
  // Puede quedar suspendido si se creó sin un gesto del usuario.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

let noise: AudioBuffer | null = null;
function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noise) return noise;
  noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.05), ac.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

/**
 * Un golpe del escape de un reloj: un chasquido de ruido filtrado más un tono corto de
 * "madera". `tic` y `tac` alternan de altura, como un reloj de verdad.
 */
export function tick(kind: "tic" | "tac", volume: number): void {
  if (volume <= 0) return;
  const ac = audio();
  const t = ac.currentTime;

  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac);
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = kind === "tic" ? 3400 : 2600;
  band.Q.value = 6;
  const clickGain = ac.createGain();
  clickGain.gain.setValueAtTime(0, t);
  clickGain.gain.linearRampToValueAtTime(0.9 * volume, t + 0.002);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
  src.connect(band).connect(clickGain).connect(ac.destination);
  src.start(t);
  src.stop(t + 0.05);

  const wood = ac.createOscillator();
  wood.type = "triangle";
  wood.frequency.value = kind === "tic" ? 1250 : 950;
  const woodGain = ac.createGain();
  woodGain.gain.setValueAtTime(0.25 * volume, t);
  woodGain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
  wood.connect(woodGain).connect(ac.destination);
  wood.start(t);
  wood.stop(t + 0.03);
}

/**
 * Timbre de mostrador: parciales inarmónicos típicos de una campana, cada uno con su
 * caída. `times` golpes seguidos ("ding" o "ding-ding").
 */
export function bell(volume: number, times = 1, soft = false): void {
  if (volume <= 0) return;
  const ac = audio();
  const base = soft ? 880 : 1320;
  const partials = [
    { ratio: 1, gain: 1, decay: 2.2 },
    { ratio: 2.32, gain: 0.45, decay: 1.4 },
    { ratio: 4.25, gain: 0.25, decay: 0.8 },
    { ratio: 6.63, gain: 0.12, decay: 0.5 },
  ];
  const level = (soft ? 0.18 : 0.3) * volume;
  for (let i = 0; i < times; i++) {
    const t = ac.currentTime + i * 0.32;
    for (const p of partials) {
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = base * p.ratio;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level * p.gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + p.decay);
      osc.connect(g).connect(ac.destination);
      osc.start(t);
      osc.stop(t + p.decay + 0.05);
    }
  }
}
