import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";

const processes = createRequire(import.meta.url)("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");

describe("redaction", () => {
  test("registry credentials and URL userinfo are masked, and everything else is kept", () => {
    expect(processes.redact("//r.example/:_authToken=top-secret")).toBe("//r.example/:_authToken=[redacted]");
    expect(processes.redact("_password = hunter2 and more")).toBe("_password = [redacted] and more");
    expect(processes.redact("https://user:pw" + "@" + "r.example/x")).toBe("https://[redacted]@r.example/x");
    expect(processes.redact("fetching https://r.example/pkg (200)")).toBe("fetching https://r.example/pkg (200)");
  });
});

describe("logged output", () => {
  const started = (result: { status: number | null; stdout: string; stderr: string }) => () => result;
  const writers = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
  };

  test("reaches the writers redacted, stream by stream, and returns the raw status", () => {
    const sink = writers();
    const result = processes.runLogged(
      "tool",
      [],
      { cwd: ".", stdout: sink.stdout, stderr: sink.stderr },
      started({ status: 3, stdout: "//r.example/:_authToken=top-secret\n", stderr: "https://user:pw" + "@" + "r.example/x\n" }),
    );
    expect(result.status).toBe(3);
    expect(sink.out.join("")).toBe("//r.example/:_authToken=[redacted]\n");
    expect(sink.err.join("")).toBe("https://[redacted]@r.example/x\n");
  });

  test("a silent command writes nothing", () => {
    const sink = writers();
    processes.runLogged("tool", [], { cwd: ".", stdout: sink.stdout, stderr: sink.stderr }, started({ status: 0, stdout: "", stderr: "" }));
    expect(sink.out.concat(sink.err)).toEqual([]);
  });

  test("the command, its arguments and its options reach the starter unchanged", () => {
    const calls: unknown[][] = [];
    const sink = writers();
    processes.runLogged("tool", ["a b", "$(x)"], { cwd: "/p", stdout: sink.stdout, stderr: sink.stderr }, (...call) => {
      calls.push(call);
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(calls[0]?.slice(0, 2)).toEqual(["tool", ["a b", "$(x)"]]);
    expect(calls[0]?.[2]).toMatchObject({ cwd: "/p" });
  });
});

describe("the process's own streams", () => {
  test("write to standard output and standard error", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      processes.stdio.stdout("to out");
      processes.stdio.stderr("to err");
      expect(out).toHaveBeenCalledWith("to out");
      expect(err).toHaveBeenCalledWith("to err");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
