export type Credentials = {
  username: string;
  password: string;
};

export type ReadGroup = {
  group: string;
  paired: boolean;
  files: string[];
  files_by_mate: Record<string, string>;
};

export type SubmitRequest = {
  input_host_dir: string;
  manifest_filename: string;
  manifest_text: string;
  submit?: boolean;
  test?: boolean;
};

export type JobStatus = "pending" | "running" | "done" | "failed";

export type JobResult = {
  exit_code: number;
  log: string;
  log_file: string;
  experiment_accession?: string;
  run_accession?: string;
};

export type Job = {
  id: string;
  config: Required<SubmitRequest>;
  manifestName: string;
  status: JobStatus;
  lines: string[];
  result: JobResult | null;
  createdAt: string;
};
