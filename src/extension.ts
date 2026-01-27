import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

let clientProcess: cp.ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;
let isWindowFocused = vscode.window.state.focused;
let manualOverrideText: string | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    // 1. 初始化日志
    outputChannel = vscode.window.createOutputChannel("CodeStatus Debug");
    outputChannel.appendLine("插件已激活，读取配置中...");

    // 2. 首次启动
    startBridge(context);

    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    myStatusBarItem.command = "codeStatus.setManualStatus";
    myStatusBarItem.text = "$(megaphone) Steam状态"; // 图标+文字
    myStatusBarItem.tooltip = "点击手动修改 Steam 状态";
    myStatusBarItem.show();
    context.subscriptions.push(myStatusBarItem);

    // 注册手动修改命令
    const manualCommand = vscode.commands.registerCommand('codeStatus.setManualStatus', async () => {
        // 弹出输入框
        const input = await vscode.window.showInputBox({
            placeHolder: "输入自定义状态 (留空回车则恢复自动模式)",
            prompt: "强制修改 Steam 状态"
        });

        // 逻辑判断
        if (input === undefined) {
            return; // 用户按了 ESC，什么都不做
        }

        if (input.trim() === "") {
            manualOverrideText = undefined; // 恢复自动
            vscode.window.setStatusBarMessage("CodeStatus: 已恢复自动模式", 3000);
        } else {
            manualOverrideText = input; // 设置手动内容
            vscode.window.setStatusBarMessage(`CodeStatus: 已锁定为 "${input}"`, 3000);
        }

        // 立即刷新一次
        updateStatus(vscode.window.activeTextEditor);
    });
    context.subscriptions.push(manualCommand);

    // 3. 监听配置修改 (Hot Reload)
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('codeStatus')) {
            outputChannel.appendLine("[System] 检测到配置变更，正在重启后端...");
            stopBridge();
            setTimeout(() => startBridge(context), 500); // 延时一点等待清理
        }
    }));

    // 4. 监听窗口焦点 (防冲突)
    context.subscriptions.push(vscode.window.onDidChangeWindowState((windowState) => {
        isWindowFocused = windowState.focused;
        if (isWindowFocused) updateStatus(vscode.window.activeTextEditor);
    }));

    // 5. 监听编辑器切换
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
    const staticArgs = config.get<string>('staticArgs', "players=/");
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
        "-static", staticArgs,
        "-group", groupId,
        "-groupsize", groupSize
    ];

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
