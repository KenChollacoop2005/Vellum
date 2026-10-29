// URL hash state
export function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(str) {
  if (!str) return null;
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

export function readHashState() {
  if (typeof location === "undefined") return null;
  return decodeState(location.hash.replace(/^#/, ""));
}

export function writeHashState(obj) {
  if (typeof history === "undefined") return;
  history.replaceState(null, "", `#${encodeState(obj)}`);
}
