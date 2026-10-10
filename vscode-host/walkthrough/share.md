## You decide what is shared, here

A trusted folder you open is shared with connected AI clients, **read and write** by default. The window says so once.

| Sharing | A connected client can |
| --- | --- |
| Read and write | read, search and change files, and **run commands** |
| Read only | read and search, nothing else |
| Not shared | not reach the folder at all |

- Change any folder with **DevMate: Change Folder Sharing**, or the default with the setting `devMate.shareFolders`.
- A client can make sharing narrower. It can never widen it or share another folder: that is done at this computer only.
- Commands run as your own account. For a client you do not fully trust, share read only.
- If you drive your work from a chat client and do not want to come back to this computer for such decisions, **DevMate: Change Permission Profile** hands them to your connected client (*full access*): it then shares folders and reads credential files itself, and what an agent you delegated to asks permission for is granted automatically.
