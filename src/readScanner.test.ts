import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanReads } from "./readScanner";

describe("scanReads", () => {
  it("groups paired and single read files", async () => {
    const tmpdir = await mkdtemp(path.join(os.tmpdir(), "read-helper-scan-"));
    const dir = path.join(tmpdir, "reads");
    await mkdir(dir);
    await writeFile(path.join(dir, "sampleA_R1.fastq.gz"), "");
    await writeFile(path.join(dir, "sampleA_R2.fastq.gz"), "");
    await writeFile(path.join(dir, "sampleB.fastq"), "");
    await writeFile(path.join(dir, "notes.txt"), "");

    const groups = await scanReads(dir);

    expect(groups).toEqual([
      {
        group: "sampleA",
        paired: true,
        files: ["sampleA_R1.fastq.gz", "sampleA_R2.fastq.gz"],
        files_by_mate: { "1": "sampleA_R1.fastq.gz", "2": "sampleA_R2.fastq.gz" }
      },
      {
        group: "sampleB",
        paired: false,
        files: ["sampleB.fastq"],
        files_by_mate: {}
      }
    ]);
  });
});
