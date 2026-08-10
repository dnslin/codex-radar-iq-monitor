import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const stagingDir = resolve(distDir, "extension");

function fail(message) {
  console.error(`Release package error: ${message}`);
  process.exit(1);
}

function releaseVersion(input) {
  const value = String(input ?? "").trim();
  const version = value.startsWith("v") ? value.slice(1) : value;
  const parts = version.split(".");

  if (parts.length !== 3 || parts.some((part) => !/^(0|[1-9]\d*)$/.test(part))) {
    fail(`expected a tag such as v0.3.0, received ${JSON.stringify(value)}`);
  }

  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 65_535) || numbers.every((part) => part === 0)) {
    fail(`version ${version} is not valid for a Chrome extension manifest`);
  }

  return version;
}

async function copyExtension(version) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  await Promise.all([
    cp(resolve(root, "src"), resolve(stagingDir, "src"), { recursive: true }),
    cp(resolve(root, "icons"), resolve(stagingDir, "icons"), { recursive: true }),
  ]);

  const sourceManifest = JSON.parse(
    await readFile(resolve(root, "manifest.json"), "utf8"),
  );
  const releaseManifest = {
    ...sourceManifest,
    version,
  };

  await writeFile(
    resolve(stagingDir, "manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
}

function createArchive(archivePath) {
  const result = spawnSync("zip", ["-q", "-r", archivePath, "."], {
    cwd: stagingDir,
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    fail("the zip command is required but was not found");
  }
  if (result.status !== 0) {
    fail(`zip exited with status ${result.status ?? "unknown"}`);
  }
}

async function writeChecksum(archivePath) {
  const digest = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`);
  return { checksumPath, digest };
}

const rawTag = process.argv[2] || process.env.GITHUB_REF_NAME;
const version = releaseVersion(rawTag);
const tag = `v${version}`;
const archivePath = resolve(distDir, `codex-radar-iq-monitor-${tag}.zip`);

await copyExtension(version);
createArchive(archivePath);
const { checksumPath, digest } = await writeChecksum(archivePath);
await rm(stagingDir, { recursive: true, force: true });

console.log(`Created ${archivePath}`);
console.log(`Created ${checksumPath}`);
console.log(`SHA-256 ${digest}`);
