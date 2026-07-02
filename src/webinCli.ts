import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Credentials } from "./types";

export type WebinCliRun = {
  context: string;
  manifestPath: string;
  inputDir: string;
  outputDir: string;
  credentials: Credentials;
  submit: boolean;
  test: boolean;
  appDataDir: string;
  onLine: (line: string) => void;
};

export function buildWebinCliCommand(args: {
  jarPath: string;
  context: string;
  manifestPath: string;
  inputDir: string;
  outputDir: string;
  username: string;
  submit: boolean;
  test: boolean;
  javaBin?: string;
}): string[] {
  const cmd = [
    args.javaBin || process.env.JAVA_BIN || "java",
    "-jar",
    args.jarPath,
    `-context=${args.context}`,
    `-manifest=${args.manifestPath}`,
    `-userName=${args.username}`,
    "-passwordEnv=ENA_WEBIN_PASSWORD",
    `-inputDir=${args.inputDir}`,
    `-outputDir=${args.outputDir}`,
    args.submit ? "-submit" : "-validate"
  ];
  if (args.test) cmd.push("-test");
  return cmd;
}

export async function ensureWebinCliJar(appDataDir: string): Promise<string> {
  const explicit = process.env.WEBIN_CLI_JAR?.trim();
  if (explicit) {
    await assertFile(explicit, "WEBIN_CLI_JAR");
    return explicit;
  }

  const cached = path.join(appDataDir, "webin-cli.jar");
  if (await fileExists(cached)) return cached;

  await fs.mkdir(appDataDir, { recursive: true });
  const version = process.env.WEBIN_CLI_VERSION?.trim() || await latestWebinCliVersion();
  const url = `https://github.com/enasequence/webin-cli/releases/download/${version}/webin-cli-${version}.jar`;
  await downloadFile(url, cached);
  return cached;
}

export async function runWebinCli(args: WebinCliRun): Promise<number> {
  const jarPath = await ensureWebinCliJar(args.appDataDir);
  await fs.mkdir(args.outputDir, { recursive: true });

  const cmd = buildWebinCliCommand({
    jarPath,
    context: args.context,
    manifestPath: args.manifestPath,
    inputDir: args.inputDir,
    outputDir: args.outputDir,
    username: args.credentials.username,
    submit: args.submit,
    test: args.test
  });

  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env, ENA_WEBIN_PASSWORD: args.credentials.password },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.on("error", reject);
    streamLines(child.stdout, args.onLine);
    streamLines(child.stderr, args.onLine);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function latestWebinCliVersion(): Promise<string> {
  const body = await getJson("https://api.github.com/repos/enasequence/webin-cli/releases/latest");
  const tag = body?.tag_name;
  if (typeof tag !== "string" || !tag.trim()) {
    throw new Error("Could not determine latest webin-cli release tag");
  }
  return tag.trim();
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ena-read-submission-helper" } }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`GET ${url} failed with HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const tmp = `${destination}.download`;
  await new Promise<void>((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ena-read-submission-helper" } }, async (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          await downloadFile(res.headers.location, destination);
          resolve();
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Download failed with HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }
      try {
        await pipeline(res, createWriteStream(tmp));
        await fs.rename(tmp, destination);
        resolve();
      } catch (err) {
        reject(err);
      }
    }).on("error", reject);
  });
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} does not point to a file: ${filePath}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

function streamLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer.replace(/\r$/, ""));
  });
}
