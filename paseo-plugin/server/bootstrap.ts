/**
 * Idempotent provisioning of the DSH `paseo` profile the plugin drives.
 *
 * Paseo installs plugins from npm or git and runs no install scripts, so a
 * plugin cannot rely on the repo's `install.sh`. Instead the plugin carries the
 * DSH bridge bundle (embedded by `scripts/generate-bridge-assets.mjs`) and
 * writes the whole profile on load: the profile files, the bridge, and a
 * starter model-route patch when the user has none.
 *
 * The bridge is provisioned as a *declared dependency*, not a bare directory:
 *
 *   profiles/<profile>/vendor/dsh-paseo-bridge/   ← source of truth, rewritten
 *   profiles/<profile>/package.json               ← "dsh-paseo-bridge": "file:./vendor/…"
 *   profiles/<profile>/node_modules/dsh-paseo-bridge/  ← projection dsh resolves
 *
 * A bare `node_modules` directory is invisible to pnpm, so the next
 * `dsh plugin add` treats it as extraneous, moves it to `node_modules/.ignored/`
 * and dsh then silently skips the bundle ("skipping profile bundle …", exit 0).
 * Declaring the dependency keeps pnpm from pruning it and lets `pnpm install`
 * restore it from `vendor/` after any rewrite. The node_modules projection is
 * still written here so the profile boots before pnpm has ever run.
 *
 * Re-running on every load is deliberate — updating the installed plugin is the
 * only step needed to update the bridge, because this rewrites it from the
 * plugin's own embedded copy.
 *
 * @module dsh-paseo/server/bootstrap
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_FILES, BRIDGE_PACKAGE_NAME, PROFILE_PATCH_TEMPLATE_BASE64 } from "./bridge-assets";

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** Where the bridge package lives inside the profile. */
const BRIDGE_VENDOR_PATH = `vendor/${BRIDGE_PACKAGE_NAME}`;

/**
 * The dependency spec the profile declares. Relative, so the profile directory
 * stays movable and the diff stays readable.
 */
const BRIDGE_SPEC = `file:./${BRIDGE_VENDOR_PATH}`;

/** The DSH profile name the bridge runs under. */
export function profileName(): string {
  return process.env.DSH_PASEO_PROFILE ?? "paseo";
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function profilePackageJson(profile: string): string {
  return `${JSON.stringify(
    {
      name: `dsh-profile-${profile}`,
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
      dependencies: { [BRIDGE_PACKAGE_NAME]: BRIDGE_SPEC },
    },
    null,
    2,
  )}\n`;
}

/** Write only when the path does not exist yet. */
function writeIfAbsent(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a child object, creating it in place when absent or mistyped. */
function asRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/** Read a child array, creating it in place when absent or mistyped. */
function asArray(parent: Record<string, unknown>, key: string): unknown[] {
  const existing = parent[key];
  if (Array.isArray(existing)) return existing;
  const created: unknown[] = [];
  parent[key] = created;
  return created;
}

/** Decode the embedded bridge into `root`, replacing whatever was there. */
function writeBridgeTree(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [relativePath, encoded] of Object.entries(BRIDGE_FILES)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(encoded, "base64"));
  }
}

/** @public */
export type ManifestAction = "created" | "updated" | "unchanged" | "unreadable";

/**
 * Make sure `package.json` declares the bridge and lists it as a bundle,
 * without touching anything else the user put there.
 *
 * An unreadable manifest is reported, never repaired: rewriting a file we could
 * not parse would destroy the user's own configuration.
 */
function ensureProfileManifest(dir: string, profile: string): ManifestAction {
  const path = join(dir, "package.json");
  if (!existsSync(path)) {
    writeFileSync(path, profilePackageJson(profile));
    return "created";
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return "unreadable";
    manifest = parsed;
  } catch {
    return "unreadable";
  }

  const before = JSON.stringify(manifest);

  const dsh = asRecord(manifest, "dsh");
  const profileSection = asRecord(dsh, "profile");
  const bundles = asArray(profileSection, "bundles");
  if (!bundles.includes(BRIDGE_PACKAGE_NAME)) bundles.push(BRIDGE_PACKAGE_NAME);

  const dependencies = asRecord(manifest, "dependencies");
  const declared = dependencies[BRIDGE_PACKAGE_NAME];
  // Keep a spec somebody pinned to a registry version; our own `file:` spec is
  // rewritten every load so a moved profile still resolves.
  if (typeof declared !== "string" || declared.startsWith("file:")) {
    dependencies[BRIDGE_PACKAGE_NAME] = BRIDGE_SPEC;
  }

  if (JSON.stringify(manifest) === before) return "unchanged";
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return "updated";
}

export interface ProvisionResult {
  profile: string;
  dir: string;
  bridgeFiles: number;
  patchCreated: boolean;
  manifest: ManifestAction;
}

/**
 * Ensure `$DSH_HOME/profiles/<profile>` exists and carries the bridge.
 *
 * Throws only on a real filesystem failure; callers treat provisioning as a
 * convenience and must not fail plugin load over it.
 */
export function ensurePaseoProfile(): ProvisionResult {
  const profile = profileName();
  const dir = join(dshHome(), "profiles", profile);
  mkdirSync(join(dir, "node_modules"), { recursive: true });

  // The profile's own files belong to the user: create a missing one, never
  // overwrite a customized cordis.yml or workspace file.
  writeIfAbsent(join(dir, "cordis.yml"), CORDIS_YML);
  writeIfAbsent(join(dir, "pnpm-workspace.yaml"), PNPM_WORKSPACE);

  // 1. Source of truth: the package pnpm installs from.
  writeBridgeTree(join(dir, BRIDGE_VENDOR_PATH));

  // 2. Projection dsh resolves before pnpm has ever run. Replaces an older copy
  //    or the symlink the repo's install.sh creates.
  writeBridgeTree(join(dir, "node_modules", BRIDGE_PACKAGE_NAME));

  // 3. Declaration, so pnpm stops treating the projection as extraneous.
  const manifest = ensureProfileManifest(dir, profile);

  // The one file the user owns: never overwrite an existing model route.
  const patch = join(dir, "cordis.patch.yml");
  const patchCreated = !existsSync(patch);
  if (patchCreated) {
    writeFileSync(patch, Buffer.from(PROFILE_PATCH_TEMPLATE_BASE64, "base64"));
  }

  return {
    profile,
    dir,
    bridgeFiles: Object.keys(BRIDGE_FILES).length,
    patchCreated,
    manifest,
  };
}
