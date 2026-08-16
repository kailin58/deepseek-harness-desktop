import os
from win32com.shell import shell, shellcon
from win32com.client import Dispatch

desktop = shell.SHGetFolderPath(0, shellcon.CSIDL_DESKTOP, None, 0)
lnk = os.path.join(desktop, "DeepSeek Harness.lnk")
sl = Dispatch("WScript.Shell").CreateShortcut(lnk)
sl.TargetPath = r"E:\deepseek-harness-desktop\launch.vbs"
sl.WorkingDirectory = r"E:\deepseek-harness-desktop"
sl.IconLocation = r"E:\deepseek-harness-desktop\app-icon.ico,0"
sl.Description = "DeepSeek Harness 桌面版"
sl.Save()
print("OK created:", lnk)
