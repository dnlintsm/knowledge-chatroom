import { useEffect, useState } from "react";
import { inputDrift, recordedVersion, type FileVersion, type InputDrift, type RecordedInput } from "./run-evidence";
import { experimentPlace, type Experiment } from "./server-files";
import { useWorkspace } from "./store";

export interface InputEvidence {
  input: RecordedInput;
  drift: InputDrift;
  /** For one that differs: the copy's version with the recorded bytes; null when it has none; undefined until known. */
  recorded?: FileVersion | null;
}

/**
 * Each recorded input of the experiment the user is in, and how its copy
 * compares now. It follows the versions this browser knows of the files
 * (serverHash), so a save, here or by someone else, shows at once.
 */
export function useInputEvidence(experiment: Experiment | null): InputEvidence[] {
  const ws = useWorkspace();
  const inputs = experiment?.provenance?.inputs ?? [];
  const place = experiment ? experimentPlace(experiment.id) : null;
  const shown = inputs.map((input) => {
    const now = ws.serverHash(input.path);
    return { input, now, drift: inputDrift(input.sha256, ws.getFile(input.path) !== undefined, now) };
  });
  const keyOf = (input: RecordedInput, now: string | undefined) => `${input.path}\n${input.sha256}\n${now ?? ""}`;
  const differing = shown.filter((s) => s.drift === "differs").map((s) => keyOf(s.input, s.now));
  const [found, setFound] = useState<Record<string, FileVersion | null>>({});
  const wanted = differing.join("\0");
  useEffect(() => {
    let live = true;
    for (const key of wanted ? wanted.split("\0") : []) {
      const [path, sha256, now] = key.split("\n");
      void recordedVersion(path, place, sha256, now).then((version) => {
        if (live) setFound((was) => (key in was ? was : { ...was, [key]: version }));
      });
    }
    return () => {
      live = false;
    };
  }, [wanted, place]);
  return shown.map(({ input, now, drift }) =>
    drift === "differs" ? { input, drift, recorded: found[keyOf(input, now)] } : { input, drift },
  );
}
