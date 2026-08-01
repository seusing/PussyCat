# phase4 浏览器真机验证(2026-08-01)

环境:vite dev(`--mode node`,http://localhost:5183)+ 真 Node Host(43117,
env 注入 OPENCLI_HOST_VK_PYTHON/VK_ROOT 指向 vk 仓 .venv 与 scratch 数据根)+
按需真实拉起的 Python sidecar。

逐项(get_page_text / read_page 实录):

1. 顶部导航出现第三项「视频解析」,点击切换到整页模块。
2. 健康条:sidecar 因首个 /vk/v1 请求按需真实拉起(先显示「sidecar 启动中」),
   重新检测后显示 **「video-knowledge sidecar 就绪(api 1.2.0)」** —— 真 Python
   进程、真握手、真版本。
3. 表单控件齐备:URL、preset(4)、内容类型(auto+6)、媒体策略(4)、质量档(3)、
   预算档位(3)、费用硬上限、capabilities(4)+ Audit、预检/提交解析。
4. 真实预检(React→Node 白名单代理→真 Python 引擎):输入
   https://www.bilibili.com/video/BV1demo + 上限 2.5,「预检」返回引擎解析的
   完整请求投影 —— preset=quick-summary、内容类型=auto、媒体策略=audio_transcript、
   质量=fast、预算档=economy;输出目标(preset 决定):markdown_note、quick_summary、
   key_points、key_timestamps;预估费用 ¥0.25 – ¥1.06 · 预估耗时 8.3 – 27.4 分钟;
   费用硬上限 ¥2.5。
5. 环境能力如实展示真实安装状态(诚实门):word_timestamps=missing_dependency、
   speaker_diarization=missing_dependency、visual_evidence=ready、
   search_document=ready、query_ready=ready(该 venv 未装 whisperx/pyannote,
   装了 rapidocr —— 与事实一致,无虚标)。
6. 「提交解析」弹出**费用确认对话框**(拍板 5.5):来源、preset、预估费用区间、
   预估耗时区间、「¥2.5(最坏情况预估越界即终止)」、"估算不是承诺"与
   "不提供记住选择" 文案;「取消」正常关闭,未提交任务(零费用)。

说明:截图因 Browser pane 未前置无法合成帧(screenshot 超时),以上以
accessibility tree 与页面全文实录为证;Playwright 截图归阶段 6。
