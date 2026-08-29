using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

// 内嵌在解密程序内的 QQ音乐 凭证提取器
// 扫描 QQMusic 进程内存中的 authst 与 uin，输出到 stdout，供解密程序直接调用
static class QKeyCred {
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

    const long CHUNK = 1L << 20;
    const long OVERLAP = 800;

    static string Find(IntPtr h, byte[] pat, int maxLen) {
        IntPtr addr = IntPtr.Zero;
        while (true) {
            MBI mbi;
            long mbiSize = Marshal.SizeOf(typeof(MBI));
            if (VirtualQueryEx(h, addr, out mbi, mbiSize) == IntPtr.Zero) break;
            long region = mbi.RegionSize.ToInt64();
            bool readable = (mbi.State == 0x1000) // MEM_COMMIT
                            && (mbi.Protect & 0x100) == 0
                            && (mbi.Protect & 0x02) != 0 // PAGE_READABLE-ish (READ/WRITE/COPY)
                            && (mbi.Protect & 0x6E) != 0;
            if (readable && region > 0 && (mbi.Type == 0x20000 || mbi.Type == 0x1000000)) {
                long off = 0;
                byte[] buf = new byte[CHUNK];
                while (off < region) {
                    long size = Math.Min(CHUNK, region - off);
                    long rd = 0;
                    if (ReadProcessMemory(h, (IntPtr)(addr.ToInt64() + off), buf, size, out rd) && rd > 0) {
                        int findPos = IndexOf(buf, rd, pat);
                        if (findPos >= 0) {
                            int start = (int)(findPos + pat.Length);
                            int end = start;
                            while (end < rd && end < start + maxLen && buf[end] != (byte)'"') end++;
                            string s = Encoding.UTF8.GetString(buf, start, end - start);
                            if (s.Length > 0) return s;
                        }
                    }
                    off += size - OVERLAP;
                }
            }
            addr = (IntPtr)(addr.ToInt64() + region);
        }
        return "";
    }

    static int IndexOf(byte[] data, long len, byte[] pat) {
        long n = len - pat.Length + 1;
        for (long i = 0; i < n; i++) {
            bool ok = true;
            for (int j = 0; j < pat.Length; j++)
                if (data[i + j] != pat[j]) { ok = false; break; }
            if (ok) return (int)i;
        }
        return -1;
    }

    static int Main() {
        Process[] ps = Process.GetProcessesByName("QQMusic");
        if (ps.Length == 0) { Console.Error.WriteLine("no QQMusic process"); return 1; }
        int pid = ps[0].Id;
        IntPtr h = OpenProcess(0x0410, false, (uint)pid);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("OpenProcess failed"); return 1; }
        byte[] authPat = Encoding.UTF8.GetBytes("\"authst\":\"");
        byte[] uinPat = Encoding.UTF8.GetBytes("\"uin\":\"");
        string authst = Find(h, authPat, 700);
        string uin = Find(h, uinPat, 40);
        CloseHandle(h);
        if (string.IsNullOrEmpty(authst)) { Console.Error.WriteLine("authst not found"); return 1; }
        Console.WriteLine("AUTHST=" + authst);
        Console.WriteLine("UIN=" + uin);
        return 0;
    }
}