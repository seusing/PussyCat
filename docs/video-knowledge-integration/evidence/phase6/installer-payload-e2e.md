# phase6 · 安装包载荷 E2E(2026-08-01,零登记路线)

构建:`npm run package`(门:tsc→vitest→check:legacy→tauri build)于源码
`d78eb39`,产出 NSIS + MSI 双包(哈希见 installer-hashes.txt):

- `爪爪_0.1.0_x64-setup.exe` sha256 `dd4a490071ac4fcf63628c53a7efc98e974338fdd2f22b137c18622772fabafb`
- `爪爪_0.1.0_x64_zh-CN.msi` sha256 `f873a7d68e620c2c77b5ab2d6f2cde825fa7369b135acd1037e2b3a3b6216844`

验证走**零登记路线**(不写注册表、不触碰用户既有安装登记,遵守
「安装目录只读 / 直接修改已安装目录文件数=0」):

1. `msiexec /a <msi> /qn TARGETDIR=<空目录>` 管理映像抽取 → exit 0;
   拓扑 `PFiles\爪爪\{opencli-app-clone.exe, opencli_app_lib.dll, host\…}`。
2. vk 载荷断言:`host\server\{vk-sidecar.mjs, vk-job-shadow.mjs, index.mjs,
   host-server.mjs}` 全部在包内(missing=[])。
3. 启动抽出的 exe(无预存进程冲突):`app pid=30812 alive=True;
   node children=1 [48532]` —— 安装载荷即可启动爪爪并拉起 Node Host。
4. `taskkill /T /F` 收树后 orphan node=0。
5. 抽取目录事后删除;用户真实安装 `C:\Users\Lauseusing\AppData\Local\爪爪`
   全程未读未写。

带注册表的完整安装/卸载周期(含卸载后 `%LOCALAPPDATA%\爪爪-data` 保留矩阵)
涉及用户机器登记状态,列 BLOCKED(附命令)。
