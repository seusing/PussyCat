# 视频解析产品化进度

- 2026-08-12：阶段 0 开始。目标顺序为基线冻结 → 传输正确性 → 快速产物 → 备用通道 → 懒加载采集 → 证据链 → 目标×深度 → 最终优化。
- 最大风险：Python 安装包曾来自未提交工作区，必须先让源码、wheel、bundle 和安装包建立可复现关联。
- 复现 Python 基线：原结果 1345 passed、5 failed、6 skipped、2 deselected；失败均因 DesktopApplication 无条件向旧签名 `process_fn` 传 `run_started`，线程未执行实际处理。
- 修复：仅在调用方声明 `run_started` 或 `**kwargs` 时传回调，并补旧签名兼容回归测试。
- 当前闸门：Python 1350 passed、6 skipped、2 deselected；ruff 全绿；mypy 90 个源文件全绿。PussyCat 888/888 全绿。
- 审查结论：小红书浏览器会话采集、模型配置热更新、快速总结单调用链与运行进度关联存在跨文件依赖，无法拆出独立全绿的中间提交，作为一个一致基线提交。
- Python 基线提交：`caa0a22`（`feat-vk-freeze-productized-quick-analysis-baseline`），提交后工作区干净。
- Python wheel 已从干净提交 `caa0a22` 构建成功：`video_knowledge-0.1.0-py3-none-any.whl`。
- bundle/package 来源追溯已完成代码审查：构建前同时拒绝 Python 与 PussyCat 的 tracked/untracked 脏状态；runtime manifest 记录双仓 commit、`dirty=false` 与两个 lockfile SHA；package stamp 记录 runtime manifest SHA、lockfile SHA，并逐个记录和复核安装产物 SHA。兼容旧 stamp，但新 stamp 的安装包被替换或损坏时不再误判为最新。
- 正在进行：跑 PussyCat 全量闸门并提交来源追溯改造；随后从双仓干净提交生成可验证 bundle，再建立固定语料的可重复 JSONL 基准框架。
