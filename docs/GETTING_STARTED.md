# Getting started: let ChatGPT work on your computer

[English](GETTING_STARTED.md) | [简体中文](GETTING_STARTED.zh-CN.md)

This walk-through takes you from nothing to "I say a sentence in ChatGPT on the web, and it reads my project, changes files and runs the tests". It takes about fifteen minutes. Every step says what you should see when it is done; if you see something else, stop there and go to [When you are stuck](#when-you-are-stuck).

Claude.ai is connected the same way; only the place where the address goes in step 4 is another. If all you want is Claude Code or Codex on the same computer to use DevMate, step 2 is enough: see the [README](../README.md#on-the-same-computer).

## What you need

- A computer with Windows, macOS or Linux that has your project on it.
- [Node.js](https://nodejs.org) 24 or newer and [Git](https://git-scm.com) 2.41 or newer.
- A ChatGPT or Claude account that can add a custom MCP connector. Which plans may change files and which may only read is theirs to decide: see [What your plan allows](../README.md#what-your-plan-allows).
- On Windows, PowerShell 7 is worth installing first: `winget install --id Microsoft.PowerShell --source winget`. Models join two commands with `&&` by habit, and the Windows PowerShell 5.1 that comes with the system does not know it. DevMate works with either and uses 7 when it finds it.

## Step 1: install DevMate

One way in is enough. You can add others later; they share one runtime.

- **With VS Code:** search for **DevMate** in the Extensions view and install it.
- **Command line only:** download `devmate-cli-<version>.tgz` from [Releases](https://github.com/Kukutx/DevMate/releases) and run `npm install -g ./devmate-cli-<version>.tgz`.

Then check the installation:

```powershell
devmate doctor
```

You should see a list of `[ ok ]` lines, ending with `DevMate <version>: …`. That the runtime is not running is as it should be at this point: the next step starts it. A line that says `[FAIL]` has the way to fix it under it, after `->`.

## Step 2: start it and share a project

A model reaches only the folders you share.

**With VS Code:** open the folder of your project, press `Ctrl+Shift+P` and run **DevMate: Start DevMate Runtime**. The folder is shared for reading and writing, and the window tells you so once. The status bar at the bottom shows a plug and **DevMate**.

**On the command line:**

```powershell
devmate start
devmate project add C:\Projects\MyApp
devmate project list
```

`project list` shows your project with `access` `write`. To let a model look and not change, add `--read-only` to `project add`.

Clients on the same computer can use DevMate from here on.

## Step 3: give ChatGPT a way to your computer

ChatGPT runs in the cloud, so it needs an address that reaches your computer from outside. Start with the one that needs the least, and move to one that lasts later.

| Your situation | Which route | What it is like |
| --- | --- | --- |
| Trying it out | Quick tunnel | Nothing to sign up for. **The address is new after every start**, and has to be added to ChatGPT again each time |
| ChatGPT only, with an account that can sign in to the OpenAI Platform | OpenAI's tunnel | The tunnel id never changes and no third party is in between. Only the ChatGPT of the account that made the tunnel can use it |
| For good, with a domain of your own | Cloudflare tunnel | The address never changes, and sign-in can be required. The domain's DNS has to be managed by Cloudflare |
| For good, with a server of your own | Your own relay | The address stays, and nothing of a third party is in between |

**The quick tunnel** is what the rest of this walk-through uses. Install Cloudflare's small program `cloudflared` first (`winget install Cloudflare.cloudflared` on Windows, `brew install cloudflared` on macOS), then:

```powershell
devmate connect quick
devmate restart
devmate doctor
```

In VS Code, **DevMate: Configure Connection** asks the same things one by one.

The route works when this line of the doctor is `[ ok ]`:

```
[ ok ] connection.public: https://<a name>.trycloudflare.com/mcp/<key> reaches this runtime
```

In the first seconds after a start the address may not be known everywhere yet: run `doctor` once more.

The other three routes are described in the [README, under "Connecting a client"](../README.md#chatgpt-on-the-web-and-claudeai).

## Step 4: hand the address to ChatGPT

**Copy the address first.** These three give the same one:

- VS Code: click **DevMate** in the status bar and choose **Copy MCP URL**.
- The browser extension: click the DevMate icon, then **Copy the MCP address**.
- The command line: `devmate mcp-url`.

> **Treat this address like a password.** A quick tunnel has no sign-in: the key at the end of the address is the only lock. Whoever has the whole address can read and change the projects you share and run commands on your computer. Paste it into your own ChatGPT or Claude and nowhere else: not into a chat, a screenshot or a ticket. The address `devmate doctor` shows has no key in it and is safe to paste.

**Add it in ChatGPT.** This is the page as it was in October 2026. The words on the buttons differ with the language and change over time; the places and the order are the same:

1. Open `chatgpt.com/plugins`.
2. Choose to add one, then "Add a custom MCP server".
3. Name it `DevMate`.
4. Paste the address you copied as the server's URL.
5. For authentication choose "No authentication". (With sign-in required on your route, choose OAuth: see the README.)
6. Tick the box that says you understand the risk.
7. Create the plugin, then connect it.

When it is connected, ChatGPT lists the tools DevMate offers. If you do not want to be asked for every tool, set the plugin's authorization to allow all tools in its settings; left as it is, ChatGPT asks you before it changes something.

**Add it in Claude.ai:** Settings, Connectors, add a custom connector, and paste the same address.

To see that it really connected:

```powershell
devmate doctor
```

The line `client` says which client connected last, and when.

## Step 5: the first conversation

Start a new conversation, make sure the DevMate plugin is switched on for it, and try these one at a time:

1. `Give me an overview of the project.` It calls `project_overview` and tells you the branch, what has changed, the stack and the scripts that can be run.
2. `Search the project for TODO and list the first ten.`
3. `Run the tests and tell me which ones fail.`
4. `Fix the first failing test and run them again.` Here it changes files. Every change can be taken back: tell it to "take back the last change", or look at Changes in `devmate ui --open`.
5. With DevMate's browser extension installed: `List the tabs my browser has open.`

A model sees the projects you share and no other folder. The commands it runs really run on your computer, as your own account.

## Step 6: when it wants another agent to do the work, you say yes

ChatGPT can hand a whole task to Codex or Claude Code on your computer. That runs on your account with them, so by default you are asked about every task first: ChatGPT says "the owner has to allow this task at their computer first", and the task waits. Nothing has run yet.

You answer at your computer:

- your editor shows a notification; or
- open the workbench with `devmate ui --open`, on the **Approvals** tab. It shows the task word for word, which agent and model it goes to, and lets you allow this one, allow it and not be asked again while that agent stays connected, or refuse.

Not to be asked every time: `devmate delegation allow`. To keep clients from handing tasks over at all: `devmate delegation off`. Both are run at your own computer only; a connected client cannot change them.

## Day to day

- **The runtime stays in the background.** Closing VS Code or the terminal does not stop it. To stop it: `devmate stop`.
- **After the computer was restarted, DevMate was updated or you restarted the runtime:** with a quick tunnel the address is another, and step 4 has to be done again. (In October 2026 the address of a plugin in ChatGPT could not be edited: you make a new one and uninstall the old one, renaming the old one first where its name is in the way.) That is what a quick tunnel is. Not to do it again, take one of the three routes of step 3 whose address stays.
- **Another project:** open its folder in VS Code and run **DevMate: Change Folder Sharing**, or `devmate project add <folder>`. With more than one project shared, tell the model which one you mean.
- **To see what it did:** `devmate ui --open` opens the workbench.

## Three things to know about safety

1. **The address is the key.** Without sign-in, whoever reaches the address is you.
2. **Write access means commands on your computer.** DevMate is not a sandbox. Share read-only with a client you do not fully trust.
3. **The default profile is "guarded":** sharing a folder, reading credential files such as `.env` and answering an agent's questions are done by you, at your computer. `devmate access full` hands them to the client that connects, and `devmate access guarded` takes them back at any time. With full access and no sign-in, keep the address to yourself with particular care.

The whole policy is in [SECURITY.md](../SECURITY.md).

## When you are stuck

Run `devmate doctor` first. It checks one thing after another and says under each problem, after `->`, what to do.

| What you see | What to do |
| --- | --- |
| ChatGPT reports an error when connecting, or lists no tools | See whether `connection.public` is `[ ok ]` in `devmate doctor`. If not, the address does not reach you: wait some seconds and try again, or run `devmate restart` and copy the address anew |
| It worked yesterday and ChatGPT cannot connect today | A quick tunnel, and the runtime was started again since: the address is another. Do step 4 again |
| ChatGPT can read and not change | Your plan allows custom connectors to read only, or the project is shared read-only: `devmate project list` shows `access` |
| The model says a folder is "shared by the owner on their own computer" | Share it yourself: open it in an editor that has DevMate, or run `devmate project add <folder>` |
| The model says "the owner has to allow this task at their computer first" | See step 6 |
| A command fails because `&&` is not a valid statement separator | The command ran in Windows PowerShell 5.1. Install PowerShell 7, then `devmate restart` |
| `DevMate … is still running, older than this command` | The runtime is the one from before the update: `devmate restart` |
| The browser extension cannot reach DevMate | `devmate start` first. If it still cannot, `devmate chrome` says whether the browser is registered and connected |

To report a problem, `devmate doctor --report` makes one text with credentials, paths, account names and addresses taken out. Read it once before you send it.

More: the [README](../README.md) is the full reference, and [STATUS](STATUS.md) says plainly what has been tried and what has not.
