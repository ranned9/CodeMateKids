/** 本机学生档案与当前标签页的选择。 */
import { API } from "../api.js";

const ACTIVE_STUDENT_KEY = "cmk.activeStudent";
const TEMPORARY_KEY = "cmk.temporaryPractice";

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 当前标签页仍可练习。
  }
}

function lastStudent() {
  try {
    return readSession(ACTIVE_STUDENT_KEY) ?? window.localStorage.getItem(ACTIVE_STUDENT_KEY);
  } catch {
    return null;
  }
}

function rememberStudent(student) {
  writeSession(ACTIVE_STUDENT_KEY, student);
  try {
    window.localStorage.setItem(ACTIVE_STUDENT_KEY, student);
  } catch {
    // 标签页仍记住当前档案。
  }
}

export async function bindStudents({ elements, onInitial, onSwitch, toast, api = API }) {
  const { container, select, dialog, form, input, create, save, cancel } = elements;
  const temporary = readSession(TEMPORARY_KEY) || `guest-${crypto.randomUUID().replaceAll("-", "")}`;
  writeSession(TEMPORARY_KEY, temporary);
  let current = "";
  let changing = false;

  function addStudent({ studentId, displayName }) {
    const option = document.createElement("option");
    option.value = studentId;
    option.textContent = displayName;
    select.appendChild(option);
  }

  async function choose(value) {
    if (changing || value === current) return;
    changing = true;
    select.disabled = true;
    try {
      if (await onSwitch(value || temporary)) {
        current = value;
        rememberStudent(current);
      }
    } finally {
      select.value = current;
      select.disabled = false;
      changing = false;
    }
  }

  select.addEventListener("change", () => choose(select.value));
  create.addEventListener("click", () => {
    input.value = "";
    dialog.showModal();
    input.focus();
  });
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || save.disabled) {
      input.focus();
      return;
    }
    save.disabled = true;
    try {
      const student = await api.createStudent(name);
      addStudent(student);
      dialog.close();
      await choose(student.studentId);
    } catch (error) {
      toast(error.messageForChild || "暂时无法创建档案，可以继续临时练习。", true);
    } finally {
      save.disabled = false;
    }
  });

  try {
    const { students } = await api.students();
    for (const student of students) addStudent(student);
    const saved = lastStudent();
    current = students.some((student) => student.studentId === saved) ? saved : "";
  } catch (error) {
    toast(error.messageForChild || "暂时无法读取学生档案。", true);
  }
  select.value = current;
  onInitial(current || temporary);
  container.hidden = false;
}
