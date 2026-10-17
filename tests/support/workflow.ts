// A reader for the deliberately plain shape of this repository's workflow files (two-space jobs, four-space
// job keys, six-space steps). It is a text reader, not a YAML parser: the contract tests also pin that shape.
export interface Step {
  name: string;
  uses: string | null;
  run: string | null;
  text: string;
}

export interface Job {
  id: string;
  name: string;
  text: string;
  steps: Step[];
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The value of a `key:` line, or the block that follows `key: |` or `key: >`. */
function valueOf(lines: string[], key: string): string | null {
  const at = lines.findIndex((line) => new RegExp(`^\\s*(?:- )?${key}:`).test(line));
  if (at < 0) return null;
  const line = lines[at] as string;
  const inline = line.slice(line.indexOf(":") + 1).trim();
  if (inline !== "|" && inline !== ">") return inline;
  const base = indentOf(line);
  const block: string[] = [];
  for (const next of lines.slice(at + 1)) {
    if (next.trim() !== "" && indentOf(next) <= base) break;
    block.push(next.trim());
  }
  return block.join(inline === "|" ? "\n" : " ").trim();
}

export function stepsOf(job: string): Step[] {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => line === "    steps:");
  if (start < 0) return [];
  const steps: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("      - ")) steps.push([line]);
    else if (steps.length > 0 && (line.trim() === "" || indentOf(line) >= 8)) steps[steps.length - 1]?.push(line);
    else if (line.trim() !== "") break;
  }
  return steps.map((step) => ({
    name: valueOf(step, "name") ?? "",
    uses: valueOf(step, "uses"),
    run: valueOf(step, "run"),
    text: step.join("\n"),
  }));
}

export function jobsOf(workflow: string): Job[] {
  const start = workflow.indexOf("\njobs:\n");
  if (start < 0) return [];
  const jobs: { id: string; lines: string[] }[] = [];
  for (const line of workflow.slice(start + "\njobs:\n".length).split("\n")) {
    const header = /^ {2}([a-z0-9-]+):$/.exec(line);
    if (header) jobs.push({ id: header[1] as string, lines: [] });
    else jobs[jobs.length - 1]?.lines.push(line);
  }
  return jobs.map(({ id, lines }) => {
    const text = lines.join("\n");
    return { id, name: valueOf(lines, "name") ?? "", text, steps: stepsOf(text) };
  });
}

export const jobValue = (job: Job, key: string): string | null =>
  valueOf(
    job.text.split("\n").filter((line) => indentOf(line) === 4 || /^ {4}\S/.test(line)),
    key,
  );
