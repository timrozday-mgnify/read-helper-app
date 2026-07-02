import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HelperServer } from "./server";
import type { WebinCliRun } from "./webinCli";

async function withServer<T>(
  fn: (ctx: { base: string; tmpdir: string }) => Promise<T>,
  runner?: (args: WebinCliRun) => Promise<number>
): Promise<T> {
  const tmpdir = path.join(os.tmpdir(), "read-helper-server", randomUUID());
  await mkdir(tmpdir, { recursive: true });
  const server = new HelperServer({ port: 0, appDataDir: tmpdir, runner });
  await server.start();
  try {
    return await fn({ base: server.url(), tmpdir });
  } finally {
    await server.stop();
  }
}

describe("HelperServer", () => {
  it("reports health and credential state", async () => {
    await withServer(async ({ base }) => {
      let res = await fetch(`${base}/api/health`);
      let body = await res.json();
      expect(body.service).toBe("mimicc-read-helper");
      expect(body.display_name).toBe("ENA Read Submission Helper");
      expect(body.credentials_configured).toBe(false);

      res = await fetch(`${base}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Webin-1", password: "pw" })
      });
      expect(res.status).toBe(200);

      res = await fetch(`${base}/api/health`);
      body = await res.json();
      expect(body.credentials_configured).toBe(true);
    });
  });

  it("scans read groups", async () => {
    await withServer(async ({ base, tmpdir }) => {
      const reads = path.join(tmpdir, "reads");
      await mkdir(reads);
      await writeFile(path.join(reads, "x_1.fq.gz"), "");
      await writeFile(path.join(reads, "x_2.fq.gz"), "");

      const res = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_dir: reads })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.groups[0].paired).toBe(true);
    });
  });

  it("submits, writes manifest, streams logs, and exposes status", async () => {
    const runner = async (args: WebinCliRun) => {
      args.onLine("INFO: Validating manifest...");
      args.onLine("Created experiment ERX123456 and run ERR123456");
      return 0;
    };

    await withServer(async ({ base, tmpdir }) => {
      const reads = path.join(tmpdir, "reads");
      await mkdir(reads);

      await fetch(`${base}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Webin-1", password: "pw" })
      });
      const submit = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_host_dir: reads,
          manifest_filename: "../run.manifest",
          manifest_text: "STUDY\tERP000000\n",
          submit: false,
          test: true
        })
      });
      expect(submit.status).toBe(200);
      const { job_id: jobId } = await submit.json() as { job_id: string };
      expect(await readFile(path.join(reads, "run.manifest"), "utf8")).toBe("STUDY\tERP000000\n");

      let body: any = null;
      for (let i = 0; i < 30; i++) {
        const status = await fetch(`${base}/api/status/${jobId}`);
        body = await status.json();
        if (body.done) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(body.status).toBe("done");
      expect(body.result.exit_code).toBe(0);
      expect(body.result.experiment_accession).toBe("ERX123456");
      expect(body.result.run_accession).toBe("ERR123456");
    }, runner);
  });

  it("streams existing and final job output as SSE", async () => {
    const runner = async (args: WebinCliRun) => {
      args.onLine("INFO: Validating manifest...");
      args.onLine("Created experiment ERX123456 and run ERR123456");
      return 0;
    };

    await withServer(async ({ base, tmpdir }) => {
      const reads = path.join(tmpdir, "reads");
      await mkdir(reads);
      await fetch(`${base}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Webin-1", password: "pw" })
      });
      const submit = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_host_dir: reads,
          manifest_filename: "run.manifest",
          manifest_text: "STUDY\tERP000000\n",
          submit: false,
          test: true
        })
      });
      const { job_id: jobId } = await submit.json() as { job_id: string };

      let streamText = "";
      for (let i = 0; i < 30; i++) {
        const stream = await fetch(`${base}/api/stream/${jobId}`);
        streamText = await stream.text();
        if (streamText.includes('"done":true')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(streamText).toContain("INFO: Validating manifest");
      expect(streamText).toContain('"done":true');
      expect(streamText).toContain('"exit_code":0');
      expect(streamText).toContain("ERX123456");
      expect(streamText).toContain("ERR123456");
    }, runner);
  });
});
