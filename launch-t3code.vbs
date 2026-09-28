' Launches the team's from-source T3 Code desktop app with no console window.
Dim sh, fs
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "apps\desktop")
' 0 = hidden window for the node parent, False = do not wait. The app window shows normally.
sh.Run """C:\Program Files\nodejs\node.exe"" ""scripts\start-electron.mjs""", 0, False
