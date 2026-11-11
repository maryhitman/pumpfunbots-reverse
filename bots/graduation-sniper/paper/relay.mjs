// Local paper relay. EventEmitter for one process, JSONL so a second process can tail it.
// No sockets to the network and no transaction path.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export function createRelay({ jsonlPath } = {}) {
  const emitter = new EventEmitter();
  let seq = 0;
  const records = [];
  if (jsonlPath) fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });

  function write(record) {
    records.push(record);
    if (jsonlPath) fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  return {
    publish(signal) {
      const record = write({
        type: "handoff",
        id: `h${++seq}`,
        ...signal,
      });
      emitter.emit("handoff", record);
      return record;
    },
    ack(id, extra = {}) {
      const record = write({ type: "ack", id, ...extra });
      emitter.emit("ack", record);
      return record;
    },
    logResult(result) {
      const record = write({ type: "result", ...result });
      emitter.emit("result", record);
      return record;
    },
    onHandoff(listener) {
      emitter.on("handoff", listener);
    },
    records() {
      return records;
    },
  };
}

export function readRelay(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function tailRelay(jsonlPath, onRecord) {
  let offset = 0;
  if (fs.existsSync(jsonlPath)) offset = fs.statSync(jsonlPath).size;
  const timer = setInterval(() => {
    if (!fs.existsSync(jsonlPath)) return;
    const stat = fs.statSync(jsonlPath);
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    const fd = fs.openSync(jsonlPath, "r");
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    offset = stat.size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line) continue;
      onRecord(JSON.parse(line));
    }
  }, 200);
  return () => clearInterval(timer);
}
