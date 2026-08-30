# Zimu Studio Design System

> `ui-ux-pro-max` 的 Python 检索器在当前机器不可用；本文件依据该技能的内置生产力工具与无障碍默认规则建立。

## 产品基调

- 类型：高密度桌面生产力工具，内容优先，低动效。
- 风格：深色、扁平、清晰边界；不使用玻璃拟态、装饰渐变或表情符号图标。
- 主操作：每个区域只有一个蓝色主按钮，其余使用中性或幽灵层级。

## Tokens

- Canvas `#090D14`，Surface `#0F151F`，Elevated `#151D2A`，Border `#2A3648`。
- Primary `#5B8DFF`，Success `#35C89A`，Warning `#F5B94C`，Danger `#FF6B6B`。
- Text `#EBF1FA`，Muted `#9FADC1`；正文对比度至少 4.5:1。
- 间距采用 4/8px 节奏；控件高至少 44px；圆角 8/12/16px。
- 字体：Segoe UI / Microsoft YaHei UI / Yu Gothic UI；时间码使用 Cascadia Mono / Consolas。

## 布局与交互

- 最小窗口 1120×720，目标窗口 1480×920；工作区左侧媒体 42%，右侧字幕自适应。
- 50 条以上字幕必须虚拟化；输入在失焦时提交，避免逐键写入历史。
- 所有图标来自 Lucide，图标按钮必须有 `aria-label` 和可见焦点。
- 动效仅使用 150ms 颜色/透明度过渡并尊重 `prefers-reduced-motion`。
- 状态不能只靠颜色：成功、警告和错误同时使用图标与文字。
