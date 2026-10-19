import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRefreshTokenStore, dpapi } from "../companion/token-store.mjs";

async function withStore(callback, transform) {
  const dir = await mkdtemp(join(tmpdir(), "icue-spotify-test-"));
  const filename = join(dir, "refresh.dpapi");
  const store = createRefreshTokenStore(filename, { platform: "win32", transform });
  try { await callback(store, filename); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const fakeDpapi = async (mode, text) => mode === "protect"
  ? Buffer.from("protected:" + text, "utf8").toString("base64")
  : Buffer.from(text, "base64").toString("utf8").replace(/^protected:/, "");

test("stores only protected refresh token and reads it across instances", async () => {
  await withStore(async (store, file) => {
    assert.equal(await store.load(), null);
    await store.save("refresh-secret-not-for-logs");
    const fileContent = await readFile(file, "utf8");
    assert.match(fileContent, /^dpapi-v1:/);
    assert.doesNotMatch(fileContent, /refresh-secret-not-for-logs/);
    assert.equal(await store.load(), "refresh-secret-not-for-logs");
    await store.save("rotated-refresh-secret");
    assert.equal(await store.load(), "rotated-refresh-secret");
    await store.clear();
    assert.equal(await store.load(), null);
  }, fakeDpapi);
});

test("unrecognized or corrupted credential fails instead of silently treating it as valid", async () => {
  await withStore(async (store, file) => {
    await writeFile(file, "raw-token");
    await assert.rejects(store.load(), /Unrecognized/);
    await writeFile(file, "dpapi-v1:bad-base64");
    const rejecting = createRefreshTokenStore(file, {
      platform: "win32",
      transform: async () => { throw new Error("sensitive implementation detail"); }
    });
    await assert.rejects(rejecting.load(), (error) => {
      assert.doesNotMatch(error.message, /sensitive/);
      assert.match(error.message, /Cannot decrypt/);
      return true;
    });
  }, fakeDpapi);
});

test("non-Windows development remains memory-only with no disk writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "icue-spotify-nonwin-"));
  try {
    const file = join(dir, "refresh.dpapi");
    const store = createRefreshTokenStore(file, { platform: "linux" });
    assert.equal(store.supported, false);
    assert.equal(await store.save("example-token"), false);
    assert.equal(await store.load(), null);
    await store.clear();
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("protect failures never leave a plaintext or temporary credential file", async () => {
  await withStore(async (store, file) => {
    await assert.rejects(store.save("secret"), /protected credential/);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  }, async () => { throw new Error("protected credential unavailable"); });
});

test("actual current-user Windows DPAPI roundtrip (native runner only)", {
  skip: process.platform !== "win32"
}, async () => {
  await withStore(async (store, file) => {
    const value = "synthetic-ci-refresh-" + Math.random().toString(16);
    await store.save(value);
    assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(value));
    assert.equal(await store.load(), value);
  }, dpapi);
});
