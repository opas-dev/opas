// ABOUTME: Serves the isolated parent-page loader for the embeddable OPAS assistant.
// ABOUTME: Creates one sandboxed iframe and exchanges only validated, bounded protocol messages.

export const embedLoaderScript = String.raw`(() => {
  "use strict";

  const maximumMessageBytes = 4096;
  const maximumPageUrlBytes = 2048;
  const minimumHeight = 240;
  const maximumHeight = 1200;
  const script = document.currentScript;
  if (!script || typeof script.src !== "string") return;

  let scriptUrl;
  let pageUrl;
  try {
    scriptUrl = new URL(script.src);
    pageUrl = new URL(window.location.href);
  } catch {
    return;
  }
  if (
    (scriptUrl.protocol !== "http:" && scriptUrl.protocol !== "https:") ||
    scriptUrl.username !== "" ||
    scriptUrl.password !== "" ||
    (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") ||
    pageUrl.username !== "" ||
    pageUrl.password !== "" ||
    new TextEncoder().encode(pageUrl.href).byteLength > maximumPageUrlBytes
  ) return;

  const embedOrigin = scriptUrl.origin;
  const parentOrigin = pageUrl.origin;
  const iframe = document.createElement("iframe");
  iframe.dataset.opasEmbed = "assistant";
  iframe.title = "OPAS help assistant";
  iframe.referrerPolicy = "no-referrer";
  iframe.sandbox.add("allow-forms", "allow-same-origin", "allow-scripts");
  iframe.src = embedOrigin + "/embed?parentOrigin=" + encodeURIComponent(parentOrigin);
  iframe.style.display = "block";
  iframe.style.width = "100%";
  iframe.style.height = "360px";
  iframe.style.border = "0";
  iframe.style.background = "transparent";

  const exactKeys = (value, expected) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    let bytes;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return false;
    }
    if (bytes > maximumMessageBytes) return false;
    const keys = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
  };

  const sendContext = () => {
    if (!iframe.contentWindow) return;
    const message = { pageUrl: pageUrl.href, type: "opas:context", version: 1 };
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > maximumMessageBytes) return;
    iframe.contentWindow.postMessage(message, embedOrigin);
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== embedOrigin || event.source !== iframe.contentWindow) return;
    if (
      exactKeys(event.data, ["type", "version"]) &&
      event.data.type === "opas:ready" &&
      event.data.version === 1
    ) {
      sendContext();
      return;
    }
    if (
      exactKeys(event.data, ["height", "type", "version"]) &&
      event.data.type === "opas:resize" &&
      event.data.version === 1 &&
      Number.isSafeInteger(event.data.height) &&
      event.data.height >= minimumHeight &&
      event.data.height <= maximumHeight
    ) {
      iframe.style.height = event.data.height + "px";
    }
  });

  const mount = () => document.body?.append(iframe);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();`;
