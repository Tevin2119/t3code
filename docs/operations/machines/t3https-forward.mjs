// Tailscale Serve on macOS can only proxy to localhost, while T3 (t3net) listens on the
// tailnet address only. This passes 127.0.0.1:16232 through to T3 so `tailscale serve`
// can give T3 an https://…ts.net address, which phones need to install it as an app.
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";

const tailnetIp = () => {
  for (const program of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const ip = NodeChildProcess.execFileSync(program, ["ip", "-4"], { encoding: "utf8" })
        .trim()
        .split("\n")[0];
      if (ip.startsWith("100.")) return ip;
    } catch {}
  }
  return "100.124.197.108";
};
const target = { host: tailnetIp(), port: 16231 };

NodeNet.createServer((client) => {
  const upstream = NodeNet.connect(target);
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(16232, "127.0.0.1", () =>
  console.log(`127.0.0.1:16232 -> ${target.host}:${target.port}`),
);
