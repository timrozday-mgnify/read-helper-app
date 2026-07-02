import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReadGroup } from "./types";

const READ_SUFFIXES = [".fastq.gz", ".fq.gz", ".fastq", ".fq", ".bam", ".cram"];
const MATE_RE = /^(.+?)[._](?:R)?([12])$/;

function readSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  return READ_SUFFIXES.find((suffix) => lower.endsWith(suffix)) ?? null;
}

function stemAndMate(name: string, suffix: string): { stem: string; mate: string | null } {
  const base = name.slice(0, -suffix.length);
  const match = base.match(MATE_RE);
  if (!match) return { stem: base, mate: null };
  return { stem: match[1], mate: match[2] };
}

export async function scanReads(readsDir: string): Promise<ReadGroup[]> {
  const entries = await fs.readdir(readsDir, { withFileTypes: true });
  const groups = new Map<string, Omit<ReadGroup, "paired">>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const suffix = readSuffix(entry.name);
    if (!suffix) continue;

    const { stem, mate } = stemAndMate(entry.name, suffix);
    const group = groups.get(stem) ?? { group: stem, files: [], files_by_mate: {} };
    group.files.push(path.basename(entry.name));
    if (mate) group.files_by_mate[mate] = path.basename(entry.name);
    groups.set(stem, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: [...group.files].sort(),
      paired: Boolean(group.files_by_mate["1"] && group.files_by_mate["2"])
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
}
