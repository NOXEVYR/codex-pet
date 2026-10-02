<p align="center">
  <img src="docs/screenshots/standard-maid.png" width="200" alt="标准 Q 版女仆装">
  <img src="docs/screenshots/big-head-cheongsam.png" width="200" alt="大头 Q 版红金旗袍">
  <img src="docs/screenshots/edge-grip.png" width="200" alt="边缘收纳探头">
</p>

# 枣子姐桌宠 NatsumePet

《星光咖啡馆与死神之蝶》四季夏目（枣子姐）的 Q 版 Windows 桌宠。双击启动，无需安装；人物素材内置，程序不联网、不添加开机启动。

**[下载 v0.5.9 · Windows 便携 ZIP](https://github.com/turnsolesama/codex-pet/releases/download/v0.5.9/NatsumePet-v0.5.9-Windows.zip)** · **[单文件 EXE](https://github.com/turnsolesama/codex-pet/releases/download/v0.5.9/NatsumePet.exe)**

Windows / .NET Framework 4.x。解压后打开 `NatsumePet/NatsumePet.exe`；EXE 也可直接下载运行。版本说明及校验值见 [v0.5.9 发布页](https://github.com/turnsolesama/codex-pet/releases/tag/v0.5.9)。[历史 v0.4.1](https://github.com/turnsolesama/codex-pet/releases/tag/v0.4.1) 保留。

## 本版变化

- 四档尺寸：小号 160、中号 240、大号 360、超大号 432；超大号比大号大 20%，全身和边缘探头同比缩放。
- 默认关闭重力，拖到哪里停在哪里；标准 Q 版女仆的坐姿、睡姿拖动时可以保留。需要下落时，在“额外功能 → 重力下落”开启。
- 收纳后可沿左右边缘上下拖动，向屏幕内拖出才展开。女仆抓框贴图已修正裁切，手指贴住边框。
- 退出固定在菜单底部；暂停后主动点击或拖动恢复互动。高 DPI 下动作画面能持续刷新。
- 更新应用图标，修复动作切换、收纳及拖动中断时的位置处理。

公开包提供两种 Q 版，不含游戏原始立绘或本地等身素材。本地等身版本的源代码路径保留；`-IncludeOfficial` 仅在自备完整私有素材时可用，这些素材和安装包不会随公开仓库上传。

## 互动

两种体型均支持女仆、日常私服、粉色服务员、冬日外套、红金旗袍五套服装，以及待机、闭眼、开心、害羞和嫌弃表情。

| 操作 | 回应 |
| --- | --- |
| 点头发 | 开心，轻轻摇晃 |
| 点脸 | 害羞，躲闪 |
| 点衣服 | 嫌弃 |
| 点脚 | 轻跳 |
| 短时间连点三次 | 嫌弃并提醒 |
| 拖动松手 | 停在当前位置；启用额外重力后下落 |
| 睡觉时点击 | 唤醒 |
| 拖到左右边缘或角落 | 自动收纳，双手抓框探头 |
| 沿边上下拖动 | 调整收纳位置 |
| 点击探头或向屏幕内拖出 | 展开 |

右键小人或托盘图标打开分组菜单，可换装、切换体型和大小、坐下/睡觉、收纳、置顶或暂停；“退出桌宠”始终位于底部。双击托盘图标回到鼠标所在屏幕的右下角。重复启动不会出现第二只。

标准 Q 版女仆额外支持坐下、打盹、拎起、拖动及落地动作。当前采用独立贴图和整体变换动画，尚非骨骼或逐帧动画。

## Dot 脸部动画调试

Dot 的脸部动画与 Windows 桌宠程序使用不同的素材和播放方式。当前正在按宿主的实际慢速待机节奏迭代，尚未作为正式版本发布。[睁眼呼吸调试素材](pets/natsume-face-dot/README.md) 包含图集和正常节奏预览；[本地节奏预览工具](tools/dot-pet-preview/README.md) 可检查自己的图集；[调试与验收说明](docs/DOT-ANIMATION-DEBUG.md) 记录播放限制和检查方法；[持续迭代记录](docs/DOT-ITERATION-PLAN.md) 跟踪表情与 Dot 模式适配。

## 从源码构建

C# 5 + WinForms + GDI+，无第三方程序包，使用 Windows 自带 .NET Framework 编译器。

```powershell
./desktop/build.ps1
```

输出 `releases/desktop-v0.5.9/`，包含 EXE、说明和校验元数据。公开构建引用的 Q 版素材及图标均在仓库中。

```powershell
./releases/desktop-v0.5.9/NatsumePet.exe --smoke-test --diagnostics C:/temp/natsume-check
```

诊断会写入检查结果与渲染图片。`--outfit casual` 指定初始服装，`--variant big-head` 指定大头 Q 版。原生桌面画面检查可使用 `desktop/check-runtime.ps1`，测试截图仅保留在本地。

[发布校验说明](docs/RELEASE-v0.5.9.md)。本机验证为 Windows、150% 系统缩放；自动检查不代替其他 DPI、长期运行及真实鼠标操作体验。

## 说明

本作品为个人兴趣的同人创作。角色「四季夏目」出自 Yuzusoft 游戏《星光咖啡馆与死神之蝶》，版权归原公司所有。公开 Q 版素材由 AI 生成并经修复与审核。程序不写注册表，不添加开机启动。

更多个人项目见 [portfolio](https://github.com/turnsolesama/portfolio)。
