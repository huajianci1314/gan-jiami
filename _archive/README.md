# _archive

调研阶段留下的一次性脚本，均不在生产路径上，保留仅供查阅。

| 文件 | 当时的用途 |
| --- | --- |
| `gh.js` `gh2.js` | 用 GitHub API 定位上游仓库里的算法源文件 |
| `dl.js` | 下载上游参考实现的安装包 |
| `auth.js` `authscan.js` `memscan.ps1` | 早期尝试从 QQ 音乐本地文件与进程内存里捞登录凭证，方案已被 `native/qkeycred.exe` 取代 |
| `getekey.js` | GetEVkey 接口的独立调试脚本，凭证已改为环境变量读取，正式实现见 `decryptor/ekey_fetch.js` |
| `_tools/` | Python 侧的产物校验脚本（FLAC 帧结构、soundfile 解码验证） |
| `test/qmc_test.js` | 早期 QMC2 算法自测，已被 `tests/selftest.js` 取代并完整覆盖 |

根目录的生产路径只依赖 `server.js`、`cli.js`、`decryptor/`、`lib/`、`native/`、`public/`、`tests/`。
