Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class QMemScan {
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

  public static string Find(long pid) {
    IntPtr h = OpenProcess(0x0410, false, (uint)pid);
    if (h == IntPtr.Zero) return "ERR:OpenProcess";
    byte[] pat = Encoding.ASCII.GetBytes("\"authst\":\"");
    IntPtr addr = IntPtr.Zero;
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
                while (end < rd && buf[end] != (byte)'\"') end++;
                if (end - start >= 10) return Encoding.UTF8.GetString(buf, start, end - start);
              }
            }
            off += chunk;
          }
        }
        addr = (IntPtr)(addr.ToInt64() + region);
      }
    } finally {
      CloseHandle(h);
    }
    return "NO_AUTHST";
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
if(!$procs){ Write-Output "no QQMusic process"; exit }
foreach($p in $procs){
  Write-Output "scanning QQMusic PID=$($p.Id)..."
  $tok = [QMemScan]::Find($p.Id)
  if($tok -and !$tok.StartsWith("ERR") -and $tok -ne "NO_AUTHST"){ Write-Output "AUTHST=" + $tok }
  else { Write-Output $tok }
}
