import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const branch = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'codex/apple-validation';
const api = 'https://api.github.com/repos/sdjknfgw/CampusLogin';
const authResult = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true
});
const auth = Object.fromEntries((authResult.stdout ?? '').trim().split(/\r?\n/).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
const headers = { 'User-Agent': 'CampusLogin-Apple-Validation', Accept: 'application/vnd.github+json' };
if (auth.username && auth.password) {
    headers.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
}
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
if (run.status === 'completed') for (const check of checks.check_runs) {
    try {
        const values = await get(`${api}/check-runs/${check.id}/annotations`);
        annotations.push(...values.map(a => ({ path: a.path, line: a.start_line, level: a.annotation_level, message: a.message })));
    } catch (error) { annotations.push({ level: 'warning', message: String(error) }); }
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
if (run.status === 'completed' && (process.argv.includes('--logs') || process.argv.includes('--artifacts'))) {
    const credential = spawnSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true
    });
    const fields = Object.fromEntries((credential.stdout ?? '').trim().split(/\r?\n/)
        .map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
    if (credential.status !== 0 || !fields.password) throw new Error('GitHub credentials unavailable; cannot download build logs.');
    const authorization = 'Basic ' + Buffer.from(`${fields.username}:${fields.password}`).toString('base64');
    if (process.argv.includes('--logs')) for (const job of jobs.jobs) {
        const response = await fetch(`${api}/actions/jobs/${job.id}/logs`, { headers: { ...headers, Authorization: authorization } });
        if (!response.ok) throw new Error(`Build log download HTTP ${response.status}`);
        const text = (await response.text()).replaceAll(fields.password, '[redacted]');
        fs.writeFileSync(path.join(out, `job-${job.id}.log`), text);
        console.log(text.split('\n').filter(line => /error:|warning:|Test Suite .*passed|Executed .*tests|BUILD SUCCEEDED|BUILD FAILED/.test(line)).join('\n'));
    }
    if (process.argv.includes('--artifacts')) {
        const artifacts = await get(`${api}/actions/runs/${run.id}/artifacts`);
        for (const artifact of artifacts.artifacts.filter(a => !a.expired)) {
            const response = await fetch(artifact.archive_download_url, { headers: { ...headers, Authorization: authorization } });
            if (!response.ok) throw new Error(`Artifact download HTTP ${response.status}`);
            const name = artifact.name.replace(/[^A-Za-z0-9._-]/g, '_');
            const file = path.join(out, `${name}-${run.id}.zip`);
            fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
            console.log(`Downloaded ${file}`);
        }
    }
}
