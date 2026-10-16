// Markdown mínimo para las respuestas del asistente, armado con nodos del DOM (nunca con
// innerHTML: el texto viene de un modelo y puede traer cualquier cosa). Párrafos, listas,
// títulos, bloques de código, **negrita**, `código` y links.

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement("pre");
      pre.textContent = code.join("\n");
      frag.append(pre);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const h = document.createElement("p");
      h.className = "md-h";
      appendInline(h, heading[2]);
      frag.append(h);
      i++;
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && (ordered ? numbered : bullet).test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(ordered ? numbered : bullet, ""));
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }
    // Párrafo: líneas seguidas hasta una vacía o un bloque de otro tipo.
    const p = document.createElement("p");
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i++]);
    }
    para.forEach((l, k) => {
      if (k) p.append(document.createElement("br"));
      appendInline(p, l);
    });
    frag.append(p);
  }
  return frag;
}

/** **negrita**, `código`, [texto](url) y URLs sueltas. */
function appendInline(parent: HTMLElement, text: string): void {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parent.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const b = document.createElement("strong");
      b.textContent = m[1];
      parent.append(b);
    } else if (m[2] !== undefined) {
      const c = document.createElement("code");
      c.textContent = m[2];
      parent.append(c);
    } else {
      const url = m[4] ?? m[5]!;
      const a = document.createElement("a");
      a.textContent = m[3] ?? url;
      a.href = url;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        window.open(url);
      });
      parent.append(a);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
