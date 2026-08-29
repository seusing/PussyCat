# CLAUDE.md — opencli-app-clone

## 打包：改完就打，不等人问

**这是桌面应用，验证完整功能只能重装。** 用户拿到一个陈旧安装包的代价是「装完发现改动没生效」，
再来回一轮——已经真实发生过两次。

**规则：每落下一批面向用户可见的提交后，直接跑打包，不必等用户开口。**

```bash
npm run package
```

它自己会判断要不要构建：源码身份（本仓 `HEAD` + 工作区脏否 **+ Python 引擎仓的 `HEAD`**）
与上次打包记录一致就秒退，不做无谓构建。
所以「多跑一次」的成本接近零，**漏跑一次的成本才是真的**。

想先问一句要不要打包，用 `npm run package:check`（不构建，退出码 0=已最新 / 1=需打包）。

**改了 Python 引擎（video-knowledge）就得先重建 bundle**，`npm run package` 不会代劳，
但会拦住你并把命令打出来：

```bash
node scripts/build-vk-bundle.mjs
```

然后再 `npm run package`。之所以不代跑：`build-vk-bundle` 会先 `rm` 掉整个
`src-tauri/resources/vk/` 再重建，uv 不可用或 Python 仓是脏的时候，代跑会让你连原先那份
能用的 bundle 都没了。

### 这个脚本挡住的五件事（都真踩过，别绕开它直接 `npm run tauri build`）

1. **管道会吞掉退出码。** `npm run tauri build | tail` 的退出码是 `tail` 的 0——MSI 打包失败
   被当成功报给用户过一次。脚本用 `spawnSync` 直接取 status。
2. **构建失败时旧产物还在**，目录看起来跟成功一模一样。脚本记录构建起点，
   产物 mtime 必须新于它，否则判失败。
3. **改过名的历代产物会并存**（`OpenCLI App Clone` → `抓抓` → `爪爪`）。脚本只留当前
   `productName` 那一份，其余清掉，免得用户拿错。
4. **`version` 恒为 `0.1.0`，不随提交递增**，无法靠版本号判断新旧。脚本把 commit 与时刻写进
   `.package-stamp.json`（gitignored），并在报告里打出来。
5. **Python 引擎在另一个仓库**，它的提交不会让本仓变脏（`src-tauri/resources/vk/` 还是
   gitignored 的），所以只改 Python 时 `package:check` 会说「已是最新」直接跳过，
   装出来的包里还是旧 wheel。`--force` 也救不了——脚本从不重建 bundle，只会把
   `resources/vk/` 里现成的 wheel 原样装进去。脚本把 Python 仓 `HEAD` 折进源码身份，
   并在 bundle manifest 与 Python 源码对不上时**拒绝打包**（`--force` 也拦）。

### 报给用户时必须带上

安装包**绝对路径** + 它对应的 commit。不要只说「打好了」——用户没法从版本号分辨新旧。
若 stamp 里 source 带 `-dirty`，要明说这个包不对应任何一个提交。

### 已知前提

- 改 `productName` 会改变安装目录与安装包文件名，用户机器上会**并存新旧两个应用**，
  旧的需手动卸载——每次改名都要提醒。
- 中文 `productName` 需要 `bundle.windows.wix.language: ["zh-CN"]`，
  否则 WiX 的 `light.exe` 会因 en-US 代码页表示不了中文而失败（NSIS 走 UTF-8 不受影响）。
