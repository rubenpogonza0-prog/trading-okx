import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = new URL("../../data/", import.meta.url).pathname;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "cycles.log");

const EMPTY_STATE = { positions: {}, stopLosses: {} };

export async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(EMPTY_STATE);
    throw err;
  }
}

export async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function appendCycleLog(entry) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  await fs.appendFile(LOG_FILE, line);
}
