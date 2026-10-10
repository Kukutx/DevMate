## One runtime for this computer

DevMate is a small local service. The editor starts it; every VS Code window, Obsidian and the `devmate` command line then share that one runtime.

- It listens on `127.0.0.1` only.
- It **keeps running after you close the editor**, until you stop it with **DevMate: Stop DevMate Runtime**.
- It needs Node.js 24 or newer on this computer. If it is not found, set its path in the setting `devMate.nodeCommandPath`.

The status bar shows whether it runs. Click the DevMate item there for the everyday actions.
