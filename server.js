const http = require("http");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

const HOST = "127.0.0.1";
const PORT = 9876;
const FILTERED_MESSAGE_MARKERS = [
  "IngenicoAxL:request:",
  "IngenicoAxL:response:"
];
const NUA_CLIENT_TAG = "NUAClient";
const NUA_CLIENT_MESSAGE_MARKERS = ["Sent:", "Received:"];
const execFileAsync = promisify(execFile);

async function getConnectedDevice() {
  const { stdout } = await execFileAsync("adb", ["devices", "-l"], {
    windowsHide: true
  });
  const devices = stdout
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 2 || columns[1] !== "device")
        return null;

      const properties = Object.fromEntries(
        columns.slice(2).map(property => {
          const separator = property.indexOf(":");
          return separator < 0
            ? [property, ""]
            : [property.slice(0, separator), property.slice(separator + 1)];
        })
      );

      return {
        serial: columns[0],
        model: (properties.model || properties.product || "Android device").replace(/_/g, " "),
        product: properties.product || ""
      };
    })
    .filter(Boolean);

  if (devices.length === 0)
    throw new Error("No authorized ADB device found. Check `adb devices -l` and authorize the device.");
  if (devices.length > 1)
    throw new Error(`Found ${devices.length} ADB devices. Disconnect extras so only the intended device remains.`);

  return devices[0];
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    res.setHeader("Access-Control-Allow-Origin", origin || "*");

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseLogcatEntry(line) {
  const match = line.match(
    /^\S+\s+\S+\s+(?:\d+\s+\d+|\d+-\d+)\s+(?:[VDIWEFAS]\s+)?([^:]+):\s?(.*)$/
  );
  return match
    ? { tag: match[1].trim(), message: match[2] }
    : null;
}

function matchesLogcatFilter(line, entry) {
  if (FILTERED_MESSAGE_MARKERS.some(marker => line.includes(marker)))
    return true;

  return Boolean(
    entry &&
    entry.tag === NUA_CLIENT_TAG &&
    NUA_CLIENT_MESSAGE_MARKERS.some(marker => entry.message.includes(marker))
  );
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ADB helper is running");
    return;
  }

  if (req.method !== "GET" || req.url !== "/stream") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  let adb = null;
  let pending = "";
  let clientClosed = false;
  let currentEntryLines = [];
  let currentEntryMatches = false;
  let previousEntryWasEmptyReceived = false;
  let flushTimer = null;

  const flushCurrentEntry = () => {
    if (currentEntryMatches && currentEntryLines.length && !clientClosed)
      sendSse(res, "message", currentEntryLines.join("\n"));

    currentEntryLines = [];
    currentEntryMatches = false;
  };

  const heartbeat = setInterval(() => {
    if (!clientClosed)
      res.write(": keep-alive\n\n");
  }, 15000);

  const closeStream = () => {
    if (clientClosed)
      return;

    clientClosed = true;
    clearInterval(heartbeat);
    clearTimeout(flushTimer);
    if (adb && !adb.killed)
      adb.kill();
  };

  res.on("close", closeStream);

  async function startLogcat() {
    let device;
    try {
      device = await getConnectedDevice();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not identify the ADB device.";
      if (!clientClosed)
        sendSse(res, "helper-error", message);
      if (!res.writableEnded)
        res.end();
      return;
    }

    if (clientClosed)
      return;

    sendSse(res, "device", device);
    adb = spawn(
      "adb",
      ["-s", device.serial, "logcat", "-v", "threadtime", "-b", "all", "-T", "1"],
      { windowsHide: true }
    );
    let adbErrorOutput = "";

    adb.stdout.setEncoding("utf8");
    adb.stderr.setEncoding("utf8");
    adb.stderr.on("data", chunk => {
      adbErrorOutput = (adbErrorOutput + chunk).slice(-4000);
    });

    adb.stdout.on("data", chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();

      for (const line of lines) {
        const entry = parseLogcatEntry(line);
        if (entry) {
          flushCurrentEntry();

          const isReceivedPayloadLine = previousEntryWasEmptyReceived &&
            entry.tag === NUA_CLIENT_TAG &&
            /^\s*(?:(?:size:\s*\d+)\s+)?msg:\s*\{/.test(entry.message);
          currentEntryMatches = matchesLogcatFilter(line, entry) || isReceivedPayloadLine;
          currentEntryLines = currentEntryMatches ? [line] : [];
          previousEntryWasEmptyReceived = entry.tag === NUA_CLIENT_TAG &&
            /^Received:\s*$/.test(entry.message);
        } else if (currentEntryMatches && line.trim()) {
          currentEntryLines.push(line);
        }
      }

      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushCurrentEntry, 50);
    });

    adb.on("error", error => {
      console.error("Could not start adb logcat:", error.message);
      if (!clientClosed)
        sendSse(res, "helper-error", `Could not start adb: ${error.message}`);
      closeStream();
      if (!res.writableEnded)
        res.end();
    });

    adb.on("close", (code, signal) => {
      if (clientClosed)
        return;

      clearTimeout(flushTimer);
      flushCurrentEntry();
      const details = adbErrorOutput.trim();
      const reason = details
        ? `ADB logcat failed: ${details}`
        : signal
          ? `ADB logcat stopped (${signal})`
          : `ADB logcat exited with code ${code}`;
      sendSse(res, "helper-error", reason);
      closeStream();
      res.end();
    });
  }

  startLogcat();
});

server.listen(PORT, HOST, () => {
  console.log(`ADB live-log helper running at http://${HOST}:${PORT}`);
});
