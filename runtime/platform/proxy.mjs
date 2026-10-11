import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';

// What the runtime itself asks of the outside (OpenAI's tunnel service, the check of its own public route, a
// signing-in client's metadata document, an external MCP server) goes through the proxy this computer is set to
// use: the HTTPS_PROXY, HTTP_PROXY and NO_PROXY variables, or on Windows, when those are absent, the system proxy
// of the owner's account, which a tool such as Clash switches on and off. Node's own proxy support does the work.
// What is asked of this computer itself never goes through a proxy.
const LOCAL = ['localhost', '127.0.0.1', '::1'];
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const variable = (env, name) => env[name.toLowerCase()] || env[name] || '';
const withScheme = value => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value;
// How a proxy is shown to a person: where it is, never the credentials in its address.
export function shownProxy(value) {
  try { const url = new URL(withScheme(value)); return url.protocol + '//' + url.host; } catch { return '(unreadable address)'; }
}

export function environmentProxy(env = process.env) {
  const https = variable(env, 'HTTPS_PROXY') || variable(env, 'ALL_PROXY'), plain = variable(env, 'HTTP_PROXY') || variable(env, 'ALL_PROXY');
  if (!https && !plain) return null;
  return { source: 'environment', https: https || plain, http: plain || https, bypass: variable(env, 'NO_PROXY').split(',').map(item => item.trim()).filter(Boolean) };
}

function registryValues(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}
// Asked of the system's own program, and never in a way that holds this process up while it answers.
function readInternetSettings() {
  return new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', INTERNET_SETTINGS],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (failure, stdout) => failure ? reject(failure) : resolve(stdout)));
}
// "localhost;127.*;10.*;*.corp.example;<local>" as Windows writes it, in the form NO_PROXY takes.
function bypassList(value) {
  return String(value || '').split(';').map(item => item.trim()).filter(item => item && item !== '<local>').map(item => {
    const octets = /^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/.exec(item)?.[1].split('.');
    if (!octets) return item;
    return [...octets, ...Array(4 - octets.length).fill('0')].join('.') + '-' + [...octets, ...Array(4 - octets.length).fill('255')].join('.');
  });
}
/** The system proxy of the owner's Windows account, or null when none is switched on. */
export async function windowsSystemProxy(read = readInternetSettings) {
  let values;
  try { values = registryValues(await read()); } catch { return null; }
  // A proxy script decides per address and would have to be run; that is not done here.
  if (parseInt(values.ProxyEnable, 16) !== 1 || !values.ProxyServer) return values.AutoConfigURL ? { source: 'system', script: true } : null;
  // Either one address for everything, or "http=host:port;https=host:port;socks=host:port".
  const each = Object.fromEntries(values.ProxyServer.split(';').map(item => item.trim()).filter(Boolean).map(item => item.includes('=') ? item.split('=', 2) : ['*', item]));
  const https = each['*'] || each.https || each.http, plain = each['*'] || each.http || each.https;
  if (!https) return { source: 'system', unsupported: 'only a SOCKS proxy is set' };
  return { source: 'system', https: withScheme(https), http: withScheme(plain), bypass: bypassList(values.ProxyOverride) };
}

// Node sends its own requests through a proxy from 24.14 on (http.setGlobalProxyFromEnv). An earlier 24 runs
// everything else; with a proxy set it is said to be too old for this, not failed.
const builtIn = typeof http.setGlobalProxyFromEnv === 'function' ? settings => http.setGlobalProxyFromEnv(settings) : null;

/**
 * Keeps the process on the proxy the computer is set to use. refresh() looks (again: the system proxy is switched
 * while the runtime runs) and resolves to whether anything changed; current() says what is in force. Nothing is in
 * force before the first refresh().
 */
export function createOutboundProxy({ env = process.env, platform = process.platform, system = windowsSystemProxy, apply = builtIn } = {}) {
  // Nothing is in force at first, so finding no proxy on the first look is no change.
  const NOTHING = JSON.stringify([null, undefined, null]);
  let restore = null, current = null, applied = NOTHING, looking = null;
  async function look() {
    const found = environmentProxy(env) || (platform === 'win32' ? await system() : null);
    const wanted = found?.https ? { HTTPS_PROXY: found.https, HTTP_PROXY: found.http, NO_PROXY: [...new Set([...LOCAL, ...found.bypass])].join(',') } : null;
    const settings = apply ? wanted : null;
    const unsupported = found?.unsupported || (wanted && !apply ? 'Node.js ' + process.versions.node + ' cannot send its own requests through a proxy; that takes Node.js 24.14 or newer' : null);
    const key = JSON.stringify([settings, found?.script, unsupported]);
    if (key === applied) return false;
    restore?.(); restore = null;
    if (settings) restore = apply(settings);
    applied = key;
    current = found ? { source: found.source, ...(settings ? { proxy: shownProxy(found.https), settings } : {}), ...(found.script ? { script: true } : {}), ...(unsupported ? { unsupported } : {}) } : null;
    return true;
  }
  // One look at a time: a second request while the system is being asked waits for that answer.
  const refresh = () => looking ||= look().finally(() => { looking = null; });
  return { refresh, current: () => current, stop() { restore?.(); restore = null; applied = NOTHING; current = null; } };
}
