// RoadLedger.exe — 도로대장 시스템 실행 파일(아이콘이 들어 있는 작은 시작 프로그램).
// 하는 일: 같은 폴더의 scripts\launcher.ps1(실행 관리 창)을 콘솔 창 없이 띄우고, 창이 닫힐 때까지 기다린다.
//          같은 폴더에서 두 번 실행되지 않도록 막는다. (C# 5 / .NET Framework 4 — Windows 10·11 에 기본 포함)
// 빌드: local-portable\build-package.ps1 이 csc.exe 로 컴파일한다(/win32icon:assets\app.ico).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("도로대장 시스템")]
[assembly: AssemblyDescription("도로대장 시스템 실행 프로그램")]
[assembly: AssemblyProduct("도로대장 시스템 (Road Ledger System)")]
[assembly: AssemblyCompany("")]
[assembly: AssemblyCopyright("")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string AppName = "도로대장 시스템";

    [STAThread]
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(dir, "scripts", "launcher.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show("프로그램 파일이 없습니다.\n압축을 끝까지 풀었는지, 보안 프로그램이 파일을 지우지 않았는지 확인하세요.\n\n" + script,
                AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // 폴더마다 하나만 실행(경로를 해시한 이름의 뮤텍스)
        string id;
        using (SHA1 sha = SHA1.Create())
            id = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(dir.ToLowerInvariant()))).Replace("-", "");
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\RoadLedger-" + id, out created))
        {
            if (!created)
            {
                MessageBox.Show("도로대장 시스템이 이미 실행 중입니다.\n작업 표시줄에서 열려 있는 창을 확인하세요.",
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -STA -File \"" + script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = dir;
            try
            {
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                    return p.ExitCode;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("실행하지 못했습니다.\n" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
