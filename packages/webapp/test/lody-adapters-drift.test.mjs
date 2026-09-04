import { expect, test } from "vitest";
import {
  adapterDriftErrors,
  DEFAULT_REPOSITORY,
  LODY_ADAPTER_NAMES,
} from "../../../scripts/lody-sync-adapters.mjs";

test("the reviewed Lody adapters match their gitlinks and stamps", () => {
  expect(LODY_ADAPTER_NAMES).toEqual(["core", "claude", "codex", "dsh", "grok"]);
  expect(adapterDriftErrors(DEFAULT_REPOSITORY)).toEqual([]);
});
