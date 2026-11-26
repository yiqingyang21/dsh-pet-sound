' DSH desktop-pet TTS autostart launcher
' Why VBS: writing powershell directly into the Run key flashes a console window;
' WScript.Shell with window style 0 starts it completely silent.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\ai\edge\edge-start.ps1""", 0, False
