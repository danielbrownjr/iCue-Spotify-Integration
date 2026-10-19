import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Encrypt only the refresh token, under the logged-in Windows user's DPAPI key.
// The secret enters PowerShell via stdin, NEVER as a command-line argument.
export async function dpapi(mode, payload) {
  if (process.platform !== "win32") throw new Error("DPAPI requires Windows");
  if (!["protect", "unprotect"].includes(mode)) throw new Error("Unsupported DPAPI operation");
  const action = mode === "protect"
    ? "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($payload), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($payload), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const script = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; " +
    "$payload = [Console]::In.ReadToEnd(); [Console]::Out.Write(" + action + ")";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let result = "";
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 12000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      result += chunk;
      if (result.length > 100000) { failed = true; child.kill(); }
    });
    // Never include subprocess output, potentially sensitive material, in errors.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { failed = true; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0 || !result) return reject(new Error("Windows credential protection unavailable"));
      resolve(result);
    });
    child.stdin.end(payload);
  });
}

export function createRefreshTokenStore(filePath, {
  platform = process.platform,
  transform = dpapi
} = {}) {
  return {
    supported: platform === "win32",
    async load() {
      if (platform !== "win32") return null;
      let encoded;
      try { encoded = (await readFile(filePath, "utf8")).trim(); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Cannot read protected Spotify credential");
      }
      if (!encoded.startsWith("dpapi-v1:")) throw new Error("Unrecognized protected credential format");
      try {
        const token = await transform("unprotect", encoded.slice("dpapi-v1:".length));
        if (!token || typeof token !== "string") throw new Error("Empty credential");
        return token;
      } catch {
        throw new Error("Cannot decrypt Spotify credential for the current Windows user");
      }
    },
    async save(refreshToken) {
      if (platform !== "win32") return false;
      if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Invalid refresh token");
      const encrypted = await transform("protect", refreshToken);
      if (typeof encrypted !== "string" || !encrypted || encrypted.includes(refreshToken))
        throw new Error("Invalid protected credential");
      const tmp = filePath + ".tmp-" + randomBytes(6).toString("hex");
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(tmp, "dpapi-v1:" + encrypted + "\n", { flag: "wx", mode: 0o600 });
        await rename(tmp, filePath);
      } finally {
        await unlink(tmp).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return true;
    },
    async clear() {
      if (platform !== "win32") return;
      try { await unlink(filePath); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
}
