import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

let clientProcess: cp.ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;
let isWindowFocused = vscode.window.state.focused;
let manualOverrideText: string | undefined = undefined;
let myStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    // 1. 初始化日志
    outputChannel = vscode.window.createOutputChannel("CodeStatus Debug");
    outputChannel.appendLine("插件已激活，读取配置中...");

    // 2. 首次启动
    startBridge(context);

    // 3. 创建状态栏
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    myStatusBarItem.command = "codeStatus.showMainMenu"; // 点击触发主菜单
    context.subscriptions.push(myStatusBarItem);
    updateStatusBarVisuals(); // 初始化显示
    myStatusBarItem.show();

    // ==========================================
    // 注册命令
    // ==========================================

    // [命令 1] 显示主菜单 (状态栏点击触发)
    const menuCommand = vscode.commands.registerCommand('codeStatus.showMainMenu', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const isEnabled = config.get<boolean>('enabled', true);
        const currentGroupId = config.get<string>('groupId', "");

        const items: vscode.QuickPickItem[] = [
            {
                label: isEnabled ? "$(circle-filled) 暂停同步 (Disable)" : "$(play) 启用同步 (Enable)",
                description: isEnabled ? "当前状态: 已启用" : "当前状态: 已禁用",
                detail: "codeStatus.toggleEnabled" // 存命令ID方便后续处理
            },
            {
                label: "$(organization) 设置组队 ID (Group ID)",
                description: currentGroupId ? `当前: ${currentGroupId}` : "当前: 未设置",
                detail: "codeStatus.setGroupId"
            },
            {
                label: "$(edit) 手动修改状态文本",
                description: manualOverrideText ? `当前锁定: ${manualOverrideText}` : "当前: 自动模式",
                detail: "codeStatus.setManualStatus"
            }
        ];

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: "Steam Code Status 设置菜单"
        });

        if (selection && selection.detail) {
            vscode.commands.executeCommand(selection.detail);
        }
    });

    // [命令 2] 切换启用/禁用
    const toggleCommand = vscode.commands.registerCommand('codeStatus.toggleEnabled', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const current = config.get<boolean>('enabled', true);
        // 修改配置 (Global = 用户设置)
        await config.update('enabled', !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(current ? "Steam Status 已禁用" : "Steam Status 已启用", 3000);
        updateStatusBarVisuals();
    });

    // [命令 3] 设置组队 ID
    const groupCommand = vscode.commands.registerCommand('codeStatus.setGroupId', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const currentId = config.get<string>('groupId', "");

        const input = await vscode.window.showInputBox({
            placeHolder: "输入组队 ID (例如: MyTeam)",
            prompt: "设置 Steam 组队 ID (清空则关闭组队显示)",
            value: currentId
        });

        if (input !== undefined) {
            await config.update('groupId', input, vscode.ConfigurationTarget.Global);
            // 顺便提示是否要设置人数
            const setSize = await vscode.window.showInformationMessage(`组队 ID 已设为 "${input}"，需要设置人数吗？`, "设置人数", "跳过");
            if (setSize === "设置人数") {
                const sizeInput = await vscode.window.showInputBox({ prompt: "输入队伍总人数", value: "4" });
                if (sizeInput) await config.update('groupSize', sizeInput, vscode.ConfigurationTarget.Global);
            }
        }
    });

    // [命令 4] 手动修改状态 (原有的逻辑)
    const manualCommand = vscode.commands.registerCommand('codeStatus.setManualStatus', async () => {
        const input = await vscode.window.showInputBox({
            placeHolder: "输入自定义状态 (留空回车则恢复自动模式)",
            prompt: "强制修改 Steam 状态",
            value: manualOverrideText || ""
        });

        if (input === undefined) return;

        if (input.trim() === "") {
            manualOverrideText = undefined;
            vscode.window.setStatusBarMessage("CodeStatus: 已恢复自动模式", 3000);
        } else {
            manualOverrideText = input;
            vscode.window.setStatusBarMessage(`CodeStatus: 已锁定为 "${input}"`, 3000);
        }
        updateStatus(vscode.window.activeTextEditor);
        updateStatusBarVisuals(); // 可能状态变了，刷一下图标
    });

    context.subscriptions.push(menuCommand, toggleCommand, groupCommand, manualCommand);


    // 4. 监听配置修改 (Hot Reload)
    // 注意：上面的 toggleEnabled 和 setGroupId 都会触发这个事件，所以不需要在那里写重启逻辑
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('codeStatus')) {
            outputChannel.appendLine("[System] 检测到配置变更，正在重启后端...");
            updateStatusBarVisuals(); // 刷新图标状态
            stopBridge();
            setTimeout(() => startBridge(context), 500);
        }
    }));

    // 5. 监听窗口焦点
    context.subscriptions.push(vscode.window.onDidChangeWindowState((windowState) => {
        isWindowFocused = windowState.focused;
        if (isWindowFocused) updateStatus(vscode.window.activeTextEditor);
    }));

    // 6. 监听编辑器切换
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        updateStatus(editor);
    }));
}

// --- 封装启动逻辑 ---
function startBridge(context: vscode.ExtensionContext) {
    // 1. 读取用户配置
    const config = vscode.workspace.getConfiguration('codeStatus');
    const enabled = config.get<boolean>('enabled', true);
    
    // 如果用户关掉了插件，直接返回
    if (!enabled) {
        outputChannel.appendLine("[System] 插件已禁用 (Disabled in Settings)");
        return;
    }

    const appId = config.get<string>('steamAppId', "480");
    const template = config.get<string>('displayTemplate', "#Status_Airport");
    const dynamicKey = config.get<string>('dynamicKey', "max_players");
    // 获取静态参数字符串 (例如: "key1=val1 & key2=val2")
    const staticArgsRaw = config.get<string>('staticArgs', "");
    const groupId = config.get<string>('groupId', "1");
    const groupSize = config.get<string>('groupSize', "1");

    // 2. 确定路径
    let backendRoot = "";
    let exeName = "";
    if (process.platform === 'win32') {
        backendRoot = path.join(context.extensionPath, 'backend', 'win-x64');
        exeName = "SteamRichPresenceBridge.exe";
    } else if (process.platform === 'linux') {
        backendRoot = path.join(context.extensionPath, 'backend', 'linux-x64');
        exeName = "SteamRichPresenceBridge";
    } else {
        return;
    }
    const exePath = path.join(backendRoot, exeName);

    // 3. 构造参数
    const args = [
        "-app", appId,
        "-template", template,
        "-key", dynamicKey,
        "-group", groupId,
        "-groupsize", groupSize
    ];

    // 处理多个 -static 参数
    // 逻辑：用 '&' 分割字符串，然后循环添加到数组中
    if (staticArgsRaw && staticArgsRaw.trim() !== "") {
        const pairs = staticArgsRaw.split('&'); // 使用 & 作为分隔符
        for (const pair of pairs) {
            const cleanPair = pair.trim();
            // 只有包含 '=' 的才被视为有效参数
            if (cleanPair && cleanPair.includes('=')) {
                args.push("-static", cleanPair);
            }
        }
    }

    outputChannel.appendLine(`[启动] 参数: ${JSON.stringify(args)}`);

    // 4. 启动进程
    try {
        if (process.platform === 'linux') {
            const fs = require('fs');
            try { fs.chmodSync(exePath, '755'); } catch {}
        }

        clientProcess = cp.spawn(exePath, args, {
            cwd: backendRoot,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (clientProcess.pid) {
            outputChannel.appendLine(`[System] 后端进程 PID: ${clientProcess.pid}`);
            // 启动成功后立刻刷一次状态
            updateStatus(vscode.window.activeTextEditor);
        }

        clientProcess.stdout?.on('data', d => outputChannel.appendLine(`[Bridge]: ${d}`));
        clientProcess.stderr?.on('data', d => outputChannel.appendLine(`[Error]: ${d}`));
        clientProcess.on('close', c => {
            outputChannel.appendLine(`[System] 退出代码: ${c}`);
            clientProcess = undefined;
        });

    } catch (e) {
        outputChannel.appendLine(`启动失败: ${e}`);
    }
}

// --- 封装停止逻辑 ---
function stopBridge() {
    if (clientProcess) {
        outputChannel.appendLine("[System] 正在停止...");
        clientProcess.kill();
        clientProcess = undefined;
    }
}

function updateStatus(editor: vscode.TextEditor | undefined) {
    if (!clientProcess || clientProcess.killed || !isWindowFocused) return;

    let statusText = "";

    // 1. 获取配置 (支持实时修改，不需要重启后端)
    const config = vscode.workspace.getConfiguration('codeStatus');
    // 默认模板：如果有项目名则显示 "项目 | 文件"，否则只显示 "文件"
    const statusTemplate = config.get<string>('statusTemplate', '[{projectName} | ]正在编写 {folderName}/{fileName}');
    const idleText = config.get<string>('idleText', '正在摸鱼🐟'); // 空闲时的文字

    // 2. 决定显示内容
    if (manualOverrideText) {
        // [模式 A] 手动锁定模式
        statusText = manualOverrideText;
    } else {
        // [模式 B] 自动模式
        if (editor) {
            /// 准备数据上下文 (Context)
            const doc = editor.document;
            const fullPath = doc.fileName;

            // --- [新增逻辑] 获取上一级目录名 ---
            // 1. 获取目录路径: /Users/me/project/src/components
            const dirPath = path.dirname(fullPath); 
            // 2. 获取目录名的最后一段: components
            const folderName = path.basename(dirPath); 
            // ----------------------------------

            const context = {
                fileName: path.basename(fullPath),
                projectName: vscode.workspace.name,
                language: doc.languageId,
                lineCount: doc.lineCount,
                
                // 新增变量
                folderName: folderName, 
                
                // 原有的相对路径 (src/components/Button.tsx)
                filePath: vscode.workspace.asRelativePath(fullPath), 
            };

            // 使用格式化器生成文本
            statusText = StatusFormatter.render(statusTemplate, context);
        } else {
            // 没打开文件
            statusText = idleText;
        }
    }

    // 3. 发送数据
    try {
        // 移除换行符防止协议错乱
        const cleanText = statusText.replace(/[\r\n]/g, ' '); 
        clientProcess.stdin?.write(cleanText + "\n");
        outputChannel.appendLine(`[Sent]: ${cleanText} ${manualOverrideText ? '(Manual)' : '(Auto)'}`);
    } catch (e) { }
}

export function deactivate() {
    stopBridge();
}

// ==========================================
// 格式化工具类
// ==========================================
const StatusFormatter = {
    /**
     * 渲染模板
     * @param template 用户定义的模板，如 "[{projectName} | ]{fileName}"
     * @param data 数据上下文
     */
    render(template: string, data: any): string {
        if (!template) return '';

        // 1. 处理条件组 [...]
        // 逻辑：如果组内的变量在 data 中缺失(null/undefined/空)，则整个组隐藏
        let result = template.replace(/\[(.*?)\]/g, (match, content) => {
            // 找出组内所有 {variable}
            const variables = content.match(/\{(\w+)\}/g) || [];
            
            // 检查组内变量是否都存在
            for (const v of variables) {
                const key = v.replace(/\{|\}/g, '');
                if (this.isEmpty(data[key])) {
                    return ''; // 只要有一个缺了，整个组就隐藏
                }
            }
            // 如果都不缺，保留组的内容（去掉中括号）
            return content;
        });

        // 2. 替换剩余的变量 {key}
        result = result.replace(/\{(\w+)\}/g, (match, key) => {
            return this.isEmpty(data[key]) ? '' : String(data[key]);
        });

        return result;
    },

    isEmpty(value: any) {
        return value === null || value === undefined || value === '';
    }
};

// --- 辅助函数：更新状态栏视觉效果 ---
function updateStatusBarVisuals() {
    if (!myStatusBarItem) return;

    const config = vscode.workspace.getConfiguration('codeStatus');
    const isEnabled = config.get<boolean>('enabled', true);
    const groupId = config.get<string>('groupId', "");

    if (!isEnabled) {
        myStatusBarItem.text = "$(circle-slash) Steam: Off";
        myStatusBarItem.tooltip = "Steam Status 已禁用 (点击开启)";
        myStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); // 显眼的背景色
    } else {
        // 正常开启状态
        if (manualOverrideText) {
            myStatusBarItem.text = "$(lock) Steam: Manual"; // 锁定图标
            myStatusBarItem.tooltip = `当前手动锁定: ${manualOverrideText}`;
        } else {
            myStatusBarItem.text = "$(megaphone) Steam: On";
            // 如果有组队，显示一点提示
            if (groupId) {
                myStatusBarItem.tooltip = `正在同步 | 组队 ID: ${groupId}`;
            } else {
                myStatusBarItem.tooltip = "点击打开设置菜单";
            }
        }
        myStatusBarItem.backgroundColor = undefined; // 恢复默认背景
    }
}
