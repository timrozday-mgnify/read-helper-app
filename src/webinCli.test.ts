import { describe, expect, it } from "vitest";
import { buildWebinCliCommand } from "./webinCli";

describe("buildWebinCliCommand", () => {
  it("builds native java webin-cli args without embedding the password", () => {
    const cmd = buildWebinCliCommand({
      jarPath: "/apps/webin-cli.jar",
      context: "reads",
      manifestPath: "/reads/run.manifest",
      inputDir: "/reads",
      outputDir: "/reads/.webin-output",
      username: "Webin-123",
      submit: false,
      test: true,
      javaBin: "java"
    });

    expect(cmd).toEqual([
      "java",
      "-jar",
      "/apps/webin-cli.jar",
      "-context=reads",
      "-manifest=/reads/run.manifest",
      "-userName=Webin-123",
      "-passwordEnv=ENA_WEBIN_PASSWORD",
      "-inputDir=/reads",
      "-outputDir=/reads/.webin-output",
      "-validate",
      "-test"
    ]);
    expect(cmd.join(" ")).not.toContain("secret");
  });
});
