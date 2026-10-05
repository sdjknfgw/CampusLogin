import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const branch = process.argv[2] ?? 'codex/apple-validation';
const api = 'https://api.github.com/repos/sdjknfgw/CampusLogin';
const headers = { 'User-Agent': 'CampusLogin-Apple-Validation', Accept: 'application/vnd.github+json' };
async function get(url) {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status} for ${url}`);
    return response.json();
}
const result = await get(`${api}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`);
const run = result.workflow_runs.find(r => r.name === 'Apple app validation');
if (!run) { console.log('No Apple validation run found.'); process.exit(0); }
const jobs = await get(`${api}/actions/runs/${run.id}/jobs`);
const checks = await get(`${api}/commits/${run.head_sha}/check-runs`);
const annotations = [];
for (const check of checks.check_runs) {
    const values = await get(`${api}/check-runs/${check.id}/annotations`);
    annotations.push(...values.map(a => ({ path: a.path, line: a.start_line, level: a.annotation_level, message: a.message })));
}
const summary = {
    id: run.id, url: run.html_url, sha: run.head_sha, status: run.status, conclusion: run.conclusion,
    jobs: jobs.jobs.map(j => ({ id: j.id, name: j.name, conclusion: j.conclusion,
        steps: j.steps.map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion })) })), annotations
};
const out = path.join(root, 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'remote-test-result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
