export function parseAccessions(lines: string[]): { experiment_accession?: string; run_accession?: string } {
  const text = lines.join("\n");
  const experiment = text.match(/\bERX\d+\b/);
  const run = text.match(/\bERR\d+\b/);
  return {
    ...(experiment ? { experiment_accession: experiment[0] } : {}),
    ...(run ? { run_accession: run[0] } : {})
  };
}
