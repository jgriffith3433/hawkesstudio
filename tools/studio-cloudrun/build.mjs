#!/usr/bin/env node
// Builds Hawkes Studio's Cloud Run image (server/studio-cloudrun/) with Cloud Build into Artifact Registry
// (docs/studio-cloudrun.md). The context is `git archive` of one commit (HEAD by default), never the working folder, so
// .env, .data, deploy/.keys and reports can't get in, and the tag is the commit: the same commit never builds twice. The
// same image is the service `studio` and the job `studio-agent`.
//
//   node tools/studio-cloudrun/build.mjs [--project hawkes-staging] [--region us-east4] [--commit HEAD] [--apply]
//
// Without --apply it prints what it would do. About 5 minutes on Cloud Build's default machine (a few cents).
// The tag goes to .data/cloudrun/studio-image.json for deploy.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { flag, gcloud, gcloudQuery, die, ROOT, APPLY } from './common.mjs';

const project = flag('project', 'hawkes-staging');
const region = flag('region', 'us-east4');
const repo = flag('repository', 'hawkes');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

const commit = git('rev-parse', flag('commit', 'HEAD'));
const short = commit.slice(0, 12);
const tag = `${region}-docker.pkg.dev/${project}/${repo}/studio:${short}`;
const dirty = git('status', '--porcelain', '--untracked-files=no');
console.log(`Studio image ${tag}\n  commit ${commit}${dirty ? '\n  (the working folder has uncommitted changes: they are NOT in the image; commit first to include them)' : ''}`);

if (!gcloudQuery(['artifacts', 'repositories', 'describe', repo, `--project=${project}`, `--location=${region}`, '--format=value(name)'])) {
  gcloud(['artifacts', 'repositories', 'create', repo, '--repository-format=docker', `--location=${region}`, `--project=${project}`, '--description=Hawkes images', '--format=none']);
}
const have = gcloudQuery(['artifacts', 'docker', 'images', 'describe', tag, `--project=${project}`, '--format=value(image_summary.digest)']);
const save = (built) => {
  const f = path.join(ROOT, '.data', 'cloudrun', 'studio-image.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ tag, commit, project, region, built }, null, 2));
};
if (have) {
  console.log(`\nThat commit is already built (${have}); nothing to do.`);
  save('existing');
  process.exit(0);
}

// The context: the commit's files, with the Dockerfile at the top (Cloud Build's --tag wants it there).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `studio-build-${short}-`));
const tar = path.join(dir, '..', `studio-${short}.tar`);
execFileSync('git', ['-C', ROOT, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', '-o', tar, commit]);
// Relative paths: Git for Windows' tar reads "C:" as a remote host.
execFileSync('tar', ['-xf', `../${path.basename(tar)}`], { cwd: dir });
fs.rmSync(tar, { force: true });
for (const f of ['.env', '.data', 'deploy/.keys']) if (fs.existsSync(path.join(dir, f))) die(`${f} is in the commit's files: refusing to build`);
fs.copyFileSync(path.join(dir, 'server', 'studio-cloudrun', 'Dockerfile'), path.join(dir, 'Dockerfile'));
console.log(`\nBuild context: ${dir}`);

gcloud(['builds', 'submit', dir, `--project=${project}`, `--region=${region}`, `--tag=${tag}`, '--timeout=1800s']);
fs.rmSync(dir, { recursive: true, force: true });
if (!APPLY) {
  console.log('\nDry run: nothing built. Add --apply to build.');
  process.exit(0);
}
save(new Date().toISOString());
console.log(`\nBuilt ${tag}. Next (J): powershell -ExecutionPolicy Bypass -File tools\\studio-cloudrun\\deploy.ps1`);
