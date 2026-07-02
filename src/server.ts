import http, { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseAccessions } from "./accessions";
import { scanReads } from "./readScanner";
import { runWebinCli, type WebinCliRun } from "./webinCli";
import type { Credentials, Job, JobResult, SubmitRequest } from "./types";

const VERSION = "1.0.0";

export type HelperServerOptions = {
  port?: number;
  appDataDir: string;
  runner?: (args: WebinCliRun) => Promise<number>;
  onShutdown?: () => void;
};

type SseClient = {
  response: ServerResponse;
};

export class HelperServer {
  private readonly appDataDir: string;
  private readonly logsDir: string;
  private readonly runner: (args: WebinCliRun) => Promise<number>;
  private readonly onShutdown?: () => void;
  private readonly jobs = new Map<string, Job>();
  private readonly sseClients = new Map<string, Set<SseClient>>();
  private credentials: Credentials | null = null;
  private server: http.Server | null = null;
  private port: number;

  constructor(options: HelperServerOptions) {
    this.port = options.port ?? Number(process.env.HELPER_PORT || "9100");
    this.appDataDir = options.appDataDir;
    this.logsDir = path.join(this.appDataDir, "logs");
    this.runner = options.runner ?? runWebinCli;
    this.onShutdown = options.onShutdown;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    await fs.mkdir(this.logsDir, { recursive: true });
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((err) => {
        if (err instanceof HttpError) {
          this.json(response, err.statusCode, { detail: err.message });
          return;
        }
        this.json(response, 500, { detail: err instanceof Error ? err.message : String(err) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const clients of this.sseClients.values()) {
      for (const client of clients) client.response.end();
    }
    this.sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const parsed = new URL(request.url || "/", this.url());
    const pathname = parsed.pathname;

    if (request.method === "GET" && pathname === "/") {
      this.html(response, statusPageHtml(this.port));
      return;
    }
    if (request.method === "GET" && pathname === "/api/health") {
      this.json(response, 200, {
        status: "ok",
        service: "mimicc-read-helper",
        display_name: "ENA Read Submission Helper",
        version: VERSION,
        host_home: os.homedir(),
        credentials_configured: this.credentials !== null
      });
      return;
    }
    if (pathname === "/api/credentials") {
      await this.handleCredentials(request, response);
      return;
    }
    if (request.method === "GET" && pathname === "/api/browse") {
      await this.handleBrowse(parsed, response);
      return;
    }
    if (request.method === "POST" && pathname === "/api/scan") {
      await this.handleScan(request, response);
      return;
    }
    if (request.method === "POST" && pathname === "/api/submit") {
      await this.handleSubmit(request, response);
      return;
    }
    if (request.method === "GET" && pathname.startsWith("/api/status/")) {
      this.handleStatus(pathname.slice("/api/status/".length), parsed, response);
      return;
    }
    if (request.method === "GET" && pathname.startsWith("/api/stream/")) {
      this.handleStream(pathname.slice("/api/stream/".length), request, response);
      return;
    }
    if (request.method === "POST" && pathname === "/api/shutdown") {
      this.json(response, 200, { status: "stopping" });
      setTimeout(() => this.onShutdown?.(), 250);
      return;
    }

    this.json(response, 404, { detail: "Not found" });
  }

  private async handleCredentials(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "POST") {
      const body = await readJson(request);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        this.json(response, 422, { detail: "Username and password are required" });
        return;
      }
      this.credentials = { username, password };
      this.json(response, 200, { status: "ok", username });
      return;
    }
    if (request.method === "DELETE") {
      this.credentials = null;
      this.json(response, 200, { status: "cleared" });
      return;
    }
    this.methodNotAllowed(response, ["POST", "DELETE"]);
  }

  private async handleBrowse(parsed: URL, response: ServerResponse): Promise<void> {
    const reqPath = parsed.searchParams.get("path") || "/";
    const absPath = path.resolve(reqPath);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isDirectory()) {
      this.json(response, 404, { detail: `Not a directory: ${reqPath}` });
      return;
    }
    let entries: { name: string; path: string }[] = [];
    try {
      const items = await fs.readdir(absPath, { withFileTypes: true });
      entries = items
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: path.join(absPath, e.name) }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    } catch { /* permission denied — return empty list */ }
    this.json(response, 200, { path: absPath, entries });
  }

  private async handleScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const hostDir = typeof body.host_dir === "string" ? body.host_dir.trim() : "";
    if (!path.isAbsolute(hostDir)) {
      this.json(response, 400, { detail: `Path must be absolute: ${hostDir}` });
      return;
    }
    const stat = await fs.stat(hostDir).catch(() => null);
    if (!stat?.isDirectory()) {
      this.json(response, 404, { detail: `Not a directory: ${hostDir}` });
      return;
    }
    const groups = await scanReads(hostDir);
    this.json(response, 200, { host_dir: stripTrailingSlash(hostDir), groups, count: groups.length });
  }

  private async handleSubmit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.credentials) {
      this.json(response, 401, { detail: "Webin credentials not set in the helper" });
      return;
    }

    const body = await readJson(request);
    const parsed = parseSubmitRequest(body);
    if ("detail" in parsed) {
      this.json(response, 422, parsed);
      return;
    }

    if (!path.isAbsolute(parsed.input_host_dir)) {
      this.json(response, 400, { detail: `Path must be absolute: ${parsed.input_host_dir}` });
      return;
    }
    const stat = await fs.stat(parsed.input_host_dir).catch(() => null);
    if (!stat?.isDirectory()) {
      this.json(response, 404, { detail: `Not a directory: ${parsed.input_host_dir}` });
      return;
    }

    const manifestName = basenameAnyPlatform(parsed.manifest_filename);
    const manifestPath = path.join(parsed.input_host_dir, manifestName);
    await fs.writeFile(manifestPath, parsed.manifest_text);

    const job: Job = {
      id: randomUUID(),
      config: parsed,
      manifestName,
      status: "pending",
      lines: [],
      result: null,
      createdAt: new Date().toISOString()
    };
    this.jobs.set(job.id, job);
    this.runJob(job, this.credentials).catch((err) => {
      this.appendLine(job, `ERROR: ${err instanceof Error ? err.message : String(err)}`);
      this.finishJob(job, 1);
    });
    this.json(response, 200, { job_id: job.id });
  }

  private handleStatus(jobId: string, parsed: URL, response: ServerResponse): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.json(response, 404, { detail: "Job not found" });
      return;
    }
    const sinceRaw = parsed.searchParams.get("since") || "0";
    const since = Number.parseInt(sinceRaw, 10);
    if (!Number.isInteger(since) || since < 0) {
      this.json(response, 422, { detail: "since must be an integer" });
      return;
    }
    this.json(response, 200, statusBody(job, since));
  }

  private handleStream(jobId: string, request: IncomingMessage, response: ServerResponse): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.json(response, 404, { detail: "Job not found" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");
    const client = { response };
    const clients = this.sseClients.get(jobId) ?? new Set<SseClient>();
    clients.add(client);
    this.sseClients.set(jobId, clients);

    for (const line of job.lines) this.writeSse(response, { line, done: false });
    if (job.result) this.writeFinalSse(response, job);

    request.on("close", () => {
      clients.delete(client);
      if (!clients.size) this.sseClients.delete(jobId);
    });
  }

  private async runJob(job: Job, credentials: Credentials): Promise<void> {
    job.status = "running";
    const inputDir = stripTrailingSlash(job.config.input_host_dir);
    const outputDir = path.join(inputDir, ".webin-output");
    const manifestPath = path.join(inputDir, job.manifestName);
    const logPath = path.join(this.logsDir, `${job.id}.log`);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      logPath,
      [
        `# started: ${new Date().toISOString()}`,
        `# manifest: ${manifestPath}`,
        `# output:   ${outputDir}`,
        `# submit:   ${job.config.submit}`,
        ""
      ].join("\n")
    );

    const exitCode = await this.runner({
      context: "reads",
      manifestPath,
      inputDir,
      outputDir,
      credentials,
      submit: job.config.submit,
      test: job.config.test,
      appDataDir: this.appDataDir,
      onLine: asyncLineHandler(async (line) => {
        this.appendLine(job, line);
        await fs.appendFile(logPath, `${line}\n`);
      })
    });
    await fs.appendFile(logPath, `\n# exit code: ${exitCode}\n`);
    this.finishJob(job, exitCode, logPath);
  }

  private appendLine(job: Job, line: string): void {
    job.lines.push(line);
    const clients = this.sseClients.get(job.id);
    if (!clients) return;
    for (const client of clients) this.writeSse(client.response, { line, done: false });
  }

  private finishJob(job: Job, exitCode: number, logPath = path.join(this.logsDir, `${job.id}.log`)): void {
    const result: JobResult = {
      exit_code: exitCode,
      log: job.lines.join("\n"),
      log_file: logPath,
      ...parseAccessions(job.lines)
    };
    job.result = result;
    job.status = exitCode === 0 ? "done" : "failed";
    const clients = this.sseClients.get(job.id);
    if (!clients) return;
    for (const client of clients) this.writeFinalSse(client.response, job);
    this.sseClients.delete(job.id);
  }

  private writeFinalSse(response: ServerResponse, job: Job): void {
    this.writeSse(response, {
      done: true,
      exit_code: job.result?.exit_code ?? 1,
      log: job.result?.log ?? "",
      experiment_accession: job.result?.experiment_accession || "",
      run_accession: job.result?.run_accession || ""
    });
    response.end();
  }

  private writeSse(response: ServerResponse, payload: unknown): void {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    const allowed = allowedOrigins();
    if (origin && (isLocalhostOrigin(origin) || allowed.includes(origin))) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    } else {
      response.setHeader("Access-Control-Allow-Origin", "*");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private json(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private html(response: ServerResponse, body: string): void {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  }

  private methodNotAllowed(response: ServerResponse, methods: string[]): void {
    response.writeHead(405, { Allow: methods.join(", ") });
    response.end();
  }
}

function parseSubmitRequest(body: Record<string, unknown>): Required<SubmitRequest> | { detail: string } {
  const inputHostDir = typeof body.input_host_dir === "string" ? body.input_host_dir.trim() : "";
  const manifestFilename = typeof body.manifest_filename === "string" ? body.manifest_filename.trim() : "";
  const manifestText = typeof body.manifest_text === "string" ? body.manifest_text : null;
  if (!inputHostDir || !manifestFilename || manifestText === null) {
    return { detail: "input_host_dir, manifest_filename, and manifest_text are required" };
  }
  return {
    input_host_dir: inputHostDir,
    manifest_filename: manifestFilename,
    manifest_text: manifestText,
    submit: typeof body.submit === "boolean" ? body.submit : true,
    test: typeof body.test === "boolean" ? body.test : true
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(422, detail);
  }
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function statusBody(job: Job, since: number): Record<string, unknown> {
  return {
    status: job.status,
    lines: job.lines.slice(since),
    next: job.lines.length,
    done: job.status === "done" || job.status === "failed",
    result: job.result
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function basenameAnyPlatform(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).pop() || value;
}

function allowedOrigins(): string[] {
  const raw = [process.env.ALLOWED_ORIGINS, process.env.MIMICC_APP_ORIGIN].filter(Boolean).join(",");
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function asyncLineHandler(handler: (line: string) => Promise<void>): (line: string) => void {
  return (line) => {
    handler(line).catch(() => undefined);
  };
}

function statusPageHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ENA Read Submission Helper</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; color: #162016; background: #f7f8f2; }
    .ok { color: #1f6f43; } .dot { display:inline-block; width:.65rem; height:.65rem; border-radius:50%; background:#1f6f43; margin-right:.45rem; }
    code { background:#e8eadf; padding:.1rem .35rem; border-radius:4px; }
    .muted { color:#5d675d; }
  </style>
</head>
<body>
  <h1>ENA Read Submission Helper</h1>
  <p><span class="dot"></span><strong class="ok">Running.</strong></p>
  <p>This native helper runs <code>webin-cli</code> locally with Java so reads upload directly to ENA.</p>
  <p class="muted">Listening at <code>http://localhost:${port}</code>. Keep this app open while using the Reads tab.</p>
  <p id="info" class="muted"></p>
  <script>
    fetch('/api/health').then(r => r.json()).then(d => {
      document.getElementById('info').textContent =
        'helper v' + d.version + ' · credentials ' + (d.credentials_configured ? 'set' : 'not set');
    }).catch(() => {});
  </script>
</body>
</html>`;
}
