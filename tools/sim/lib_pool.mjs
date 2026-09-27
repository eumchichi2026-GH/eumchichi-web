/*
 * 작업 나눠 돌리기 (node:worker_threads) — run.mjs · sweep.mjs 공통.
 * 워커마다 카탈로그·엔진을 따로 읽는다(워커당 메모리 약 200MB). 결과는 워커 수와 무관하게 같다(난수는 전부 키 해시, 결과는 호출자가 정렬).
 *
 *   runPool(jobs, { workers, dataRepo, needBaseline, inline, onResult, onFail })
 *     workers ≤ 1 이면 inline(= prepare() 결과)으로 같은 스레드에서 돈다.
 */
import { Worker } from "node:worker_threads";
import { runJob } from "./lib_worker.mjs";

export async function runPool(jobs, { workers = 1, dataRepo = null, needBaseline = true, inline = null, onResult, onFail = () => {} }) {
  if (workers <= 1) {
    for (const job of jobs) {
      try { onResult(job, runJob(inline, job)); } catch (e) { onFail(job, String(e && e.stack || e)); }
    }
    return;
  }
  const queue = [...jobs];
  await new Promise((resolve) => {
    let alive = 0;
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const worker = new Worker(new URL("./lib_worker.mjs", import.meta.url), { workerData: { kind: "azt-sim", dataRepo, needBaseline } });
      alive++;
      const next = () => { const job = queue.shift(); worker.postMessage(job || "exit"); };
      worker.on("message", (m) => { if (m.ok) onResult(m.job, m.result); else onFail(m.job, m.error); next(); });
      worker.on("error", (e) => onFail({ id: "worker" }, String(e && e.stack || e)));
      worker.on("exit", () => { if (--alive === 0) resolve(); });
      next();
    }
    if (!alive) resolve();
  });
}
