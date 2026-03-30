# Steam Code Status for VS Code

<div align="center">
    <img src="images/icon.png" alt="Logo" width="128" height="128">
    <br>
    <br>
    <a href="https://github.com/tudou0133/VSCode_SteamCodeStatus">
        <img src="https://img.shields.io/badge/GitHub-Repository-black?logo=github" alt="GitHub">
    </a>
    <a href="https://github.com/tudou0133/VSCode_SteamCodeStatus/blob/main/LICENSE">
        <img src="https://img.shields.io/github/license/tudou0133/VSCode_SteamCodeStatus" alt="License">
    </a>
    <a href="./CHANGELOG.md">
        <img src="https://img.shields.io/badge/Changelog-更新日志-brightgreen?logo=markdown&logoColor=white" alt="Changelog">
    </a>
    <a href="https://marketplace.visualstudio.com/items?itemName=tudou0133.SteamCodeStatus">
        <img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visual-studio-code" alt="Marketplace">
    </a>
</div>

**中文**  
Steam Code Status 是一个 VS Code 扩展，用来把你当前的编程活动同步到 Steam Rich Presence。它会根据当前文件、项目、语言、行数或 ESP-IDF 任务状态，实时更新你在 Steam 好友列表中的显示内容。

**English**  
Steam Code Status is a VS Code extension that syncs your current coding activity to Steam Rich Presence. It can update your Steam status in real time based on the active file, workspace, language, line count, or ESP-IDF task activity.

<div align="center">
    <img src="images/preview.png" alt="Steam Friends List Preview" width="600">
</div>

## Features / 功能特性

- **实时同步 / Real-time sync**: 根据当前编辑文件自动更新 Steam 状态。 Automatically updates Steam status from the active editor.
- **模板化显示 / Templated text**: 支持 `statusTemplate` 自定义状态文本。 Customize the visible status text with `statusTemplate`.
- **条件片段 / Conditional segments**: 方括号 `[...]` 包裹的内容仅在变量存在时显示。 Content inside `[...]` is rendered only when referenced variables exist.
- **游戏参数适配 / Game-specific mapping**: 支持自定义 `steamAppId`、`displayTemplate`、`dynamicKey` 和 `staticArgs`。 Supports custom `steamAppId`, `displayTemplate`, `dynamicKey`, and `staticArgs`.
- **组队显示 / Group info**: 可设置 `groupId` 和 `groupSize`。 Supports `groupId` and `groupSize`.
- **手动锁定 / Manual override**: 可手动固定一条状态文本。 Lets you lock a manual status text.
- **ESP-IDF 联动 / ESP-IDF integration**: 编译和烧录时优先显示对应状态。 Build and flash activity can override normal file-editing status.

## Quick Start / 快速开始

1. 启动并登录 Steam。  
   Start and sign in to Steam.
2. 在 VS Code 扩展市场搜索 `Steam Code Status` 并安装。  
   Search for `Steam Code Status` in the VS Code Marketplace and install it.
3. 打开一个代码文件，插件会自动启动 bridge 并同步状态。  
   Open any code file, and the extension will start the bridge and sync your status automatically.

## Settings / 配置说明

以下配置项都可以在 VS Code 设置中搜索 `codeStatus` 找到。  
You can find all settings by searching for `codeStatus` in VS Code Settings.

| Setting | Default | 中文说明 | English |
| :--- | :--- | :--- | :--- |
| `codeStatus.enabled` | `true` | 启用或禁用状态同步 | Enable or disable status sync |
| `codeStatus.steamAppId` | `730` | 目标游戏 AppID，例如 `480` 或 `730` | Target game AppID, for example `480` or `730` |
| `codeStatus.displayTemplate` | `#display_GameKnownMapScore` | Rich Presence 显示模板 Key | Rich Presence display template key |
| `codeStatus.dynamicKey` | `game:score` | 用来承载动态状态文本的 Key | Key that receives dynamic status text |
| `codeStatus.staticArgs` | `game:mode=competitive & game:map=de_mirage` | 静态参数，格式为 `key=value & key=value` | Static arguments in `key=value & key=value` format |
| `codeStatus.statusTemplate` | `正在编写 {folderName}/{fileName}` | 编辑状态模板，支持变量替换和 `[...]` 条件片段 | Editing status template with variable substitution and `[...]` conditional segments |
| `codeStatus.idleText` | `正在摸鱼🐟` | 没有活动文件时显示的文本 | Text shown when no active file is open |
| `codeStatus.groupId` | `""` | Steam 组队或房间 ID | Steam party or lobby ID |
| `codeStatus.groupSize` | `"1"` | Steam 组队人数 | Steam party size |
| `codeStatus.showEspIdfActivity` | `true` | 是否优先显示 ESP-IDF 编译/烧录状态 | Whether ESP-IDF build or flash activity should override normal editing status |
| `codeStatus.espIdfBuildTemplate` | `正在编译 {esp_chip} 项目` | ESP-IDF 编译状态模板 | ESP-IDF build status template |
| `codeStatus.espIdfFlashTemplate` | `正在烧录 {esp_chip} 芯片` | ESP-IDF 烧录状态模板 | ESP-IDF flash status template |

## Template Syntax / 模板语法

**中文**  
`statusTemplate`、`espIdfBuildTemplate` 和 `espIdfFlashTemplate` 支持变量替换。可用变量包括：

- `{projectName}`
- `{fileName}`
- `{language}`
- `{lineCount}`
- `{filePath}`
- `{folderName}`
- `{esp_chip}`（仅 ESP-IDF 模板）

使用 `[...]` 包裹一段内容时，只要其中引用的变量为空，这段内容就会整体隐藏。  
示例：`[{projectName} | ]{fileName}`

**English**  
`statusTemplate`, `espIdfBuildTemplate`, and `espIdfFlashTemplate` support variable substitution. Available variables include:

- `{projectName}`
- `{fileName}`
- `{language}`
- `{lineCount}`
- `{filePath}`
- `{folderName}`
- `{esp_chip}` (ESP-IDF templates only)

If a segment is wrapped in `[...]`, it is rendered only when all referenced variables are present.  
Example: `[{projectName} | ]{fileName}`

## Example: Configure Another Game / 示例：适配其他游戏

**中文**  
如果你想把状态显示到其他 Steam 游戏上，需要先确认该游戏使用的 `steam_display` 模板和动态 Key。你可以运行目标游戏，然后访问 Valve 的测试页面：  
<https://steamcommunity.com/dev/testrichpresence>

例如某个游戏要求：

- `steamAppId = 730`
- `displayTemplate = #display_GameKnownMapScore`
- `dynamicKey = game:score`
- `staticArgs = game:mode=competitive & game:map=de_mirage`

那么插件就会把你的代码状态写到该游戏对应的 Rich Presence 字段里。

**English**  
If you want to display your coding activity under another Steam game, you need to identify that game's `steam_display` template and dynamic key first. Start the target game, then inspect its Rich Presence data here:  
<https://steamcommunity.com/dev/testrichpresence>

For example, if a game expects:

- `steamAppId = 730`
- `displayTemplate = #display_GameKnownMapScore`
- `dynamicKey = game:score`
- `staticArgs = game:mode=competitive & game:map=de_mirage`

the extension will write your coding status into that game's Rich Presence fields.

## How It Works / 工作原理

**中文**  
扩展前端使用 TypeScript 编写，负责监听 VS Code 当前状态；bridge 后端使用 C# 编写，负责通过 Steamworks.NET 与 Steam 客户端通信。两者通过标准输入输出进行数据交换。

**English**  
The extension frontend is written in TypeScript and watches editor state in VS Code. The bridge backend is written in C# and communicates with the Steam client through Steamworks.NET. The two processes exchange data over standard input and output.

## Build From Source / 从源码构建

```bash
npm install
npm run compile
```

如果需要重新发布 bridge：  
If you need to republish the bridge:

```bash
npm run build:bridge_x64
npm run build:bridge_linux
```

或者一次性构建全部：  
Or build everything at once:

```bash
npm run build:all
```

## Credits / 致谢

- 想法和早期实现 / Ideas and early implementation: 罗吉@furrylogy
- [Steamworks.NET](https://github.com/rlabrecque/Steamworks.NET): C# wrapper for Valve's Steamworks API

## License / 许可证

[MIT](LICENSE) © 2026 tudou0133
