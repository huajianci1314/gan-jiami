Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class QCredScan {
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public ushort PartitionId;
    public IntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint acc, bool inh, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr ad, byte[] buf, long size, out long read);
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr ad, out MBI mbi, long len);

  public static string Find(long pid, string pattern, int maxLen) {
    IntPtr h = OpenProcess(0x0410, false, (uint)pid);
    if (h == IntPtr.Zero) return "";
    byte[] pat = Encoding.UTF8.GetBytes(pattern);
    IntPtr addr = IntPtr.Zero;
    string found = "";
    try {
      while (true) {
        MBI mbi;
        if (VirtualQueryEx(h, addr, out mbi, (long)Marshal.SizeOf(typeof(MBI))) == IntPtr.Zero) break;
        long region = mbi.RegionSize.ToInt64();
        if ((mbi.State == 0x1000) && (mbi.Protect & 0x100) == 0 && ((mbi.Protect & 0x6E) != 0) && region > 0 && (mbi.Type == 0x20000 || mbi.Type == 0x1000000)) {
          long off = 0;
          while (off < region) {
            long chunk = Math.Min(1L << 20, region - off);
            byte[] buf = new byte[chunk];
            long rd = 0;
            if (ReadProcessMemory(h, (IntPtr)(addr.ToInt64() + off), buf, chunk, out rd) && rd > 0) {
              int find = IndexOf(buf, rd, pat);
              if (find >= 0) {
                int start = find + pat.Length;
                int end = start;
                while (end < rd && end < start + maxLen && buf[end] != (byte)'\"') end++;
                string s = Encoding.UTF8.GetString(buf, start, end - start).Trim();
                if (s.Length > 0) { found = s; return found; }
              }
            }
            off += chunk;
          }
        }
        addr = (IntPtr)(addr.ToInt64() + region);
      }
    } finally { CloseHandle(h); }
    return found;
  }

  static int IndexOf(byte[] data, long len, byte[] pat) {
    for (long i = 0; i + pat.Length <= len; i++) {
      bool ok = true;
      for (int j = 0; j < pat.Length; j++) if (data[i + j] != pat[j]) { ok = false; break; }
      if (ok) return (int)i;
    }
    return -1;
  }
}
"@
$procs = Get-Process -Name "QQMusic" -ErrorAction SilentlyContinue
if(!$procs){ Write-Output "no QQMusic process"; exit 1 }
$pid0 = $procs[0].Id
Write-Output "PID=$pid0"
$a = [QCredScan]::Find($pid0, "`"authst`":`"", 600)
Write-Output "AUTHST=$a"
$u = [QCredScan]::Find($pid0, "`"uin`":`"", 40)
Write-Output "UIN=$u"