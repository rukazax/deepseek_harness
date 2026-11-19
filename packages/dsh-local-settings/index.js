/**
 * dsh-local-settings — the host half of this host's local settings layer.
 *
 * Why this plugin exists: the "add workspace" dialog asks the host
 * `directoryPicker` service for a listing without a path, and the browse backend
 * answers with the operator's home directory (`homedir()`). Pointing that
 * dialog at the workspaces root used to require a patch of the core's client
 * bundle — a patch every `npm i -g` erased. This plugin reaches the same effect
 * through the service's public capability object instead, so it lives outside
 * the npm core and survives core updates.
 *
 * Scope of one instance: the `browse` interaction (remote / non-loopback
 * sessions). The native interaction (zenity/kdialog on a loopback bind) carries
 * no start-directory parameter at all; `bin/zenity` and `bin/kdialog` in this
 * layer inject it instead. Both faces read the same settings file.
 *
 * Settings: DSH_PICKER_START (and DSH_PICKER_START_ENABLED=0 to disable) from
 * the process environment, falling back to /srv/apps/dsh/settings/settings.env
 * for sessions started outside systemd.
 *
 * @module dsh-local-settings
 */

import { readFileSync } from 'node:fs';

/** Where the settings layer keeps the host's knobs. */
const DEFAULT_SETTINGS_FILE = '/srv/apps/dsh/settings/settings.env';

/** Marker proving a capability object was already pointed at a start directory. */
const MARK = Symbol.for('dsh-local-settings.picker-start');

/**
 * Parse a `KEY=value` settings file (shell-compatible, `#` comments, optional
 * surrounding quotes). Kept deliberately dumb: the file is one assignment per
 * line and must stay readable by the shims (POSIX sh) and by `dsh-settings`.
 * @param text - file contents.
 * @returns the assignments it declares.
 */
export function parseSettings(text) {
	const out = Object.create(null);
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			if ((first === '"' || first === "'") && value.at(-1) === first) value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/**
 * Resolve the start directory: environment first, then the settings file.
 * @param env - environment sample (production: `process.env`).
 * @param file - settings file path.
 * @param readFile - file reader (injected for tests).
 * @returns the configured directory, or null when the feature is off/missing.
 */
export function resolveStartDirectory(env = process.env, file = DEFAULT_SETTINGS_FILE, readFile = readFileSync) {
	if (env.DSH_PICKER_START_ENABLED === '0') return null;
	const fromEnv = env.DSH_PICKER_START?.trim();
	if (fromEnv) return fromEnv;
	let text;
	try {
		text = String(readFile(file, 'utf8'));
	} catch {
		return null;
	}
	const value = parseSettings(text).DSH_PICKER_START?.trim();
	return value === '' || value === undefined ? null : value;
}

/**
 * Point a directory-picker capability object at a start directory.
 *
 * The browse capability's `list(path, signal)` resolves `path ?? homedir()`, so
 * substituting an absent path is the whole change; an explicit path (a crumb
 * jump, a typed path, the Home button) is left alone. Capability objects are
 * stable per service life, which is why mutating this one is safe and visible to
 * every later call.
 *
 * @param capability - the object returned by `ctx.directoryPicker.capability()`.
 * @param startDirectory - absolute directory the dialog should open in.
 * @returns whether this call changed anything (false when already applied).
 */
export function applyBrowseStart(capability, startDirectory) {
	if (capability === undefined || capability === null) return false;
	if (capability.kind !== 'browse') return false;
	if (typeof capability.list !== 'function') return false;
	if (!startDirectory) return false;
	if (capability[MARK] === startDirectory) return false;
	const list = capability.list.bind(capability);
	capability.list = (path, signal) => list(path ?? startDirectory, signal);
	Object.defineProperty(capability, MARK, { value: startDirectory, configurable: true, enumerable: false });
	return true;
}

/** Cordis plugin name. */
export const name = 'local-settings';

/** The composed directory-picker backend must exist before it can be adjusted. */
export const inject = ['directoryPicker'];

/**
 * Apply the layer: adjust whichever interaction backend this boot composed.
 * @param ctx - host context carrying `directoryPicker`.
 * @param config - the row config; `startDirectory` overrides the settings file.
 */
export function apply(ctx, config = {}) {
	const start = typeof config.startDirectory === 'string' && config.startDirectory.trim() !== '' ? config.startDirectory.trim() : resolveStartDirectory();
	if (start === null) return;
	const capability = ctx.directoryPicker.capability();
	const changed = applyBrowseStart(capability, start);
	if (!changed) return;
	const message = `[local-settings] add-workspace dialog opens at ${start}`;
	try {
		console.log(message);
	} catch {
		/* logging must never break the layer */
	}
}
