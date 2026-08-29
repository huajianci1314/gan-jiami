# HANDOFF 交接文档

## 项目概述

本地音乐加密音频解锁工具。零依赖 Node.js 后端加单页前端，入口 `server.js`，默认监听 `http://localhost:8787`。上传走 `/api/decrypt`（`X-Filename` 头带原文件名，请求体为原始字节），产物经 JOBS 表由 `/api/audio?id=&dl=1` 流式下载，多产物可经 `/api/zip?ids=` 打包。命令行入口 `cli.js` 仅覆盖 ncm 与传统 mflac。

## 支持格式

| 格式 | 来源 | 钥匙来源 | 实现 |
| --- | --- | --- | --- |
| `.ncm` | 网易云 | 文件内置 | decryptor/ncm.js，含封面提取 |
| `.qmcflac` `.qmc0~8` `.tkm` `.bkc*` 及十六进制伪装名 | QQ 音乐 v1 | 内置静态密钥表 | decryptor/qmc.js |
| `.mflac` `.mgg*` `.mmp4` | QQ 音乐 v2 | 尾包内嵌，或本机客户端自动取，或手动补录 | decryptor/qmc.js 加 ekey_fetch.js |
| `.kwm` | 酷我 | 从密文自身恢复 | decryptor/kwm.js |
| `.kgma` | 酷狗 | 内置 70MB 公钥表 | decryptor/kugou.js |
| `.kgg` | 酷狗 | 本机密钥库 KGMusicV3.db | decryptor/kugou.js 加 native/kgg-dec |

判型顺序在 server.js 里：酷狗魔数 → `.kwm` 扩展名 → `CTENFDAM` 魔数 → QMC 统一探测（v1 扩展名 → 尾包 → 静态密钥试解兜底）。

## 硬约束（改动前必读）

1. kgg-dec v0.6.1 的参数解析要求以 `--` 分隔选项区与文件区，缺了它一律打印 Usage 拒绝工作。唯一可行形态是 `--db <db> -- <file>`。
2. kgg 产物名等于输入名加 `_kgg-dec` 后缀，落在输入所在目录。服务端因此每次在 TMP 下开独立 `kggrun-*` 目录，输入改名 `in.kgg` 后执行，目录内除输入外唯一文件即产物。
3. kgg 曲目必须在本机酷狗客户端完整播放过至少一次，密钥才会写入 `%AppData%\Kugou8\KGMusicV3.db`。
4. 换机器部署需重新放置 `native/kugou/kugou_key.bin` 与 `native/kgg-dec/kgg-dec.exe`，且 kgg 曲目要在那台机器重新播放一次。
5. 解密算法移植自 Rust。凡是 f64 转整数的位置，都必须复刻 Rust 1.45 起的饱和转换语义（NaN 转 0，越过上界转 u32::MAX）。`calcSegmentKey` 曾在这里翻车，随机密钥实测分叉率 1.3%。
6. KGMA 的掩码变换加解密不是同一个式子。xs 是对合的（xs(xs(x)) === x），解密式 `p = xs(k ^ c) ^ msk` 反解出加密式 `c = k ^ xs(p ^ msk)`。构造测试样本时若误用解密函数当加密，往返必然失败。

## 当前状态

`node tests/selftest.js` 12 个用例全过。HTTP 端到端冒烟 11 项全过（解密、下载、封面、打包、413、404、垃圾输入）。

## 已完成的改动

### 算法正确性

- `decryptor/qmc.js`，`calcSegmentKey` 补上 f64 转 u32 的饱和语义。原实现只做 `Math.trunc`，密钥字节为 0 时除零得 Infinity 使异或退化为空操作，结果越过 u32 上界时又与 Rust 取到不同的索引，两类都会让 RC4 输出错乱。实测 38.4 万次调用的分叉率从 1.3% 降到 0。
- `tests/selftest.js`，用例 9 的密文由文件内 `refRc4Xor` 按 Rust 语义生成。对称算法用被测代码加解密时错误会相互抵消，往返恒过，必须靠独立参考实现才能暴露分叉。该用例修复前失败、修复后通过，已双向验证。

### 资源与健壮性

- `server.js`，任务加 `createdAt` 与 TTL 回收（默认 2 小时，10 分钟扫一次），`kggrun-*` 运行目录一并回收。
- `server.js`，单文件 512MB 上传上限，Content-Length 预检加 `readBodyToFile` 流式兜底。
- `server.js`，退出清理加启动时回收陈旧 `vip-unlock-*` 目录。Windows 强杀进程时 SIGTERM 不可靠，退出清理会失效。
- `server.js`，catch 块回收上传临时文件。此前解密失败时上传文件无人消费，会一直堆在 TMP 直到进程退出。
- 四条流式管线（qmc v1/v2、ncm、kwm、kugou）在任一侧出错时销毁整条链路，避免留下未关闭的 fd。
- `decryptor/kugou.js`，KGMA 由整文件入内存改为 4MB 分块流式写盘。实测 30MB 与 90MB 样本的峰值 RSS 均为 137.8MB，内存占用已与文件大小脱钩；改造前 30MB 样本为 165.4MB。

### 凭证安全

- `decryptor/ekey_fetch.js` 删除内嵌真实 authst/uin 的 `BOOTSTRAP`，三条路径都取不到时返回 null，由上层转手动补录。
- `ekeycache.json` 清空。`getekey.js` 的凭证改为环境变量读取。
- 新增 `QQ_MUSIC_AUTHST` / `QQ_MUSIC_UIN` 环境变量注入，便于在无客户端环境使用。
- `fetchEkey` 全程吞异常返回 null。取钥是可选增强，一次网络抖动不应让整次解密变成 500。

### 清理

- 删除死代码 `readUtf16leAscii`。
- 遗留调研脚本与旧测试移入 `_archive/`（含说明文档），未删除，保持可逆。
- `npm test` 由废弃的 `test/qmc_test.js` 改指 `tests/selftest.js`。

### 测试覆盖

用例从 8 个扩到 12 个，新增：RC4 段密钥边界、EncV2 双阶段取钥、ncm 密钥盒与封面提取、KGMA 流式跨块一致性。

## 待办

1. 真实文件回归。selftest 全是合成样本，真实 `.mflac`(QTag) 与 `.kwm` 的端到端回归仍缺，需要真文件才能补。
2. 解密成功但格式识别为 bin 时，产物 `out_xxx.bin` 会残留到 TTL 到期才回收，可在抛错前主动删除。
3. `ekeycred.ps1` 与 `native/QKeyCred.cs` 靠扫描 QQ 音乐进程内存取凭证，在部分环境可能被安全软件拦截，届时需改为读本地凭据文件或引导用户手动粘贴。

## 已排除的路线

- npm 上的 `@jixun/kugou-crypto` 不存在于公开仓库，CDN 均 404。
- ghtz08 仓库根路径没有 `decoder.rs`，真实路径是 `src/decoder/kugou.rs`，用 GitHub `git/trees?recursive=1` API 定位最快。
- WebFetch 直接猜 GitHub raw 路径（main 与 master 两种分支）均 404。
