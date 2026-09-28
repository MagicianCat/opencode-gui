import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const releaseRoot = join(root, "release", "windows");
const bundleName = `yantu-assistant-windows-${manifest.version}`;
const bundleRoot = join(releaseRoot, bundleName);
const vsixName = `yantu-assistant-${manifest.version}.vsix`;
const serverBuildEnv = { ...process.env, YANTU_BUILD_PROFILE: "server" };

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });

execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["build"], { cwd: root, stdio: "inherit", env: serverBuildEnv });
execFileSync(process.execPath, [join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--no-dependencies", "--out", join(bundleRoot, vsixName)], { cwd: root, stdio: "inherit", env: serverBuildEnv });

for (const file of ["Install-Yantu.ps1", "Uninstall-Yantu.ps1", "README.txt"]) {
  cpSync(join(root, "windows-installer", file), join(bundleRoot, file));
}
cpSync(join(root, "windows-installer", "hook-carrier"), join(bundleRoot, "hook-carrier"), { recursive: true });
cpSync(join(root, "resources", "codebuddy-plugin", "plugins", "yantu-assistant-telemetry", "scripts"), join(bundleRoot, "telemetry"), { recursive: true });

const zipPath = join(releaseRoot, `${bundleName}.zip`);
rmSync(zipPath, { force: true });
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath '${bundleRoot.replaceAll("'", "''")}' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-q", "-r", zipPath, basename(bundleRoot)], { cwd: releaseRoot, stdio: "inherit" });
}
console.log(zipPath);
