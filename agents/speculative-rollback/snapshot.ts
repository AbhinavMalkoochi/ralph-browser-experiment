// Page-state snapshot / restore for the speculative-rollback agent.
//
// The agent's distinguishing mechanism is "execute a candidate action, then
// either commit or REVERT." Reverting means putting the browser back into the
// state it was in before the action was tried. We do this with a tiny
// client-side snapshot: URL + localStorage + sessionStorage captured via a
// single Runtime.evaluate call.
//
// Limitations (called out so an agent author does not assume more than the
// substrate provides):
//   - We do NOT restore HttpOnly cookies. document.cookie cannot read them
//     and we deliberately stay inside the page's JS sandbox; restoring those
//     would need CDP Network.* methods that the per-task CdpBrowserSession
//     does not currently expose.
//   - We do NOT undo server-side side effects. If a candidate action POSTed
//     to /__submit, the server has already recorded it; restoring the URL
//     just gets the page back to a clean DOM. This is fine for the agent
//     mechanism — the judge LLM can still tell the result was a regress and
//     blacklist the action — but irreversible mutations stick.
//   - We restore by clearing storage, re-setting the captured entries, and
//     navigating to the snapshot URL. The navigation reloads page JS, which
//     resets in-page DOM mutations.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface PageState {
  url: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

const CAPTURE_SCRIPT = `(() => {
  const ls = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k != null) ls[k] = localStorage.getItem(k) || "";
    }
  } catch (_) { /* opaque origin or storage disabled */ }
  const ss = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k != null) ss[k] = sessionStorage.getItem(k) || "";
    }
  } catch (_) { /* same */ }
  return {
    url: document.location ? document.location.href : "",
    localStorage: ls,
    sessionStorage: ss,
  };
})()`;

export async function captureState(browser: BrowserSession): Promise<PageState> {
  return await browser.evaluate<PageState>(CAPTURE_SCRIPT);
}

/**
 * Restore the browser to a previously captured state.
 *
 * Order matters: we set storage BEFORE navigating, so the page's init code
 * (which often reads storage on first paint) sees the restored values rather
 * than whatever the candidate action wrote. If the restored URL is on a
 * different origin from the current page, the storage write is a no-op for
 * the restored origin — the next page load will see the destination's own
 * storage. We accept that; cross-origin restoration is not part of the
 * mechanism's contract.
 */
export async function restoreState(
  browser: BrowserSession,
  state: PageState,
): Promise<void> {
  const lsJson = JSON.stringify(state.localStorage);
  const ssJson = JSON.stringify(state.sessionStorage);
  const script = `(() => {
    try {
      localStorage.clear();
      const ls = ${lsJson};
      for (const k in ls) { localStorage.setItem(k, ls[k]); }
    } catch (_) {}
    try {
      sessionStorage.clear();
      const ss = ${ssJson};
      for (const k in ss) { sessionStorage.setItem(k, ss[k]); }
    } catch (_) {}
    return true;
  })()`;
  // Storage operations may fail on opaque origins (e.g. data: URLs); we
  // best-effort and continue to the navigate step regardless.
  try {
    await browser.evaluate(script);
  } catch (_) {
    /* ignored */
  }
  await browser.navigate(state.url);
}

/** Short textual digest for trajectory step records. */
export function describeState(s: PageState): string {
  const lsKeys = Object.keys(s.localStorage).length;
  const ssKeys = Object.keys(s.sessionStorage).length;
  return `url=${truncate(s.url, 80)} ls_keys=${lsKeys} ss_keys=${ssKeys}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
