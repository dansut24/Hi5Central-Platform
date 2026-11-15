// Hi5Central EPM Newtest-only Edge/Chrome bridge.
// Browser download completion is NOT equivalent to a UAC interception.
// No extension code elevates a process, controls consent.exe, or handles
// administrator credentials. It merely opens the signed local EPM requester.
"use strict";

const HOST = "com.hi5central.epm_browser";
const PREFIX = "hi5epm-download-";
const ICON = chrome.runtime.getURL("icon-128.png");

function isExe(item) {
  return item && item.state === "complete"
    && typeof item.filename === "string"
    && /\.exe$/i.test(item.filename)
    && !item.filename.startsWith("\\\\");
}
function shortName(path) {
  return path.split(/[\\/]/).pop().slice(0, 72);
}
async function inform(id, title, message, actionButton) {
  const settings = {
    type: "basic",
    iconUrl: ICON,
    title,
    message,
    priority: 1,
    silent: false
  };
  if (actionButton) settings.buttons = [{title: actionButton}];
  await chrome.notifications.create(id, settings);
}
async function getDownload(id) {
  const downloads = await chrome.downloads.search({id});
  return downloads.find(isExe);
}
async function requestDownload(id) {
  const file = await getDownload(id);
  if (!file) {
    await inform("hi5epm-error", "Hi5Central EPM", "The completed EXE is no longer available.");
    return;
  }
  // Native Messaging allows only the explicitly registered extension origin.
  // The native host limits paths to this user's local Downloads folder,
  // then the EPM service authenticates SID/session and re-verifies file hash
  // and digital signer before submitting a technician approval.
  chrome.runtime.sendNativeMessage(HOST, {type: "request", path: file.filename}, async response => {
    const error = chrome.runtime.lastError?.message;
    const ok = !error && response?.ok === true;
    const msg = ok
      ? "The Hi5Central Windows prompt is opening. Enter your reason to request approval."
      : (response?.message || "Browser bridge not installed. Use Run with Hi5Central admin in Explorer.");
    try {await inform("hi5epm-result", "Hi5Central EPM", msg);} catch {/* Browser alerts are optional. */}
  });
}

chrome.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current !== "complete") return;
  try {
    const file = await getDownload(delta.id);
    if (!file) return;
    await inform(PREFIX + String(file.id),
      "Hi5Central — Installer downloaded",
      shortName(file.filename) + " is ready. Request admin access instead of opening it through the Windows UAC prompt.",
      "Request admin access");
  } catch { /* Never disrupt the browser's normal downloads. */ }
});

chrome.notifications.onClicked.addListener(async id => {
  if (!id.startsWith(PREFIX)) return;
  await requestDownload(Number(id.slice(PREFIX.length)));
});
chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  if (buttonIndex !== 0 || !id.startsWith(PREFIX)) return;
  await requestDownload(Number(id.slice(PREFIX.length)));
});
chrome.action.onClicked.addListener(async () => {
  try {
    const downloads = await chrome.downloads.search({
      state: "complete", orderBy: ["-startTime"], limit: 25
    });
    const file = downloads.find(isExe);
    if (file) await requestDownload(file.id);
    else await inform("hi5epm-none", "Hi5Central EPM",
      "No completed EXE found. Download an installer, then click the Hi5Central extension icon.");
  } catch {
    await inform("hi5epm-fail", "Hi5Central EPM", "Unable to check browser downloads.");
  }
});
