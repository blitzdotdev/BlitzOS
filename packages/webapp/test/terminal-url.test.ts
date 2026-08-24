import { describe, expect, it } from "vitest";
import { extractTerminalUrls, scanOsc8Links } from "../src/terminal-url";

/**
 * The sign-in banner is the only reason this extractor exists: the webApp
 * offers the member a click-through to the login URL claude prints. claude
 * prints that URL twice — once as visible text, which the terminal wraps at
 * the screen width, and once inside an OSC 8 hyperlink escape, which nothing
 * wraps. Stitching the visible copy back together needs the true wrap width,
 * so it breaks whenever the reported `cols` and the printed width disagree.
 * These pin the hyperlink as the preferred source and the stitcher as the
 * fallback.
 */

const ESC = "\u001b";
const BEL = "\u0007";
const LOGIN_URL =
  "https://claude.ai/oauth/authorize?code=alpha-bravo-charlie&state=delta-echo-foxtrot";

/** Rows exactly as xterm reports them: every wrapped row fills the screen,
 * only the last one is short. */
function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (let at = 0; at < text.length; at += width) rows.push(text.slice(at, at + width));
  return rows;
}

function hyperlink(target: string, visible: string): string {
  return `${ESC}]8;;${target}${BEL}${visible}${ESC}]8;;${BEL}`;
}

describe("extractTerminalUrls", () => {
  it("stitches a wrapped URL when the reported width is the printed width", () => {
    expect(extractTerminalUrls(wrap(LOGIN_URL, 40), 40)).toEqual([LOGIN_URL]);
  });

  it("truncates a wrapped URL when the reported width is wrong", () => {
    // The measured failure: a resize the server has not echoed yet leaves
    // xterm reporting 48 columns for rows printed at 40, so no row looks like
    // a continuation and the member is handed half a URL.
    expect(extractTerminalUrls(wrap(LOGIN_URL, 40), 48)).toEqual([LOGIN_URL.slice(0, 40)]);
  });

  it("prefers the OSC 8 target over the truncated stitch", () => {
    expect(extractTerminalUrls(wrap(LOGIN_URL, 40), 48, [LOGIN_URL])).toEqual([LOGIN_URL]);
  });

  it("keeps a visible URL that no hyperlink extends", () => {
    // Upgrading is prefix-only: an unrelated hyperlink elsewhere on screen
    // must never replace a URL the member can actually read.
    const rows = ["open https://docs.example/guide now"];
    expect(extractTerminalUrls(rows, 80, ["https://other.example/thing"]))
      .toEqual(["https://docs.example/guide"]);
  });

  it("keeps the last URL last, so the caller still picks the newest", () => {
    const rows = ["first https://a.example/login", "second https://b.example/login"];
    expect(extractTerminalUrls(rows, 80, ["https://b.example/login?full=1"]))
      .toEqual(["https://a.example/login", "https://b.example/login?full=1"]);
  });
});

describe("scanOsc8Links", () => {
  it("reads the target out of a BEL-terminated hyperlink", () => {
    expect(scanOsc8Links(`Log in: ${hyperlink(LOGIN_URL, "claude.ai/oauth")}\r\n`).links)
      .toEqual([LOGIN_URL]);
  });

  it("reads an ST-terminated hyperlink that carries params", () => {
    const chunk = `${ESC}]8;id=login;${LOGIN_URL}${ESC}\\visible${ESC}]8;;${ESC}\\`;
    expect(scanOsc8Links(chunk).links).toEqual([LOGIN_URL]);
  });

  it("joins a hyperlink the websocket split across two frames", () => {
    const opened = `banner${ESC}]8;;${LOGIN_URL.slice(0, 24)}`;
    const first = scanOsc8Links(opened);
    expect(first.links).toEqual([]);
    expect(first.carry).toBe(`${ESC}]8;;${LOGIN_URL.slice(0, 24)}`);

    const second = scanOsc8Links(`${LOGIN_URL.slice(24)}${BEL}visible`, first.carry);
    expect(second.links).toEqual([LOGIN_URL]);
    expect(second.carry).toBe("");
  });

  it("carries nothing forward when the chunk ends outside an escape", () => {
    expect(scanOsc8Links("plain output\r\n").carry).toBe("");
  });

  it("drops an escape that never closes rather than growing without end", () => {
    const runaway = scanOsc8Links(`${ESC}]8;;${"x".repeat(5000)}`);
    expect(runaway.links).toEqual([]);
    expect(runaway.carry).toBe("");
  });
});
