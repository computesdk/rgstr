/**
 * The `rgstr claim` flow, importable: plan (read-only — the organization's
 * applications, public package metadata, local files; prints what would be
 * filed and the README diff) and apply (files the claim, writes the badge).
 * The CLI and @rgstr/mcp both run exactly this; `say` is where the human
 * lines go (the terminal, a collected plan, or nowhere).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RgstrApiError, RgstrClient, RgstrCliError } from './client.js';
import type { Ecosystem } from './project.js';
import { chooseTargets, detectPackages, gitCheckout, nextSteps, openBadgePr, planBadge, readmeFor, sameRepo, shortRepo, workspaceGlobs, type GitCheckout, type PackageTarget } from './readme.js';
import { unifiedDiff } from './use.js';
import { badgeMarkdown, buildClaimPlan, describeRepo, fetchRepoUrl, proofKindLabel, renderClaimPlan, repoDirectoryFrom, type ProofSightingLike } from './claim.js';
import type { WhoisResponse } from './api-types.js';

export type Say = (line: string) => void;
export const silent: Say = () => {};

export interface ClaimResponse {
  request: { id: string; name: string; status: string; verification: string };
  dispute: { holder: string; via: string } | null;
  // The badge is the only proof; older servers also sent manifest lines
  // here, which are ignored.
  proof: { token: string; badge?: string | null } | null;
  url: string;
  // Sent by newer servers; rendered when present.
  badgeMarkdown?: string | null;
  agentPrompt?: string | null;
  repoUrl?: string | null;
  proofKinds?: string[] | null;
}
export interface ClaimsList {
  pending: Array<{ id: string; name: string; status: string; verification: string; createdAt: string; proof: ClaimResponse['proof'] } & Partial<Pick<ClaimResponse, 'badgeMarkdown' | 'agentPrompt' | 'repoUrl' | 'proofKinds'>>>;
  held: Array<{ id: string; name: string; kind: string; status: string }>;
}
export type ProofOutcome =
  | { kind: 'verified'; detail: string; autoApproved: boolean; reviewReason?: string; sighting: ProofSightingLike; repoUrl?: string | null }
  | { kind: 'not_found'; checked: string[]; failed: string[]; repoUrl?: string | null }
  | { kind: 'error'; message: string };

export type ClaimOpts = {
  check?: boolean;
  badge?: boolean;
  yes?: boolean;
  pr?: boolean;
  all?: boolean;
  here?: boolean;
  npm?: boolean;
  pip?: boolean;
  statement?: string;
};

/** A package to claim: detected here, or just a name typed on the command line. */
export type ClaimTarget = Omit<PackageTarget, 'manifest'> & { manifest: string | null };

export type ProofCheckResponse = { outcome: ProofOutcome; request: ClaimsList['pending'][number] };

/** POST check-proof. A badge that is not there yet comes back as 422
 *  `proof_not_found` with the outcome in `details` and the next step in
 *  `hint`; that is an answer, not a failure. */
async function checkProof(c: RgstrClient, requestId: string): Promise<{ res: ProofCheckResponse; hint: string | null }> {
  try {
    return { res: await c.post<ProofCheckResponse>(`/api/v1/registry/claims/${requestId}/check-proof`), hint: null };
  } catch (err) {
    if (err instanceof RgstrApiError && err.code === 'proof_not_found' && err.details && typeof err.details === 'object') {
      return { res: err.details as ProofCheckResponse, hint: err.hint ?? null };
    }
    throw err;
  }
}

/** One package's `--check`. Prints the human lines; returns the JSON shape
 *  so a workspace run can emit a single document. */
export async function checkOne(c: RgstrClient, say: Say, t: ClaimTarget): Promise<Record<string, unknown>> {
  const { name } = t;
  const list = await c.get<ClaimsList>('/api/v1/registry/claims');
  const pending = list.pending.find((p) => p.name === name);
  if (!pending) {
    const held = list.held.find((h) => h.name === name);
    const whois = await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(name)}`);
    if (held?.status === 'verified') say(`${name}: verified — your organization claims it. ${whois.url}`);
    else if (whois.holder) say(`${name}: claimed by ${whois.holder.name} (${whois.holder.slug}) — file a claim with \`rgstr claim\` to dispute it.`);
    else say(`${name}: no application from your organization yet — run \`rgstr claim ${name}\` first.`);
    return { name, checked: false, held: held ?? null, whois };
  }
  const { res, hint } = await checkProof(c, pending.id);
  const result = { name, ...res, ...(res.outcome.kind === 'verified' ? { proofKind: proofKindLabel({ name, ...res.outcome }) } : {}) };
  const o = res.outcome;
  if (o.kind === 'verified') {
    say(`${name}: verified via ${proofKindLabel({ name, ...o })} — ${o.detail}`);
    say(o.autoApproved ? `Approved: your organization now claims ${name}.` : `Proof verified and attached to your application; ${o.reviewReason ?? 'an rgstr reviewer decides'}.`);
  } else if (o.kind === 'not_found') {
    const repo = o.repoUrl ?? pending.repoUrl ?? null;
    const where = [o.checked.length ? o.checked.join(', ') : 'npm, PyPI', repo ? `the README of ${repo}` : null].filter(Boolean).join(' and ');
    say(`${name}: no proof found yet (checked ${where}${t.version ? `; local version ${t.version}` : ''}).`);
    if (o.failed.length) say(`Could not reach: ${o.failed.join(', ')}.`);
    say(hint ?? `Add the badge to the repository README and merge it (\`rgstr claim ${name}\` prints it), or ship it in the package README (\`rgstr claim --here\`) and publish, then run \`rgstr claim --check ${name}\` again.`);
  } else say(`${name}: check failed — ${o.message}`);
  return result;
}

export interface ReadmeOutcome {
  file: string;
  action: 'written' | 'replaced' | 'present' | 'needs_yes' | 'wrong_repo' | 'none';
  line?: string;
  reason?: string;
}

/** Stands in for the proof token until the claim is filed: the preview diff
 *  shows the line, the write uses the real one. */
export const PROOF_PLACEHOLDER = 'rgstr_…';

/** One package, planned and shown. Nothing is filed or written from here. */
export interface ClaimPreview {
  t: ClaimTarget;
  /** Already verified for this organization: nothing to file, nothing to write. */
  verified: boolean;
  /** An application already under review: nothing to file; its proof is the badge. */
  pending: ClaimResponse | null;
  repoUrl: string | null;
  /** The README the badge goes in, as it is now; `write` when the badge is not in it yet. */
  readme: { file: string; rel: string; exists: boolean; source: string | null; write: boolean } | null;
  outcome: ReadmeOutcome | null;
}

export interface ClaimOutcome {
  name: string;
  ecosystem: Ecosystem;
  claim: ClaimResponse | null;
  alreadyPending: boolean;
  repoUrl: string | null;
  plan: ReturnType<typeof buildClaimPlan> | null;
  readme: ReadmeOutcome | null;
}

export function claimFromPending(c: RgstrClient, pending: ClaimsList['pending'][number]): ClaimResponse {
  const { proof, badgeMarkdown: badge, agentPrompt, repoUrl, proofKinds, ...request } = pending;
  return { request, dispute: null, proof, url: `${c.baseUrl}/registry/${pending.name}`, badgeMarkdown: badge, agentPrompt, repoUrl, proofKinds };
}

/** The badge links to the public origin the server names; a dev base URL
 *  still gets a badge it can serve. */
function originOf(c: RgstrClient, claim: ClaimResponse | null): string {
  try {
    return claim ? new URL(claim.url).origin : c.baseUrl;
  } catch {
    return c.baseUrl;
  }
}

/** `@scope` alone: the namespace, not a package in it. */
function isNamespace(name: string, ecosystem: Ecosystem): boolean {
  return ecosystem === 'npm' && /^@[^/]+$/.test(name);
}

export function planFor(c: RgstrClient, claim: ClaimResponse, t: ClaimTarget, repoUrl: string | null) {
  if (!claim.proof) return null;
  const origin = originOf(c, claim);
  return buildClaimPlan({ name: t.name, ecosystem: t.ecosystem, origin, token: claim.proof.token, repoUrl: claim.repoUrl ?? repoUrl, badge: claim.badgeMarkdown ?? claim.proof.badge, agentPrompt: claim.agentPrompt });
}

function printPlan(say: Say, plan: NonNullable<ReturnType<typeof planFor>>, claim: ClaimResponse): void {
  say('');
  say(renderClaimPlan(plan));
  if (claim.proofKinds?.length) say(`\nAccepted proofs: ${claim.proofKinds.join(', ')}.`);
}

/** Show what `rgstr claim` would do for one package: whether a claim gets
 *  filed, and the diff of the README the badge goes in. Reads only — the
 *  organization's applications, public package metadata, local files. */
export async function previewOne(
  c: RgstrClient,
  say: Say,
  opts: ClaimOpts,
  t: ClaimTarget,
  list: ClaimsList,
  ctx: { dir: string; checkout: GitCheckout | null; single: boolean; asWho: string },
): Promise<ClaimPreview> {
  const { name, ecosystem } = t;
  say(`Claiming ${name} as ${ctx.asWho}`);
  const held = list.held.find((h) => h.name === name);
  if (held?.status === 'verified') {
    say(`${name}: verified — your organization already claims it. ${c.baseUrl}/registry/${name}`);
    return { t, verified: true, pending: null, repoUrl: null, readme: null, outcome: { file: 'README.md', action: 'none', reason: 'already verified' } };
  }
  const pendingRecord = list.pending.find((p) => p.name === name);
  const pending = pendingRecord ? claimFromPending(c, pendingRecord) : null;
  if (pending) say(`${name}: already under review (${pending.request.id.slice(0, 8)}) — nothing to file.`);
  else if (isNamespace(name, ecosystem)) {
    // No proof token is issued for a namespace, so there is no badge to
    // preview — promising a README write here would not be kept.
    say(`Files the claim: ${name} is a namespace — reviewed on identity + evidence, there is no badge to publish.`);
    return { t, verified: false, pending, repoUrl: null, readme: null, outcome: { file: 'README.md', action: 'none', reason: 'namespace claim' } };
  } else say(`Files the claim: ${name} goes under review until the badge is in a README rgstr reads.`);

  const repoUrl = pending?.repoUrl ?? (await fetchRepoUrl(originOf(c, pending), name, ecosystem));
  const plan = pending ? planFor(c, pending, t, repoUrl) : null;
  if (pending && !plan) {
    say('Namespace claims are reviewed on identity + evidence; nothing to publish.');
    return { t, verified: false, pending, repoUrl, readme: null, outcome: null };
  }
  const badge = plan?.badge ?? badgeMarkdown(c.baseUrl, name, PROOF_PLACEHOLDER);
  const preview: ClaimPreview = { t, verified: false, pending, repoUrl, readme: null, outcome: null };

  if (t.manifest === null) {
    // `rgstr claim <name>` with no package here: there is no README of ours
    // to edit, so the badge and the agent prompt are the deliverable.
    if (plan && pending) printPlan(say, plan, pending);
    else say(`No package here: once filed, it prints the badge for the README of ${describeRepo(name, ecosystem, repoUrl)} and a prompt for your coding agent.`);
    preview.outcome = { file: 'README.md', action: 'none', reason: 'no package here' };
    return preview;
  }

  // The README rgstr reads is where the badge goes: the folder the package
  // declares (else the repository root) when this checkout is that
  // repository; the package's own README with --here. Outside a checkout, or
  // when the two cannot be matched, the diff is still shown — writing always
  // takes a yes, so looking costs nothing.
  const declared = repoUrl;
  const here = ctx.checkout?.remote ?? null;
  const root = ctx.checkout?.root ?? t.dir;
  const matched = !!(declared && here && sameRepo(declared, here));
  // No `origin` to compare: the checkout is taken to be the declared
  // repository, so the badge still goes where rgstr reads it.
  const assumed = !!declared && !!ctx.checkout && !here;
  const declaredDir = !opts.here && (matched || assumed) ? repoDirectoryFrom(declared!) : undefined;
  const { file, exists, where } = await readmeFor({ ...t, manifest: t.manifest ?? '' }, root, opts.here ? false : ctx.single, declaredDir);
  const rel = path.relative(ctx.dir, file) || path.basename(file);
  const registry = ecosystem === 'npm' ? 'npm' : 'PyPI';
  const mismatch = !opts.here && declared && here && !matched;
  if (mismatch) {
    say(`\n${registry} says ${shortRepo(declared!)}, this checkout is ${shortRepo(here!)} — rgstr reads the badge off ${shortRepo(declared!)}'s README, so it will not be written here. Run this in a checkout of ${shortRepo(declared!)}, or keep it in this package's README with --here (verifies on the next publish).`);
    if (plan && pending) printPlan(say, plan, pending);
    preview.outcome = { file: rel, action: 'wrong_repo', reason: `declared ${declared}, checkout ${here}` };
    return preview;
  }
  if (!opts.here && declared && !ctx.checkout) {
    say(`\nNot a git checkout, so this folder cannot be matched to ${shortRepo(declared!)}, where rgstr reads the badge (its ${repoDirectoryFrom(declared!) ? `${repoDirectoryFrom(declared!)}/` : 'root '}README). The diff below is for ${rel} here; it counts once that line is in ${shortRepo(declared!)}'s README, or ships in the package README.`);
  } else if (!opts.here && declared && !here) {
    say(`\nNo \`origin\` remote here, so this checkout cannot be matched to ${shortRepo(declared!)}, where rgstr reads the badge. The diff below is for its ${repoDirectoryFrom(declared!) ? `${repoDirectoryFrom(declared!)}/` : 'root '}README, ${rel}; make sure this checkout is that repository before pushing it.`);
  }
  if (!declared) {
    say(`\n(${name} declares no repository on ${registry}${here ? `; this checkout is ${shortRepo(here)}` : ''}. Declare \`repository\` in your next release so rgstr knows where to look, or keep the badge in the package README with --here.)`);
  }

  if (opts.here && declared && repoDirectoryFrom(declared) === null && path.resolve(root) !== path.resolve(t.dir)) {
    say(`\n--here: the badge stays in ${rel}. rgstr reads the repository's root README on GitHub, not this one, so the claim verifies when this README ships in your next ${registry} release (rgstr claim --check ${name} after publishing).`);
  } else if (where === 'root') {
    const manifestRel = path.relative(root, t.manifest ?? t.dir).split(path.sep).join('/');
    const pkgDir = path.relative(root, t.dir).split(path.sep).join('/');
    say(
      `\n${registry} says ${shortRepo(declared!)} with no directory, so rgstr reads the repository's root README — the badge goes in ${rel}, not next to ${manifestRel}. To keep it with the package, declare ${ecosystem === 'npm' ? `"repository": { "url": ..., "directory": "${pkgDir}" }` : `the /tree/HEAD/${pkgDir} URL`} in your next release.`,
    );
  } else if (where === 'declared') {
    say(`\n${registry} says ${shortRepo(declared!)}, so the badge goes in that folder's README (${rel}).`);
  }

  const source = exists ? await fs.readFile(file, 'utf8') : null;
  const bp = planBadge(source, name, badge);
  if (bp.kind === 'present') {
    say(`\n${rel} already has the badge for ${name} (token matches). Commit and push it if you have not, then: rgstr claim --check ${name}`);
    preview.readme = { file, rel, exists, source, write: false };
    preview.outcome = { file: rel, action: 'present', line: bp.old.line };
    return preview;
  }
  say(
    `\n${rel}: ${
      bp.kind === 'replace' ? `has a badge for ${name} with a different token — will replace it` : exists ? 'will add the badge under the first heading' : `no README in ${path.dirname(rel) === '.' ? 'this directory' : path.dirname(rel)} — will create it with the badge`
    }`,
  );
  say(unifiedDiff(rel, source, bp.next));
  if (!pending) say(`(${PROOF_PLACEHOLDER} is the proof token; it is issued when the claim is filed and written in its place.)`);
  preview.readme = { file, rel, exists, source, write: true };
  preview.outcome = { file: rel, action: 'needs_yes', reason: 'pass --yes to write' };
  return preview;
}

/** File the claim and write the badge for one package — only ever after
 *  `--yes` or a yes at the prompt. */
export async function applyOne(c: RgstrClient, say: Say, opts: ClaimOpts, p: ClaimPreview): Promise<ClaimOutcome> {
  const { t } = p;
  const { name, ecosystem } = t;
  const out: ClaimOutcome = { name, ecosystem, claim: p.pending, alreadyPending: !!p.pending, repoUrl: p.repoUrl, plan: null, readme: p.outcome };
  if (p.verified) return out;

  let claim = p.pending;
  if (!claim) {
    try {
      claim = await c.post<ClaimResponse>('/api/v1/registry/claims', { name, statement: opts.statement });
    } catch (err) {
      if (!(err instanceof RgstrApiError && err.status === 409)) throw err;
      // Filed in the meantime: carry on with that application's proof so the
      // badge written is the one that verifies.
      const list = await c.get<ClaimsList>('/api/v1/registry/claims');
      const pending = list.pending.find((r) => r.name === name);
      if (!pending) throw err;
      out.alreadyPending = true;
      claim = claimFromPending(c, pending);
    }
    say(out.alreadyPending ? `${name}: already under review (${claim.request.id.slice(0, 8)}).` : `Filed: ${name} (${claim.url})`);
    if (claim.dispute) say(`Claimed by ${claim.dispute.holder} via ${claim.dispute.via} — this is a dispute; a reviewer decides.`);
  }
  out.claim = claim;
  const plan = planFor(c, claim, t, p.repoUrl);
  out.plan = plan;
  out.repoUrl = plan?.repoUrl ?? p.repoUrl;
  if (!plan) {
    if (!p.pending) say('Namespace claims are reviewed on identity + evidence; nothing to publish.');
    return out;
  }
  // No README of ours to write (no package here, or the wrong checkout): the
  // badge and the agent prompt are the deliverable — shown now that the proof
  // token exists; a pending application showed them in the preview.
  if (!p.readme) {
    if (!p.pending) printPlan(say, plan, claim);
    return out;
  }
  if (!p.readme.write) return out;
  const { file, rel } = p.readme;
  // Read it again now, not the preview's copy: with --all several packages
  // can share one README (the repository root's), and each badge has to go
  // on top of the ones written just before it.
  const source = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const exists = source !== null;
  const bp = planBadge(source, name, plan.badge);
  if (bp.kind === 'present') {
    out.readme = { file: rel, action: 'present', line: bp.old.line };
    return out;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bp.next);
  say(`\n${rel}: ${bp.kind === 'replace' ? 'replaced the badge' : exists ? 'written' : 'created'}`);
  out.readme = { file: rel, action: bp.kind === 'replace' ? 'replaced' : 'written', line: plan.badge };
  return out;
}

/** "file the claim for x as acme and write README.md" — the sentence the
 *  prompt, the --yes hint and the --json hint all use. */
export function describeApply(file: string[], write: string[], asWho: string): string {
  const parts: string[] = [];
  if (file.length === 1) parts.push(`file the claim for ${file[0]} as ${asWho}`);
  else if (file.length) parts.push(`file ${file.length} claims (${file.join(', ')}) as ${asWho}`);
  if (write.length === 1) parts.push(`write ${write[0]}`);
  else if (write.length) parts.push(`write ${write.length} READMEs (${write.join(', ')})`);
  return parts.join(' and ');
}

export type TargetChoice = { kind: 'workspace'; names: string[] } | { kind: 'targets'; targets: ClaimTarget[] };

/** Which packages `rgstr claim [name]` is about, from the directory and the
 *  flags. A workspace root without --all is listed, not claimed. */
export async function resolveClaimTargets(dir: string, nameArg: string | undefined, opts: ClaimOpts): Promise<TargetChoice> {
  const prefer: Ecosystem | undefined = opts.pip ? 'pypi' : opts.npm ? 'npm' : undefined;
  const found = await detectPackages(dir, { prefer, all: opts.all });
  const workspaceRoot = (await workspaceGlobs(dir)).length > 0;
  // --check files nothing and writes nothing, so at a workspace root it
  // covers every member without --all.
  const choice = chooseTargets(found, workspaceRoot, { name: nameArg, all: opts.all || opts.check });
  if (choice.kind === 'workspace') return { kind: 'workspace', names: choice.names };
  let targets: ClaimTarget[] = choice.targets;
  if (nameArg && targets.length === 0) targets = [{ name: nameArg, ecosystem: prefer ?? 'npm', dir, manifest: null }];
  if (targets.length === 0) {
    throw new RgstrCliError('invalid_argument', 'No package.json / pyproject.toml / setup.cfg here — pass the name: rgstr claim <name>');
  }
  return { kind: 'targets', targets };
}

export interface ClaimPlan {
  dir: string;
  checkout: GitCheckout | null;
  asWho: string;
  targets: ClaimTarget[];
  previews: ClaimPreview[];
  /** Names a claim would be filed for. */
  toFile: string[];
  /** READMEs (relative to `dir`) a badge would be written to. */
  toWrite: string[];
  /** "file the claim for x as acme and write README.md"; empty when there is nothing to do. */
  what: string;
}

/** Everything up to the question. Reads only: nothing is filed, nothing is written. */
export async function planClaims(c: RgstrClient, say: Say, opts: ClaimOpts, input: { dir: string; targets: ClaimTarget[] }): Promise<ClaimPlan> {
  const { dir, targets } = input;
  const checkout = await gitCheckout(dir);
  const asWho = c.auth.org ?? (c.auth.kind === 'api_key' ? 'the organization your API key belongs to' : 'your organization (pick one with `rgstr org use <slug>`)');
  const list = await c.get<ClaimsList>('/api/v1/registry/claims');
  if (targets.length > 1) {
    say(`${targets.length} packages in this workspace: ${targets.map((t) => t.name).join(', ')}`);
    say('');
  }
  const previews: ClaimPreview[] = [];
  for (const t of targets) {
    if (previews.length) say('');
    previews.push(await previewOne(c, say, opts, t, list, { dir, checkout, single: targets.length === 1, asWho }));
  }
  const toFile = previews.filter((p) => !p.verified && !p.pending).map((p) => p.t.name);
  const toWrite = previews.filter((p) => p.readme?.write).map((p) => p.readme!.rel);
  return { dir, checkout, asWho, targets, previews, toFile, toWrite, what: describeApply(toFile, toWrite, asWho) };
}

export type BadgePr = Awaited<ReturnType<typeof openBadgePr>>;

/** The apply half — only ever after the user said yes to the plan. Files and
 *  writes exactly what `planClaims` showed, then says what to do next. */
export async function applyClaims(c: RgstrClient, say: Say, opts: ClaimOpts, plan: ClaimPlan): Promise<{ results: ClaimOutcome[]; pr: BadgePr | null }> {
  const { previews, checkout, dir } = plan;
  const results: ClaimOutcome[] = [];
  for (const p of previews) {
    if (results.length) say('');
    results.push(await applyOne(c, say, opts, p));
  }
  const written = results.filter((r) => r.readme && (r.readme.action === 'written' || r.readme.action === 'replaced'));
  let pr: BadgePr | null = null;
  if (written.length && checkout) {
    const names = written.map((r) => r.name);
    if (opts.pr && checkout.remote) {
      pr = await openBadgePr(
        checkout,
        written.map((r) => ({ file: path.resolve(dir, r.readme!.file), name: r.name, badge: r.readme!.line! })),
      );
      if (pr.url) say(`\nOpened ${pr.url} (branch ${pr.branch}). Merge it, then: ${names.map((n) => `rgstr claim --check ${n}`).join('; ')}`);
      else {
        say(`\nCould not open the pull request: ${pr.reason}. By hand:`);
        for (const step of nextSteps(written.map((r) => r.readme!.file), names)) say(`  ${step}`);
      }
    } else {
      say(opts.pr ? '\nNo `origin` remote here, so --pr cannot push or open the pull request. By hand:' : '\nNext:');
      for (const step of nextSteps(written.map((r) => r.readme!.file), names)) say(`  ${step}`);
    }
  } else if (written.length) {
    say('\nNext: get that README into the repository the package declares (or publish it with the package), then:');
    for (const r of written) say(`  rgstr claim --check ${r.name}`);
  }
  return { results, pr };
}

/** The --json shape of one package's plan. */
export function previewJson(c: RgstrClient, p: ClaimPreview) {
  return {
    name: p.t.name,
    ecosystem: p.t.ecosystem,
    org: c.auth.org,
    filed: false,
    ...(p.pending ?? {}),
    alreadyPending: !!p.pending,
    repoUrl: p.repoUrl,
    badge: p.pending ? planFor(c, p.pending, p.t, p.repoUrl)?.badge ?? null : null,
    agentPrompt: p.pending ? planFor(c, p.pending, p.t, p.repoUrl)?.agentPrompt ?? null : null,
    readme: p.outcome,
  };
}

/** The --json shape of one package after apply. */
export function outcomeJson(c: RgstrClient, r: ClaimOutcome) {
  return {
    name: r.name,
    ecosystem: r.ecosystem,
    org: c.auth.org,
    filed: !!r.claim && !r.alreadyPending,
    ...(r.claim ?? {}),
    alreadyPending: r.alreadyPending,
    repoUrl: r.repoUrl,
    badge: r.plan?.badge ?? null,
    agentPrompt: r.plan?.agentPrompt ?? null,
    readme: r.readme,
  };
}
