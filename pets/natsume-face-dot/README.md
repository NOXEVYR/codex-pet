# 枣子姐 Dot 脸部动画

这是一轮调试素材，尚未作为正式 Release 发布。默认待机改为睁眼呼吸，避免低速播放时长时间闭眼或在思考时呈现睡态。人物为 AI 动画改绘；目录中不含游戏原始立绘或提取文件。

![按安装版宿主正常节奏播放的待机](idle-host-preview.gif)

本轮只修改待机行 0；行 1–10 保留已有云端素材。六帧呼吸的名义循环为 6.6 秒，预览采用最终编码图集生成，未加速。头部大小脉动已修复，小幅起伏在 64px 下约 2px；十六方向注视仍受宿主静态姿态切换限制。

`spritesheet.webp` 是 1536×2288、8×11 的 v2 透明图集，73 个有效帧、15 个透明留白格，大小 2,746,680 bytes。SHA-256：

```text
5fb8f25a57540be78224866ae6d711136259138039bc8098d681f6304baad5ec
```

`spriteVersionNumber: 2` 表示图集格式，不是动画改进次数；本轮素材版本见 [revision.json](revision.json)。Pets 结构校验、绑定脚本质量门及原尺寸/64px 独立视觉检查已通过，这些检查不能代替 Dot 的实际使用复测。

本地 Settings → Pets 素材使用 [pet.json](pet.json) 与 `spritesheet.webp`，放在同一个 `natsume-face` 目录中；替换已有目录前保留原件，刷新宠物列表后选择“枣子姐 · 脸部动画”。Dot 使用账号的云端宠物条目，本地复制不会自动更新云端条目；云端更新应保留原条目 ID。

本轮没有提高客户端 FPS，也没有修改 Windows NatsumePet EXE。保留的其它动作仍有部分姿态台阶，后续按实际反馈迭代。检查方法见 [调试说明](../../docs/DOT-ANIMATION-DEBUG.md)，自己的图集可用 [节奏预览工具](../../tools/dot-pet-preview/README.md) 检查。
