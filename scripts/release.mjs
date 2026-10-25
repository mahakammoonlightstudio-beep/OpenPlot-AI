#!/usr/bin/env node
/**
 * One-command release helper for OpenPlot AI.
 *
 * It verifies the version/changelog at the target commit, creates the
 * annotated tag on origin/main (unless it already exists locally), pushes the
 * tag — which triggers .github/workflows/release.yml — and prints the Actions
 * and Releases links. `--verify` checks the resulting draft with `gh`.
 *
 *   npm run release -- --dry-run          preview, change nothing
 *   npm run release                       create + push v<package version>
 *   npm run release -- --tag v1.2.1       explicit tag (must match package.json)
 *   npm run release -- --commit b01e7e0   tag a specific commit
 *   npm run release -- --verify           inspect the draft release (needs gh)
 *
 * Safety: never force-pushes, never moves an existing remote tag, never
 * publishes a release, and refuses to run on a dirty working tree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const PROJ = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
const tty = Boolean(stdout.isTTY);

const opts = {
  tag: `v${version}`,
  commit: '',
  remote: 'origin',
  branch: 'main',
  yes: false,
  dryRun: false,
  verify: false,
  allowDirty: false,
  noFetch: false,
  help: false
};

for (let i = 0; i < process.argv.length - 2; i++) {
  const arg = process.argv[i + 2];
  const next = () => {
    const value = process.argv[i + 3];
    if (!value || value.startsWith('-')) fail(`${arg} needs a value`);
    i++;
    return value;
  };
  if (arg === '--tag') opts.tag = next();
  else if (arg.startsWith('--tag=')) opts.tag = arg.slice(6);
  else if (arg === '--commit') opts.commit = next();
  else if (arg.startsWith('--commit=')) opts.commit = arg.slice(9);
  else if (arg === '--remote') opts.remote = next();
  else if (arg.startsWith('--remote=')) opts.remote = arg.slice(9);
  else if (arg === '--branch') opts.branch = next();
  else if (arg.startsWith('--branch=')) opts.branch = arg.slice(9);
  else if (arg === '--yes' || arg === '-y') opts.yes = true;
  else if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--verify') opts.verify = true;
  else if (arg === '--allow-dirty') opts.allowDirty = true;
  else if (arg === '--no-fetch') opts.noFetch = true;
  else if (arg === '--help' || arg === '-h') opts.help = true;
  else fail(`Unknown option: ${arg}\nRun with --help for usage.`);
}

if (opts.help) {
  printHelp();
  process.exit(0);
}
if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(opts.tag)) {
  fail(`Invalid tag "${opts.tag}" — expected v<major>.<minor>.<patch>.`);
}
if (opts.tag !== `v${version}`) {
  fail(`Tag ${opts.tag} does not match package.json version v${version}.\nBump the version first (npm version <x.y.z> --no-git-tag-version) or pass the matching tag.`);
}
if (!version) fail('package.json has no version field.');

// ---------------------------------------------------------------- helpers --

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function note(message) {
  console.log(`• ${message}`);
}

function cmd(command, args, { cwd = PROJ, inherit = false } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    env: process.env
  });
}

function git(...args) {
  return cmd('git', args);
}

function mustGit(...args) {
  const res = git(...args);
  if (res.error) fail(`Could not run git: ${res.error.message}`);
  if (res.status !== 0) {
    fail(`git ${args.join(' ')} failed:\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return String(res.stdout || '').trim();
}

function printCommand(command, args) {
  const quoted = args.map((a) => (/[\s"]/u.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  console.log(`  $ ${command} ${quoted.join(' ')}`);
}

async function confirm(question) {
  if (!tty) {
    fail('No interactive terminal. Re-run with --yes to confirm in a script.');
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function githubSlug() {
  let url = '';
  try { url = mustGit('remote', 'get-url', opts.remote); } catch { return null; }
  const clean = url.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '');
  const match = clean.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function links() {
  const slug = githubSlug();
  if (!slug) return null;
  return {
    actions: `https://github.com/${slug.owner}/${slug.repo}/actions/workflows/release.yml`,
    releases: `https://github.com/${slug.owner}/${slug.repo}/releases`
  };
}

function printHelp() {
  console.log(`
OpenPlot AI — release helper

Usage
  npm run release -- [options]

Options
  --tag <tag>        Tag to release (default: v<package.json version>; must match)
  --commit <sha>     Commit to tag (default: latest ${opts.remote}/${opts.branch})
  --remote <name>    Git remote (default: origin)
  --branch <name>    Branch the tag must come from (default: main)
  --dry-run          Print the commands without creating or pushing anything
  --yes, -y          Skip the confirmation prompt
  --verify           After the build, inspect the draft release with gh
  --allow-dirty      Allow an unclean working tree (tags exclude local changes)
  --no-fetch         Use the existing ${opts.remote}/${opts.branch} ref
  --help, -h         Show this help

What it does
  1. Fetches ${opts.remote}, resolves ${opts.remote}/${opts.branch}, and verifies
     that the commit's package.json version matches the tag.
  2. Checks that CHANGELOG.md has a section for that version.
  3. Refuses to move an existing local or remote tag.
  4. Creates the annotated tag, pushes it, and prints the Actions/Releases links.
  5. GitHub Actions builds Windows, macOS and Linux installers into a DRAFT
     release. Review the assets, then publish the draft manually.

Examples
  npm run release -- --dry-run
  npm run release -- --tag v1.2.1
  npm run release -- --commit b01e7e0 --yes
  npm run release -- --verify
`);
}

// ------------------------------------------------------------ verify mode --

async function verifyRelease() {
  note(`Verifying release ${opts.tag}...`);
  const auth = cmd('gh', ['auth', 'status']);
  if (auth.error || auth.status !== 0) {
    console.error(`
GitHub CLI is not available or not authenticated.

Install it from https://cli.github.com/ and run:
  gh auth login

Then re-run:
  npm run release -- --verify --tag ${opts.tag}

Meanwhile you can check the workflow and draft manually:
${links()?.actions || 'GitHub → Actions → Release'}
${links()?.releases || 'GitHub → Releases'}
`);
    process.exit(1);
  }

  const list = cmd('gh', [
    'run', 'list', '--workflow', 'release.yml', '--limit', '20',
    '--json', 'databaseId,headBranch,headSha,status,conclusion,url,createdAt'
  ]);
  if (list.status === 0) {
    let runs = [];
    try { runs = JSON.parse(list.stdout || '[]'); } catch { runs = []; }
    const run = runs.find((r) => r.headBranch === opts.tag) || runs[0];
    if (!run) {
      note('No Release workflow run found yet. It may take a minute to appear.');
    } else {
      const state = run.conclusion || run.status;
      console.log(`  workflow : ${state} (${run.headBranch || 'unknown ref'})`);
      console.log(`  url      : ${run.url}`);
    }
  }

  const rel = cmd('gh', ['release', 'view', opts.tag, '--json', 'isDraft,tagName,targetCommitish,url,assets']);
  if (rel.status !== 0) {
    note('The draft release is not available yet. Wait for the workflow to finish.');
    return;
  }
  let data;
  try { data = JSON.parse(rel.stdout || '{}'); } catch { fail('Could not parse gh release output.'); }
  const assets = Array.isArray(data.assets) ? data.assets : [];
  console.log(`\n  release  : ${data.tagName} (${data.isDraft ? 'DRAFT' : 'published'})`);
  console.log(`  target   : ${data.targetCommitish}`);
  console.log(`  assets   : ${assets.length}`);
  for (const asset of assets) {
    const kb = Math.round(Number(asset.size || 0) / 1024);
    console.log(`    - ${asset.name} (${kb} KB)`);
    if (Number(asset.size || 0) === 0) console.log('      ⚠ zero-byte asset');
  }
  if (!assets.length) console.log('    (none yet)');
  if (data.url) console.log(`  url      : ${data.url}`);

  if (data.isDraft) {
    console.log(`
Next: review the assets, then publish from the Releases page or with
  gh release edit ${opts.tag} --draft=false --title "OpenPlot AI ${opts.tag}"
`);
  } else {
    console.log('\n✓ Release is published.');
  }
}

// ---------------------------------------------------------------- preflight --

if (opts.verify) {
  await verifyRelease();
  process.exit(0);
}

const status = git('status', '--porcelain');
if (status.error) fail(`Could not run git: ${status.error.message}`);
if (!opts.allowDirty && String(status.stdout || '').trim()) {
  fail(`Working tree is dirty. Commit or stash first, or pass --allow-dirty.\n\n${String(status.stdout).trim()}`);
}

if (!opts.noFetch) {
  note(`Fetching ${opts.remote}...`);
  // No --tags here: a locally modified tag would make the fetch fail with
  // "would clobber existing tag", and the script checks the remote tag with
  // ls-remote below anyway.
  printCommand('git', ['fetch', opts.remote, opts.branch]);
  // Inherit stdio so Git Credential Manager / SSH prompts stay visible.
  const fetched = cmd('git', ['fetch', opts.remote, opts.branch], { inherit: true });
  if (fetched.status !== 0) fail('git fetch failed — see the output above.');
}

// Some minimal checkouts only update FETCH_HEAD (no remote-tracking ref).
// Prefer origin/main, fall back to the freshly fetched HEAD.
const remoteRef = `${opts.remote}/${opts.branch}`;
let targetRaw = opts.commit;
if (!targetRaw) {
  for (const ref of [remoteRef, 'FETCH_HEAD']) {
    const probe = git('rev-parse', '--verify', `${ref}^{commit}`);
    if (probe.status === 0) { targetRaw = ref; break; }
  }
  if (!targetRaw) fail(`Could not resolve ${remoteRef} or FETCH_HEAD.\nRun: git fetch ${opts.remote} ${opts.branch}`);
}
const target = mustGit('rev-parse', '--verify', `${targetRaw}^{commit}`);
const short = mustGit('rev-parse', '--short', target);
const subject = mustGit('log', '-1', '--format=%s', target);
const head = mustGit('rev-parse', 'HEAD');

let targetPkg;
try {
  targetPkg = JSON.parse(mustGit('show', `${target}:package.json`));
} catch (e) {
  fail(`Could not read package.json at ${short}: ${e.message || e}`);
}
if (String(targetPkg.version) !== version) {
  fail(`Commit ${short} has package.json version ${targetPkg.version}, but the working copy says ${version}.\nFetch/pull ${remoteRef} or pass --commit for the right release commit.`);
}

const changelog = mustGit('show', `${target}:CHANGELOG.md`);
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  fail(`CHANGELOG.md at ${short} has no "## [${version}]" section.\nAdd the release notes and commit them first.`);
}

const localTag = git('rev-parse', '-q', '--verify', `refs/tags/${opts.tag}^{commit}`);
let localExists = false;
if (localTag.status === 0) {
  const at = String(localTag.stdout || '').trim();
  if (at !== target) {
    fail(`Local tag ${opts.tag} points to ${at.slice(0, 7)}, not ${short}.\nDelete it with: git tag -d ${opts.tag}\nThen re-run this command.`);
  }
  localExists = true;
}

const remoteTags = git('ls-remote', '--tags', opts.remote, `refs/tags/${opts.tag}`);
if (remoteTags.status !== 0) fail(`Could not check remote tags:\n${(remoteTags.stderr || remoteTags.stdout || '').trim()}`);
if (String(remoteTags.stdout || '').trim()) {
  fail(`Tag ${opts.tag} already exists on ${opts.remote}. Refusing to move a published tag.`);
}

console.log(`
OpenPlot AI release
  version : ${version}
  tag     : ${opts.tag}
  commit  : ${short} ${subject}
  remote  : ${opts.remote}/${opts.branch}
  mode    : ${opts.dryRun ? 'DRY RUN (nothing will change)' : 'live'}
`);

if (head !== target) {
  console.log(`  note    : HEAD is ${head.slice(0, 7)}, so the tag will point to ${short} on ${remoteRef}, not your local HEAD.\n`);
}

const confirmed = opts.yes ? true : await confirm(`Create and push ${opts.tag}? [y/N] `);
if (!confirmed) {
  console.log('Cancelled.');
  process.exit(0);
}

if (localExists) {
  note(`Tag ${opts.tag} already exists locally at ${short}.`);
} else {
  const message = `OpenPlot AI ${opts.tag}`;
  if (opts.dryRun) printCommand('git', ['tag', '-a', opts.tag, target, '-m', message]);
  else {
    const tagged = git('tag', '-a', opts.tag, target, '-m', message);
    if (tagged.status !== 0) fail(`git tag failed:\n${(tagged.stderr || tagged.stdout || '').trim()}`);
    note(`Created annotated tag ${opts.tag} at ${short}.`);
  }
}

if (opts.dryRun) {
  printCommand('git', ['push', opts.remote, opts.tag]);
} else {
  note(`Pushing ${opts.tag} to ${opts.remote}...`);
  // Inherit stdio so the credential prompt/progress is visible. The tag stays
  // local on failure, so the user can fix access and push it again.
  const pushed = cmd('git', ['push', opts.remote, opts.tag], { inherit: true });
  if (pushed.status !== 0) {
    fail(`Push failed — see the output above.\nThe local tag ${opts.tag} still exists; fix access and push it again.`);
  }
  note(`Pushed ${opts.tag}.`);
}

const urls = links();
console.log(`
Next
  1. Watch the Release workflow (3 jobs: Windows, macOS, Linux):
     ${urls ? urls.actions : 'GitHub → Actions → Release'}
  2. Wait for the draft release and check every asset is non-zero:
     ${urls ? urls.releases : 'GitHub → Releases'}
  3. Add the CHANGELOG ${version} notes, then publish the draft (not a pre-release).

After the build finishes, inspect it with:
  npm run release -- --verify --tag ${opts.tag}
`);

if (opts.dryRun) {
  console.log('Dry run complete — no tag was created and nothing was pushed.\n');
}
