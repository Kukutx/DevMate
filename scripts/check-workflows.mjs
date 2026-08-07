#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.github', 'workflows');
const files = fs.readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).sort();
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
  for (const [jobName, job] of Object.entries(document.jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps) || job.steps.length === 0) {
      throw new Error(`${name} job ${jobName} must contain steps`);
    }
  }
}
console.log(`Validated ${files.length} GitHub workflows.`);
