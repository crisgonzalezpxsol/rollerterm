// Menú contextual propio (clic derecho): una lista de acciones al lado del puntero. Se cierra
// con Esc, con un clic afuera o al elegir algo.

export type MenuItem =
  | { label: string; action: () => void; disabled?: boolean; checked?: boolean; danger?: boolean }
  | { header: string }
  | "-";

let current: HTMLDivElement | null = null;

export function closeContextMenu(): void {
  current?.remove();
  current = null;
}

export function showContextMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item === "-") {
      menu.append(document.createElement("hr"));
    } else if ("header" in item) {
      const h = document.createElement("div");
      h.className = "ctx-header";
      h.textContent = item.header;
      menu.append(h);
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = item.label;
      b.disabled = Boolean(item.disabled);
      b.classList.toggle("checked", Boolean(item.checked));
      b.classList.toggle("danger", Boolean(item.danger));
      b.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
      menu.append(b);
    }
  }
  document.body.append(menu);
  current = menu;
  // Que no se salga de la ventana.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - height - 4))}px`;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();

  menu.addEventListener("keydown", (ev) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (ev.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (ev.key === "Escape") closeContextMenu();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
}

document.addEventListener(
  "mousedown",
  (e) => {
    if (current && !current.contains(e.target as Node)) closeContextMenu();
  },
  true,
);
window.addEventListener("blur", closeContextMenu);
window.addEventListener("resize", closeContextMenu);
