// What the panel says for a state of the bridge, in the owner's language. Kept apart from the page so that it can be
// tested: describe() takes the state and returns plain data, nothing here touches the document or the browser.
//
// The panel answers three questions in this order: can DevMate use this browser right now; if not, what exactly is
// to be done about it; and what has it been doing here.

const TEXT = {
  en: {
    connecting: 'Connecting to DevMate…',
    missing: 'This browser cannot reach DevMate yet',
    missingSteps: ['On this computer run {install} once. It registers DevMate with this browser.', 'If you have already done that, close the browser completely and open it again.'],
    closed: 'The connection to DevMate was lost',
    closedText: 'Trying again by itself.',
    browserSaid: 'What the browser said', devmateSaid: 'What DevMate said when it was started with the browser',
    stopped: 'DevMate is not running',
    stoppedText: 'Start it here, or switch on "Start DevMate with the browser" below.',
    outdated: 'DevMate {version} is running, older than this extension',
    outdatedText: 'Restart it to use the browser from DevMate: {restart}',
    filesGone: 'DevMate {version} is running, but the files it was started from are gone',
    filesGoneText: 'It was updated or moved while it ran, and parts of it no longer work (agents, this browser). Restart it: {restart}',
    paused: 'Paused: DevMate cannot use this browser now',
    pausedText: 'Everything it asks of the browser is refused until you switch it back on.',
    ready: 'DevMate can use this browser',
    readyText: 'Bookmarks, tabs, windows, history, downloads, and pages with their console and network.',
    pending: '{count} waiting for your answer',
    debugging: 'The debugger is on {count} tab(s): DevMate is watching their console and network.', debugStop: 'Take it off',
    linkCurrent: '{count} browsers are connected. DevMate uses this one.', linkOther: '{count} browsers are connected. DevMate uses another one now.',
    prefer: 'Use this browser', preferred: 'DevMate uses this browser now.', preferredNot: 'DevMate was asked, and still uses another browser.',
    start: 'Start DevMate', again: 'Try again now', workbench: 'Open the workbench', answer: 'Answer in the workbench ({count})', copy: 'Copy the MCP address', starting: 'Starting…',
    copied: 'Copied. Whoever has this address can reach DevMate: keep it to yourself.',
    copiedTemporary: 'Copied. A temporary public address: it changes when DevMate restarts. Whoever has it can use DevMate, so keep it to yourself.',
    copiedTunnel: 'Copied the tunnel id.', copiedLocal: 'Copied. This address works on this computer only.', copiedWaiting: 'Copied the address for this computer. The public route has no address yet.',
    accessTitle: 'Let DevMate use this browser', accessText: 'Off: every request is refused. Use it when you want the browser to yourself.',
    autostartTitle: 'Start DevMate with the browser', autostartText: 'Off: the browser only joins a DevMate that is already running.',
    activityTitle: 'What DevMate did in this browser', none: 'Nothing yet.', refused: 'refused', failed: 'failed', language: '中文'
  },
  zh: {
    connecting: '正在连接 DevMate…',
    missing: '这个浏览器还连不上 DevMate',
    missingSteps: ['在这台电脑上运行一次 {install}，把 DevMate 登记给这个浏览器。', '如果已经运行过，请把浏览器完全退出再重新打开。'],
    closed: '和 DevMate 的连接断开了',
    closedText: '正在自动重连。',
    browserSaid: '浏览器的原话', devmateSaid: '随浏览器启动 DevMate 时，它的原话',
    stopped: 'DevMate 没有在运行',
    stoppedText: '可以在这里启动，或者打开下面的“随浏览器启动 DevMate”。',
    outdated: '正在运行的 DevMate {version} 比这个扩展旧',
    outdatedText: '重启后才能让 DevMate 使用浏览器：{restart}',
    filesGone: '正在运行的 DevMate {version}，启动它的那些文件已经不在了',
    filesGoneText: '它在运行期间被更新或挪走了，一部分功能已经不能用（Agent、这个浏览器）。请重启：{restart}',
    paused: '已暂停：DevMate 现在不能使用这个浏览器',
    pausedText: '在你重新打开之前，它对浏览器的所有请求都会被拒绝。',
    ready: 'DevMate 可以使用这个浏览器',
    readyText: '收藏夹、标签页、窗口、历史记录、下载，以及页面和它的控制台、网络请求。',
    pending: '有 {count} 件事在等你处理',
    debugging: '调试器正挂在 {count} 个标签页上：DevMate 在看它们的控制台和网络请求。', debugStop: '全部摘掉',
    linkCurrent: '连着 {count} 个浏览器，DevMate 现在用的是这一个。', linkOther: '连着 {count} 个浏览器，DevMate 现在用的是另一个。',
    prefer: '改用这个浏览器', preferred: 'DevMate 现在用这个浏览器了。', preferredNot: '已经告诉 DevMate 了，它现在用的仍然是另一个浏览器。',
    start: '启动 DevMate', again: '立即重试', workbench: '打开工作台', answer: '去工作台处理（{count}）', copy: '复制 MCP 地址', starting: '正在启动…',
    copied: '已复制。拿到这个地址的人就能连上 DevMate，不要外传。',
    copiedTemporary: '已复制。这是临时的公网地址，DevMate 重启后会变；拿到它的人就能使用 DevMate，不要外传。',
    copiedTunnel: '已复制隧道 ID。', copiedLocal: '已复制。这个地址只能在这台电脑上用。', copiedWaiting: '已复制本机地址。公网通路还没有拿到地址。',
    accessTitle: '允许 DevMate 使用这个浏览器', accessText: '关闭后所有请求都会被拒绝。想自己用浏览器时可以关掉。',
    autostartTitle: '随浏览器启动 DevMate', autostartText: '关闭时，浏览器只会加入已经在运行的 DevMate。',
    activityTitle: 'DevMate 在这个浏览器里做过的事', none: '还没有。', refused: '已拒绝', failed: '失败', language: 'English'
  }
};

export const LANGUAGES = Object.keys(TEXT);
/** The language of the panel: the one the owner chose, else Chinese for a Chinese browser, else English. */
export const languageFor = (chosen, browserLanguage = '') => LANGUAGES.includes(chosen) ? chosen : /^zh\b/i.test(browserLanguage) ? 'zh' : 'en';
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (whole, key) => key in values ? String(values[key]) : whole);

/**
 * How the panel looks for a state. level: 'good' | 'wait' | 'bad'. steps and text may hold {install} and {restart},
 * which the page shows as commands. primary: the one action offered first, or null. said: words that are not the
 * panel's own, with saidBy ('browser' | 'devmate') for whose they are. link: where several browsers are connected,
 * which of them DevMate uses, and whether this one can be made the one (a paused browser is not offered that: being
 * chosen lifts no pause).
 */
export function describe(state, language = 'en') {
  const t = TEXT[language] || TEXT.en, runtime = state.runtime, running = runtime?.running === true;
  const labels = { start: t.start, again: t.again, workbench: state.pending > 0 ? fill(t.answer, { count: state.pending }) : t.workbench, copy: t.copy, debugStop: t.debugStop, prefer: t.prefer };
  const several = state.host === 'connected' && running && state.link?.browsers > 1;
  const link = several ? { text: fill(state.link.current ? t.linkCurrent : t.linkOther, { count: state.link.browsers }), canPrefer: !state.link.current && !state.paused } : null;
  // A debugger on a tab is said whatever else is the matter: it is the owner's to take off.
  const shared = { labels, canOpen: running && state.host === 'connected', said: null, saidBy: 'browser', link, steps: null, text: '', primary: null, texts: t, debugging: state.debugging > 0 ? fill(t.debugging, { count: state.debugging }) : null };
  if (state.host === 'connecting') return { ...shared, level: 'wait', status: t.connecting };
  if (state.host === 'missing') return { ...shared, level: 'bad', status: t.missing, steps: t.missingSteps, said: state.said, primary: 'again' };
  // A connection that drops once comes back by itself; after a few tries it is a problem to show.
  if (state.host !== 'connected') return { ...shared, level: state.attempts > 2 ? 'bad' : 'wait', status: t.closed, text: t.closedText, said: state.said, primary: 'again' };
  // (A start that did not work is shown with what DevMate said of it: the switch tried it with nobody watching.)
  if (!running) return { ...shared, level: state.startSaid ? 'bad' : 'wait', status: t.stopped, text: t.stoppedText, primary: 'start', ...(state.startSaid ? { said: state.startSaid, saidBy: 'devmate' } : {}) };
  if (runtime.outdated) return { ...shared, level: 'wait', status: fill(t.outdated, { version: runtime.version || '' }), text: t.outdatedText };
  // A runtime whose own files were removed under it (an update of the entry that started it) answers, and fails in
  // ways nobody can read off: it says so itself, and the panel says it before anything else about a running DevMate.
  if (runtime.filesGone === true) return { ...shared, level: 'bad', status: fill(t.filesGone, { version: runtime.version || '' }), text: t.filesGoneText };
  if (state.paused) return { ...shared, level: 'wait', status: t.paused, text: t.pausedText };
  return { ...shared, level: 'good', status: t.ready, text: state.pending > 0 ? fill(t.pending, { count: state.pending }) : t.readyText };
}

/** What to say once the address is on the clipboard: how far it reaches, and that a public one is to be kept. */
export function copiedNote(result, language = 'en') {
  const t = TEXT[language] || TEXT.en;
  if (result?.scope === 'local') return result.waiting ? t.copiedWaiting : t.copiedLocal;
  return result?.scope === 'tunnel' ? t.copiedTunnel : result?.temporary ? t.copiedTemporary : t.copied;
}

/** One line of what DevMate did: the time of day, what, and how it went. */
export function activityLine(entry, language = 'en') {
  const t = TEXT[language] || TEXT.en, at = new Date(entry.at);
  return { time: String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0'), name: entry.method, change: entry.read !== true,
    failed: entry.ok !== true, mark: entry.ok === true ? '✓' : entry.code === 'paused' ? t.refused : t.failed + (entry.code ? ' · ' + entry.code : '') };
}
