import fs from 'node:fs';

const file = 'scripts/one-time-3.3.3.mjs';
const source = fs.readFileSync(file, 'utf8');
const before = "    this.logger(`Reusing existing local ngrok endpoint ${'${url}'} for Gateway port ${'${match.port}'}; DevMate will detach rather than terminate that pre-existing ngrok process on Stop.`);";
const after = "    this.logger('Reusing existing local ngrok endpoint ' + url + ' for Gateway port ' + match.port + '; DevMate will detach rather than terminate that pre-existing ngrok process on Stop.');";
if (!source.includes(before)) throw new Error('Expected one-time script logger anchor not found');
fs.writeFileSync(file, source.replace(before, after), 'utf8');
