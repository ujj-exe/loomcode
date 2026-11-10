import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { fileList } from "./prompt.ts";

test("no file list for the home folder", () => {
  expect(fileList(homedir())).toBeNull();
  expect(fileList(homedir() + "/")).toBeNull();
});

test("file list for a project folder", () => {
  expect(fileList(import.meta.dir + "/..")).toContain("src/prompt.ts");
});
