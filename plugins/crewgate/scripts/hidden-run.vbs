' Starts a program with no window and does not wait for it. Used by lib/hooks/sessionjob.js:
'   wscript.exe //B //Nologo hidden-run.vbs <program> <args...>
' The command line is rebuilt from the arguments, each one quoted (the caller refuses arguments that contain a quote).
Dim line, i
line = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then line = line & " "
  line = line & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
CreateObject("WScript.Shell").Run line, 0, False
