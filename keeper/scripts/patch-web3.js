#!/usr/bin/env node
// Patches @solana/web3.js to inject CommonClient and WebSocket into rpc-websockets
// at the point where web3.js loads the package, so it works regardless of which
// rpc-websockets copy (top-level or nested) web3.js resolves to.
const fs   = require("fs");
const path = require("path");

const web3File = path.join(__dirname, "..", "node_modules", "@solana", "web3.js", "lib", "index.cjs.js");

if (!fs.existsSync(web3File)) {
  console.log("patch-web3: @solana/web3.js not found, skipping");
  process.exit(0);
}

let src = fs.readFileSync(web3File, "utf8");

if (src.includes("// patched: rpc-websockets CommonClient shim")) {
  console.log("patch-web3: already patched");
  process.exit(0);
}

const needle = "var rpcWebsockets = require('rpc-websockets');";
if (!src.includes(needle)) {
  console.log("patch-web3: could not find injection point, skipping");
  process.exit(0);
}

const patch = `var rpcWebsockets = require('rpc-websockets');
// patched: rpc-websockets CommonClient shim
if (!rpcWebsockets.CommonClient && rpcWebsockets.Client) rpcWebsockets.CommonClient = Object.getPrototypeOf(rpcWebsockets.Client);
if (!rpcWebsockets.WebSocket) { try { rpcWebsockets.WebSocket = require('rpc-websockets/dist/lib/client/websocket').default || require('rpc-websockets/dist/lib/client/websocket'); } catch(_) { try { rpcWebsockets.WebSocket = require('ws'); } catch(_) {} } }`;

src = src.replace(needle, patch);
fs.writeFileSync(web3File, src);
console.log("patch-web3: patched @solana/web3.js successfully");
