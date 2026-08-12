#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.github', 'workflows');
const files = fs.readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).sort();
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[a-f0-9]{40}$/i;
if (!files.length) throw new Error('No GitHub workflows found');

for (const name of files) {
  const file = path.join(directory, name);
  const source = fs.readFileSync(file, 'utf8');
  let document;
  try {
    document = yaml.load(source, { filename: file, json: true });
  } catch (error) {
    throw new Error(`${name} is not valid YAML: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${name} must contain one workflow mapping`);
  }
  if (!document.name || !document.on || !document.jobs || typeof document.jobs !== 'object') {
    throw new Error(`${name} is missing name, on, or jobs`);
  }
  if (!document.permissions || typeof document.permissions !== 'object' || Array.isArray(document.permissions)) {
    throw new Error(`${name} must declare explicit top-level permissions`);
  }
  for (const [jobName, job] of Object.entries(document.jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps) || job.steps.length === 0) {
      throw new Error(`${name} job ${jobName} must contain steps`);
    }
    const timeout = job['timeout-minutes'];
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
      throw new Error(`${name} job ${jobName} must set timeout-minutes from 1 to 60`);
    }
    for (const [index, step] of job.steps.entries()) {
      if (!step || typeof step !== 'object' || !step.uses) continue;
      const uses = String(step.uses);
      if (uses.startsWith('./')) continue;
      if (!PINNED_ACTION.test(uses)) {
        throw new Error(`${name} job ${jobName} step ${index + 1} must pin external action to a full commit SHA: ${uses}`);
      }
      if (/^actions\/checkout@/i.test(uses) && step.with?.['persist-credentials'] !== false) {
        throw new Error(`${name} job ${jobName} checkout must set persist-credentials: false`);
      }
    }
  }
}
console.log(`Validated ${files.length} GitHub workflows with pinned actions, bounded jobs, explicit permissions, and non-persistent checkout credentials.`);
