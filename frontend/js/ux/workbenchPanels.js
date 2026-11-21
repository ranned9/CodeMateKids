import { createFocusScope } from "./focusScope.js";
import { createLayoutMode } from "./layoutMode.js";
import { createPanelController } from "./panels.js";

const FEEDBACK_PANELS = ["result", "tutor"];
const ESCAPE_ORDER = [
  "systemInfo", "taskList", "learningObjectives", "otherThemes", "codePreview",
  "tutorMore", "tutorInput", "tutorEvidence", "startupDetails",
];

/** 连接面板状态、响应式布局和键盘焦点。 */
export function bindWorkbenchPanels(elements, onLayoutChange, doc = document) {
  const panelElements = new Map();
  const triggers = new Map();
  for (const panel of doc.querySelectorAll("[data-panel]")) {
    panelElements.set(panel.dataset.panel, panel);
  }
  const panels = createPanelController({
    getPanel: (id) => panelElements.get(id),
    getTrigger: (id) => triggers.get(id),
    focusScope: createFocusScope({ doc }),
  });
  for (const trigger of doc.querySelectorAll("[data-panel-trigger]")) {
    const id = trigger.dataset.panelTrigger;
    if (!triggers.has(id)) triggers.set(id, []);
    triggers.get(id).push(trigger);
    trigger.addEventListener("click", () => panels.toggleFromTrigger(id, trigger));
  }

  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || elements["summary-panel"].open || elements["confirm-dialog"].open) {
      return;
    }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
    const activePanel = event.target?.closest?.("[data-panel]")?.dataset.panel
      || event.target?.closest?.("[data-panel-trigger]")?.dataset.panelTrigger;
    const target = activePanel && !FEEDBACK_PANELS.includes(activePanel) && panels.isOpen(activePanel)
      ? activePanel
      : ESCAPE_ORDER.find((id) => panels.isOpen(id));
    if (target) {
      event.preventDefault();
      panels.close(target);
    }
  });

  function showResultSlot(slot) {
    panels.open(slot, { keepDefault: true, silentFocus: true });
    elements["result-tab-result"].setAttribute("aria-pressed", String(slot === "result"));
    elements["result-tab-tutor"].setAttribute("aria-pressed", String(slot === "tutor"));
    onLayoutChange(false);
  }

  elements["result-tab-result"].addEventListener("click", () => showResultSlot("result"));
  elements["result-tab-tutor"].addEventListener("click", () => showResultSlot("tutor"));
  for (const id of FEEDBACK_PANELS) panels.open(id, { keepDefault: true, silentFocus: true });

  const layout = createLayoutMode();
  let currentMode = null;
  function applyLayout({ mode }) {
    const changed = currentMode !== null && currentMode !== mode;
    currentMode = mode;
    doc.body.setAttribute("data-layout-mode", mode);
    panels.applyMode(mode);
    elements["result-tabs"].hidden = mode !== "editorFirst" && mode !== "simple";
    const tutorOpen = panels.isOpen("tutor") && !panels.isOpen("result");
    elements["result-tab-result"].setAttribute("aria-pressed", String(!tutorOpen));
    elements["result-tab-tutor"].setAttribute("aria-pressed", String(tutorOpen));
    onLayoutChange(changed);
  }

  applyLayout(layout.current());
  layout.onChange(applyLayout);

  return {
    showResultSlot,
    open(id) {
      panels.open(id);
    },
    close(id) {
      panels.close(id, { silentFocus: true });
    },
    enterClassroom() {
      const banner = elements["startup-banner"];
      if (banner.classList) {
        banner.classList.add("entered");
      } else {
        banner.className = `${banner.className || ""} entered`;
      }
      panels.close("startupDetails", { keepOverridden: true, silentFocus: true });
    },
  };
}
