#!/usr/bin/env node
/**
 * dsh-profile-doctor — держит профиль DeepSeek Harness отдельно от ядра.
 *
 * Проблема, которую решает инструмент: профиль может содержать собственные копии
 * официальных пакетов `@deepseek-ai/*`. Модули из профиля резолвятся раньше модулей
 * ядра, поэтому после обновления DSH старая копия «затеняет» новую, и старт падает
 * с `startup failed: N required plugin did not activate` (ядро отключает
 * несовместимый обязательный плагин ещё до монтирования).
 *
 * Инвариант, который поддерживает доктор:
 *   • официальные пакеты `@deepseek-ai/*` резолвятся только из ядра — они не живут
 *     ни в `dependencies` профиля, ни в `profile/node_modules`;
 *   • в профиле остаются лишь сторонние плагины (link:/file: или npm вне scope ядра);
 *   • `compatibility.json` (разовые исключения совместимости) отсутствует: старые
 *     разрешения вновь включают несовместимые версии;
 *   • выведенные из обращения бандлы удалены из `dsh.profile.bundles`;
 *   • профильные плагины объявляют `engines.dsh`, поэтому несовместимое обновление
 *     ядра отключает их аккуратно, а не роняет DSH.
 *
 * Usage:
 *   node doctor.mjs [--profile desktop] [--install <dir>] [--fix] [--json] [--no-install]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const OFFICIAL_SCOPE = "@deepseek-ai/";
const COMPATIBILITY_FILE = "compatibility.json";
const RETIRED_BUNDLES = new Set([
	"@deepseek-ai/dsh-experimental-schedule-bundle",
	"@deepseek-ai/dsh-experimental-agent-team-profile"
]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printUsage();
	process.exit(0);
}

const install = detectInstall(args.install);
if (install === undefined) {
	console.error('Каталог установки DeepSeek Harness не найден. Укажите: --install "C:\\...\\DeepSeek Harness"');
	process.exit(2);
}

const core = readCoreVersion(install);
const profileName = args.profile ?? "desktop";
const profileDir = resolve(args.home ?? join(homedir(), ".dsh"), "profiles", profileName);
const manifestPath = join(profileDir, "package.json");

if (!existsSync(manifestPath)) {
	console.error(`Профиль ${JSON.stringify(profileName)} не найден: ${profileDir}`);
	process.exit(2);
}

let state = inspect();
const changes = [];
const notes = [];

if (args.fix) {
	const fixes = collectFixes(state);
	if (fixes.length > 0) {
		applyFixes(state, fixes);
		state = inspect();
	}
}

printReport();
process.exit(state.checks.every((check) => check.ok) ? 0 : 1);

/* ------------------------------ inspection ------------------------------- */

function inspect() {
	const manifest = readJson(manifestPath);
	const dependencies = manifest.dependencies ?? {};
	const bundles = manifest.dsh?.profile?.bundles ?? [];

	const officialDeps = Object.entries(dependencies)
		.filter(([name]) => name.startsWith(OFFICIAL_SCOPE))
		.map(([name, spec]) => ({ name, spec }));
	const retired = bundles.filter((bundle) => RETIRED_BUNDLES.has(bundle));
	const shadow = listShadowCopies();
	const compat = readCompatibility();
	const incompatible = incompatiblePlugins(dependencies);

	const checks = [
		check(
			"Официальные пакеты в зависимостях профиля",
			officialDeps.length === 0,
			officialDeps.map((dep) => `${dep.name}@${dep.spec}`),
			"ядро само поставляет все @deepseek-ai/* пакеты; копия в профиле перекрывает обновлённую"
		),
		check(
			"Копии @deepseek-ai/* в profile/node_modules",
			shadow.length === 0,
			shadow,
			"такая копия резолвится раньше ядра — после обновления DSH это старый код"
		),
		check(
			"compatibility.json (разовые исключения совместимости)",
			!compat.exists,
			[`файл есть, исключений: ${compat.count}${compat.stale.length ? `, не про текущее ядро: ${compat.stale.length}` : ""}`],
			"исключение вновь разрешает заведомо несовместимый плагин"
		),
		check(
			"Выведенные из обращения бандлы",
			retired.length === 0,
			retired,
			"такие бандлы установщик удаляет из профиля, остаток только путает загрузку"
		),
		check(
			"Совместимость профильных плагинов с ядром",
			incompatible.length === 0,
			incompatible,
			"DSH отключит такой плагин на старте; расширьте engines.dsh только после проверки плагина на новом ядре"
		)
	];

	return { manifest, dependencies, bundles, officialDeps, retired, shadow, compat, checks };
}

function check(title, ok, details, hint) {
	return { title, ok, details: ok ? [] : details, hint: ok ? undefined : hint };
}

/* -------------------------------- fixes ---------------------------------- */

function collectFixes(state) {
	const fixes = [];
	for (const dep of state.officialDeps) fixes.push({ kind: "dependency", name: dep.name });
	for (const bundle of state.retired) fixes.push({ kind: "bundle", name: bundle });
	if (state.compat.exists) fixes.push({ kind: "compatibility" });
	for (const dir of state.shadow) fixes.push({ kind: "shadow", dir });
	return fixes;
}

function applyFixes(state, fixes) {
	const manifest = state.manifest;
	let touchedManifest = false;

	for (const fix of fixes) {
		if (fix.kind === "dependency") {
			delete manifest.dependencies[fix.name];
			touchedManifest = true;
			changes.push(`манифест: убрана зависимость ${fix.name}`);
		}
		if (fix.kind === "bundle") {
			manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== fix.name);
			touchedManifest = true;
			changes.push(`манифест: убран выведенный бандл ${fix.name}`);
		}
	}

	if (touchedManifest) writeJson(manifestPath, manifest);

	if (fixes.some((fix) => fix.kind === "compatibility")) {
		rmSync(join(profileDir, COMPATIBILITY_FILE), { force: true });
		changes.push("удалён compatibility.json с разовыми исключениями");
	}

	let removedShadows = 0;
	for (const fix of fixes) {
		if (fix.kind !== "shadow") continue;
		rmSync(fix.dir, { recursive: true, force: true });
		removedShadows += 1;
	}
	if (removedShadows > 0) {
		changes.push(`удалено теневых копий @deepseek-ai/*: ${removedShadows}`);
		if (!args.noInstall) runPnpmInstall();
	}
}

function runPnpmInstall() {
	const pnpm = join(install, "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs");
	if (!existsSync(pnpm)) {
		notes.push("pnpm в каталоге установки не найден — pnpm install пропущен");
		return;
	}
	const run = spawnSync(process.execPath, [pnpm, "install", "--no-frozen-lockfile"], {
		cwd: profileDir,
		encoding: "utf8"
	});
	if (run.status === 0) changes.push("pnpm install: зависимости профиля пересобраны");
	else notes.push(`pnpm install не выполнился (код ${signed(run.status)}); профиль всё равно отделён — тени удалены вручную`);
}

/* ------------------------------ detection -------------------------------- */

function detectInstall(explicit) {
	const candidates = [
		explicit,
		process.env.PROFILE_DOCTOR_INSTALL,
		join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness"),
		join(process.env.PROGRAMFILES ?? "", "DeepSeek Harness"),
		"/Applications/DeepSeek Harness.app/Contents/Resources",
		"/opt/deepseek-harness"
	].filter(Boolean);
	const cliName = platform() === "win32" ? "dsh.cmd" : "dsh";
	return candidates.find((candidate) => existsSync(join(candidate, "resources", "runtime", "cli", "bin", cliName)));
}

/**
 * Read the running dsh version from the installation's packed manifest.
 *
 * An asar archive is a pickle header followed by the packed files: bytes 12..16 hold the
 * header-JSON length, JSON starts at byte 16, and the payload starts at the next 4-byte
 * boundary after it. Reading the root `package.json` avoids spawning the CLI, whose
 * `.cmd` shim cannot be spawned portably from Node on Windows.
 */
function readCoreVersion(installDir) {
	const asar = join(installDir, "resources", "app.asar");
	if (!existsSync(asar)) return "unknown";
	try {
		const buffer = readFileSync(asar);
		const jsonLength = buffer.readUInt32LE(12);
		const header = JSON.parse(buffer.toString("utf8", 16, 16 + jsonLength));
		const entry = header.files?.["package.json"];
		if (entry === undefined) return "unknown";
		const dataStart = Math.ceil((16 + jsonLength) / 4) * 4;
		const offset = dataStart + Number(entry.offset);
		const manifest = JSON.parse(buffer.toString("utf8", offset, offset + entry.size));
		const version = String(manifest.version ?? "");
		return /^\d+\.\d+\.\d+/.test(version) ? version : "unknown";
	} catch {
		return "unknown";
	}
}

function listShadowCopies() {
	const scopeDir = join(profileDir, "node_modules", "@deepseek-ai");
	if (!existsSync(scopeDir)) return [];
	return readdirSync(scopeDir, { withFileTypes: true }).map((entry) => join(scopeDir, entry.name));
}

function readCompatibility() {
	const file = join(profileDir, COMPATIBILITY_FILE);
	if (!existsSync(file)) return { exists: false, count: 0, stale: [] };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return { exists: true, count: 0, stale: ["файл не разбирается как JSON"] };
	}
	const entries = Object.entries(parsed ?? {});
	const stale = entries.filter(([, versions]) => !Array.isArray(versions) || !versions.includes(core)).map(([key]) => key);
	return { exists: true, count: entries.length, stale };
}

function incompatiblePlugins(dependencies) {
	const issues = [];
	for (const name of Object.keys(dependencies)) {
		if (name.startsWith(OFFICIAL_SCOPE)) continue;
		const dir = [join(profileDir, "node_modules", name), join(profileDir, name)].find((candidate) =>
			existsSync(join(candidate, "package.json"))
		);
		if (dir === undefined) continue;
		const pkg = readJson(join(dir, "package.json"));
		const requirement = pkg.engines?.dsh ?? pickDshPeer(pkg.peerDependencies);
		if (typeof requirement !== "string") continue;
		if (!satisfies(core, requirement)) issues.push(`${name}@${pkg.version ?? "?"} требует dsh ${requirement}`);
	}
	return issues;
}

function pickDshPeer(peers) {
	if (peers === null || typeof peers !== "object") return undefined;
	for (const [name, range] of Object.entries(peers)) {
		if (name === "@deepseek-ai/dsh" || name.startsWith(OFFICIAL_SCOPE)) return range;
	}
	return undefined;
}

/* -------------------------------- semver --------------------------------- */

function parseSemver(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version).trim());
	if (match === null) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: (match[4] ?? "").split(".").filter(Boolean)
	};
}

function compareSemver(a, b) {
	for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	if (a.pre.length === 0 && b.pre.length === 0) return 0;
	if (a.pre.length === 0) return 1;
	if (b.pre.length === 0) return -1;
	for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
		const left = a.pre[index];
		const right = b.pre[index];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) {
			if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
		} else if (leftNumeric) return -1;
		else if (rightNumeric) return 1;
		else if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

function satisfies(version, range) {
	const target = parseSemver(version);
	if (target === undefined) return false;
	return String(range)
		.split("||")
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => part.split(/\s+/).every((token) => satisfiesComparator(target, token)));
}

function satisfiesComparator(target, token) {
	const normalized = token.replace(/^workspace:/, "");
	const operator = /^(>=|<=|>|<|=|\^|~)?/.exec(normalized)?.[1] ?? "";
	const value = parseSemver(normalized.slice(operator.length));
	if (value === undefined) return true;
	const order = compareSemver(target, value);
	if (operator === ">=") return order >= 0;
	if (operator === "<=") return order <= 0;
	if (operator === ">") return order > 0;
	if (operator === "<") return order < 0;
	if (operator === "^") {
		if (target.major !== value.major) return false;
		if (value.major === 0) return target.minor === value.minor && order >= 0;
		return order >= 0;
	}
	if (operator === "~") return target.major === value.major && target.minor === value.minor && order >= 0;
	return order === 0;
}

/* -------------------------------- output --------------------------------- */

function printReport() {
	if (args.json) {
		console.log(
			JSON.stringify(
				{
					core,
					install,
					profile: { name: profileName, dir: profileDir },
					ok: state.checks.every((check) => check.ok),
					checks: state.checks,
					changes,
					notes
				},
				undefined,
				2
			)
		);
		return;
	}

	console.log(`Ядро DSH: ${core}`);
	console.log(`Установка: ${install}`);
	console.log(`Профиль:   ${profileDir} (${profileName})`);
	console.log("");
	for (const item of state.checks) {
		console.log(`${item.ok ? "[OK]" : "[!!]"} ${item.title}`);
		for (const detail of item.details) console.log(`       ${detail}`);
		if (!item.ok && item.hint !== undefined) console.log(`       → ${item.hint}`);
	}
	for (const note of notes) console.log(`\nпримечание: ${note}`);
	if (changes.length > 0) {
		console.log("");
		for (const change of changes) console.log(`исправлено: ${change}`);
	}
	const healthy = state.checks.every((check) => check.ok);
	if (healthy) console.log("\nПрофиль отделён от ядра: обновление DSH не затронет установленные плагины.");
	else if (!args.fix) console.log("\nЕсть проблемы. Повторите с --fix, чтобы исправить.");
	else console.log("\nЧасть проблем осталась — см. подсказки выше.");
}

/* ------------------------------- utilities ------------------------------- */

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`);
}

function signed(code) {
	return code === null || code === undefined ? "unknown" : code > 0x7fffffff ? code - 0x100000000 : code;
}

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") parsed.help = true;
		else if (argument === "--fix") parsed.fix = true;
		else if (argument === "--json") parsed.json = true;
		else if (argument === "--no-install") parsed.noInstall = true;
		else if (argument === "--profile") parsed.profile = argv[++index];
		else if (argument === "--install") parsed.install = argv[++index];
		else if (argument === "--home") parsed.home = argv[++index];
	}
	return parsed;
}

function printUsage() {
	console.log(`dsh-profile-doctor — профиль DSH отдельно от ядра

Usage:
  node doctor.mjs [--profile <name>] [--install <dir>] [--fix] [--json] [--no-install]

Options:
  --profile <name>   профиль (по умолчанию desktop)
  --install <dir>    каталог установки DeepSeek Harness (по умолчанию автоопределение)
  --home <dir>       каталог DSH_HOME (по умолчанию ~/.dsh)
  --fix              исправить найденное: манифест, тени, исключения, pnpm install
  --no-install       с --fix не запускать pnpm install
  --json             машиночитаемый отчёт

Проверки: официальные пакеты в зависимостях профиля, теневые копии @deepseek-ai/*
в node_modules, compatibility.json, выведенные бандлы, совместимость профильных
плагинов (engines.dsh) с ядром.`);
}
