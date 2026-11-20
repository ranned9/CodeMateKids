/** 面板控制器：唯一状态源，同步 hidden / aria-expanded / aria-controls 与焦点。 */

export const PANEL_IDS = [
  "startupDetails",
  "taskDetails",
  "taskList",
  "learningObjectives",
  "otherThemes",
  "codePreview",
  "resultDetails",
  "result",
  "tutor",
  "tutorMore",
  "tutorInput",
  "tutorEvidence",
  "systemInfo",
];

const NAV_GROUP = "nav";
const FEEDBACK_GROUP = "feedback";

export function groupFor(panelId, mode = "wide") {
  if (panelId === "taskList" || panelId === "learningObjectives" || panelId === "otherThemes" || panelId === "systemInfo") {
    return NAV_GROUP;
  }
  if ((panelId === "result" || panelId === "tutor") && (mode === "editorFirst" || mode === "simple")) {
    return FEEDBACK_GROUP;
  }
  return null;
}

export function defaultPanelPolicy(mode = "wide") {
  if (mode === "editorFirst" || mode === "simple") {
    return ["result"];
  }
  return ["result", "tutor"];
}

export function createPanelController({
  getPanel,
  getTrigger = () => null,
  focusScope = null,
  mode = "wide",
  fallbackAnchorId = "canvas-toolbar",
} = {}) {
  const records = new Map();
  let currentMode = mode;

  function record(panelId) {
    if (!records.has(panelId)) {
      records.set(panelId, { open: false, overridden: false, returnTargetId: fallbackAnchorId, triggerId: null });
    }
    return records.get(panelId);
  }

  function setVisible(panelId, visible) {
    const panel = getPanel(panelId);
    if (!panel) {
      return false;
    }
    panel.hidden = !visible;
    if (typeof panel.setAttribute === "function") {
      panel.setAttribute("data-open", visible ? "true" : "false");
      panel.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    for (const trigger of triggersFor(panelId)) {
      trigger?.setAttribute("aria-expanded", String(visible));
    }
    return true;
  }

  function triggersFor(panelId) {
    const triggers = getTrigger(panelId);
    return Array.isArray(triggers) ? triggers : [triggers];
  }

  function closeGroup(group, exceptId) {
    if (!group) {
      return;
    }
    for (const panelId of PANEL_IDS) {
      if (panelId === exceptId || !records.get(panelId)?.open) {
        continue;
      }
      if (groupFor(panelId, currentMode) === group) {
        close(panelId, { silentFocus: true });
      }
    }
  }

  function open(panelId, options = {}) {
    if (!PANEL_IDS.includes(panelId)) {
      return false;
    }
    const panel = getPanel(panelId);
    if (!panel) {
      return false;
    }
    const item = record(panelId);
    closeGroup(groupFor(panelId, currentMode), panelId);
    item.open = true;
    item.overridden = options.keepDefault !== true;
    item.returnTargetId = options.returnTargetId || fallbackAnchorId;
    if (options.triggerId) {
      item.triggerId = options.triggerId;
    }
    setVisible(panelId, true);
    if (!options.silentFocus && focusScope) {
      focusScope.enter(panel, options.trigger || triggersFor(panelId)[0], options.focusTarget || null);
    }
    return true;
  }

  function close(panelId, options = {}) {
    if (!PANEL_IDS.includes(panelId)) {
      return false;
    }
    const item = records.get(panelId);
    if (!item || !item.open) {
      setVisible(panelId, false);
      return false;
    }
    item.open = false;
    item.overridden = options.keepOverridden === true ? item.overridden : true;
    setVisible(panelId, false);
    if (!options.silentFocus && focusScope) {
      focusScope.exit();
    }
    return true;
  }

  function toggle(panelId, options = {}) {
    return isOpen(panelId) ? close(panelId, options) : open(panelId, options);
  }

  function isOpen(panelId) {
    return Boolean(records.get(panelId)?.open);
  }

  function applyMode(nextMode) {
    currentMode = nextMode;
    for (const panelId of PANEL_IDS) {
      if (!records.has(panelId)) {
        continue;
      }
      const item = record(panelId);
      if (item.overridden) {
        continue;
      }
      const shouldOpen = defaultPanelPolicy(currentMode).includes(panelId);
      if (shouldOpen !== item.open) {
        item.open = shouldOpen;
        setVisible(panelId, shouldOpen);
      }
    }
    for (const panelId of PANEL_IDS) {
      if (!isOpen(panelId)) {
        continue;
      }
      closeGroup(groupFor(panelId, currentMode), panelId);
    }
  }

  function getState() {
    const panels = {};
    for (const [panelId, item] of records) {
      panels[panelId] = { ...item };
    }
    return { mode: currentMode, panes: panels };
  }

  function toggleFromTrigger(panelId, trigger) {
    if (!PANEL_IDS.includes(panelId)) {
      return false;
    }
    const item = record(panelId);
    item.triggerId = trigger?.id || item.triggerId;
    return toggle(panelId, { triggerId: item.triggerId, trigger });
  }

  return { open, close, toggle, isOpen, applyMode, getState, toggleFromTrigger, fallbackAnchorId };
}
