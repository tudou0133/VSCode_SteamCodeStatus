import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let clientProcess: cp.ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;
let isWindowFocused = vscode.window.state.focused;
let manualOverrideText: string | undefined = undefined;
let myStatusBarItem: vscode.StatusBarItem;

type EspIdfActivity = 'none' | 'build' | 'flash';

let espIdfActivity: EspIdfActivity = 'none';
let espIdfActivityCount = 0;
let espIdfTargetCache: string | undefined;


function classifyEspIdfTask(task: vscode.Task): EspIdfActivity | undefined {
    const source = String(task.source || '').toLowerCase();
    const definition: any = task.definition || {};
    const type = String(definition.type || '').toLowerCase();
    const taskId = String(definition.taskId || '').toLowerCase();
    const command = String(definition.command || '').toLowerCase();
    const name = String(task.name || '').toLowerCase();

    if (source !== 'espressif.esp-idf-extension' || type !== 'esp-idf') {
        return undefined;
    }

    if (
        taskId === 'idf-flash-task' ||
        command === 'esp-idf flash' ||
        name === 'esp-idf flash'
    ) {
        return 'flash';
    }

    if (
        taskId === 'idf-build-task' ||
        command === 'esp-idf build' ||
        name === 'esp-idf build'
    ) {
        return 'build';
    }

    return undefined;
}

function isRealCodeDocument(doc: vscode.TextDocument): boolean {
    const scheme = doc.uri.scheme;

    // 只接受真实文件（本地/远程），避免 Output / Debug / Search 等虚拟文档被同步到 Steam
    if (scheme !== 'file' && scheme !== 'vscode-remote') {
        return false;
    }

    // 额外兜底：有些虚拟输出可能会伪装成文件名
    const fn = doc.fileName || '';
    if (fn.includes('extension-output-') || fn.includes('CodeStatus Debug')) {
        return false;
    }

    return true;
}

function getWorkspaceFolderForEditor(editor: vscode.TextEditor | undefined): vscode.WorkspaceFolder | undefined {
    if (editor) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (folder) return folder;
    }

    return vscode.workspace.workspaceFolders?.[0];
}

function readIdfTargetFromFile(filePath: string): string | undefined {
    try {
        if (!fs.existsSync(filePath)) return undefined;
        const text = fs.readFileSync(filePath, 'utf8');

        // 支持:
        // CONFIG_IDF_TARGET="esp32s2"
        // CONFIG_IDF_TARGET=esp32s2
        const match = text.match(/^CONFIG_IDF_TARGET\s*=\s*"?([A-Za-z0-9_]+)"?\s*$/m);
        if (match?.[1]) {
            return match[1].toLowerCase();
        }
    } catch (e) {
        outputChannel.appendLine(`[ESP-IDF] 读取 target 失败: ${filePath}, err=${e}`);
    }

    return undefined;
}

function resolveEspIdfTarget(editor: vscode.TextEditor | undefined): string | undefined {
    const folder = getWorkspaceFolderForEditor(editor);
    if (!folder) return undefined;

    const root = folder.uri.fsPath;

    const fromSdkconfig = readIdfTargetFromFile(path.join(root, 'sdkconfig'));
    if (fromSdkconfig) return fromSdkconfig;

    const fromDefaults = readIdfTargetFromFile(path.join(root, 'sdkconfig.defaults'));
    if (fromDefaults) return fromDefaults;

    return undefined;
}

function getEspIdfStatusText(editor: vscode.TextEditor | undefined): string {
    const config = vscode.workspace.getConfiguration('codeStatus');

    const buildTemplate = config.get<string>('espIdfBuildTemplate', '正在编译 {esp_chip}');
    const flashTemplate = config.get<string>('espIdfFlashTemplate', '正在烧录 {esp_chip}');

    const target = espIdfTargetCache || resolveEspIdfTarget(editor);
    const esp_chip = (target ?? 'ESP-IDF');
    const projectName = vscode.workspace.name ?? '';

    const ctx = {
        esp_chip,
        projectName
    };

    if (espIdfActivity === 'build') {
        const rendered = StatusFormatter.render(buildTemplate, ctx).trim();
        return rendered !== '' ? rendered : `正在编译 ${esp_chip}`;
    }

    if (espIdfActivity === 'flash') {
        const rendered = StatusFormatter.render(flashTemplate, ctx).trim();
        return rendered !== '' ? rendered : `正在烧录 ${esp_chip}`;
    }

    return '';
}

function startEspIdfActivity(kind: EspIdfActivity, editor: vscode.TextEditor | undefined) {
    espIdfActivity = kind;
    espIdfActivityCount++;
    espIdfTargetCache = resolveEspIdfTarget(editor);

    outputChannel.appendLine(
        `[ESP-IDF] start kind=${kind}, target=${espIdfTargetCache ?? 'unknown'}`
    );

    updateStatus(editor);
}

function endEspIdfActivity(kind: EspIdfActivity, exitCode: number | undefined, editor: vscode.TextEditor | undefined) {
    espIdfActivityCount = Math.max(0, espIdfActivityCount - 1);

    if (espIdfActivityCount === 0) {
        espIdfActivity = 'none';
        espIdfTargetCache = undefined;
    }

    outputChannel.appendLine(
        `[ESP-IDF] end kind=${kind}, exit=${exitCode ?? 'unknown'}`
    );

    updateStatus(editor);
}

export function activate(context: vscode.ExtensionContext) {
    // 1. 初始化日志
    outputChannel = vscode.window.createOutputChannel("CodeStatus Debug");
    outputChannel.appendLine("插件已激活，读取配置中...");

    // 2. 首次启动
    startBridge(context);

    // 3. 创建状态栏
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    myStatusBarItem.command = "codeStatus.showMainMenu";
    context.subscriptions.push(myStatusBarItem);
    updateStatusBarVisuals();
    myStatusBarItem.show();

    // ==========================================
    // 注册命令
    // ==========================================

    const menuCommand = vscode.commands.registerCommand('codeStatus.showMainMenu', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const isEnabled = config.get<boolean>('enabled', true);
        const currentGroupId = config.get<string>('groupId', "");
        const showEspIdfActivity = config.get<boolean>('showEspIdfActivity', true);

        const items: vscode.QuickPickItem[] = [
            {
                label: isEnabled ? "$(circle-filled) 暂停同步 (Disable)" : "$(play) 启用同步 (Enable)",
                description: isEnabled ? "当前状态: 已启用" : "当前状态: 已禁用",
                detail: "codeStatus.toggleEnabled"
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
            },
            {
                label: showEspIdfActivity ? "$(check) ESP-IDF 状态同步: 开" : "$(circle-slash) ESP-IDF 状态同步: 关",
                description: showEspIdfActivity ? "编译/烧录时优先显示 ESP-IDF 状态" : "仅显示文件编辑状态",
                detail: "codeStatus.toggleEspIdfActivity"
            }
        ];

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: "Steam Code Status 设置菜单"
        });

        if (selection && selection.detail) {
            vscode.commands.executeCommand(selection.detail);
        }
    });

    const toggleCommand = vscode.commands.registerCommand('codeStatus.toggleEnabled', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const current = config.get<boolean>('enabled', true);
        await config.update('enabled', !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(current ? "Steam Status 已禁用" : "Steam Status 已启用", 3000);
        updateStatusBarVisuals();
    });

    const toggleEspIdfCommand = vscode.commands.registerCommand('codeStatus.toggleEspIdfActivity', async () => {
        const config = vscode.workspace.getConfiguration('codeStatus');
        const current = config.get<boolean>('showEspIdfActivity', true);
        await config.update('showEspIdfActivity', !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(!current ? "ESP-IDF 状态同步已开启" : "ESP-IDF 状态同步已关闭", 3000);
        updateStatus(vscode.window.activeTextEditor);
        updateStatusBarVisuals();
    });

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

            const setSize = await vscode.window.showInformationMessage(`组队 ID 已设为 "${input}"，需要设置人数吗？`, "设置人数", "跳过");
            if (setSize === "设置人数") {
                const sizeInput = await vscode.window.showInputBox({ prompt: "输入队伍总人数", value: "4" });
                if (sizeInput) await config.update('groupSize', sizeInput, vscode.ConfigurationTarget.Global);
            }
        }
    });

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
        updateStatusBarVisuals();
    });

    context.subscriptions.push(menuCommand, toggleCommand, toggleEspIdfCommand, groupCommand, manualCommand);

    // 4. 监听配置修改 (Hot Reload)
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('codeStatus')) return;

        // 只有影响 bridge 启动参数/开关的配置才需要重启后端
        const needsRestart =
            e.affectsConfiguration('codeStatus.enabled') ||
            e.affectsConfiguration('codeStatus.steamAppId') ||
            e.affectsConfiguration('codeStatus.displayTemplate') ||
            e.affectsConfiguration('codeStatus.dynamicKey') ||
            e.affectsConfiguration('codeStatus.staticArgs') ||
            e.affectsConfiguration('codeStatus.groupId') ||
            e.affectsConfiguration('codeStatus.groupSize');

        updateStatusBarVisuals();

        if (needsRestart) {
            outputChannel.appendLine("[System] 检测到配置变更，正在重启后端...");
            stopBridge();
            setTimeout(() => startBridge(context), 500);
        } else {
            // 仅更新显示文本，无需重启 bridge
            updateStatus(vscode.window.activeTextEditor);
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
    // 7. ESP-IDF task 监听（编译/烧录）
    context.subscriptions.push(
        vscode.tasks.onDidStartTaskProcess((e) => {
            const kind = classifyEspIdfTask(e.execution.task);
            if (!kind) return;
            startEspIdfActivity(kind, vscode.window.activeTextEditor);
        }),

        vscode.tasks.onDidEndTaskProcess((e) => {
            const kind = classifyEspIdfTask(e.execution.task);
            if (!kind) return;
            endEspIdfActivity(kind, e.exitCode, vscode.window.activeTextEditor);
        })
    );
}

// --- 封装启动逻辑 ---

function startBridge(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('codeStatus');
    const enabled = config.get<boolean>('enabled', true);

    if (!enabled) {
        outputChannel.appendLine("[System] 插件已禁用 (Disabled in Settings)");
        return;
    }

    const appId = config.get<string>('steamAppId', "480");
    const template = config.get<string>('displayTemplate', "#Status_Airport");
    const dynamicKey = config.get<string>('dynamicKey', "max_players");
    const staticArgsRaw = config.get<string>('staticArgs', "");
    const groupId = config.get<string>('groupId', "");
    const groupSize = config.get<string>('groupSize', "1");

    let backendRoot = "";
    let exeName = "";

    if (process.platform === 'win32') {
        backendRoot = path.join(context.extensionPath, 'backend', 'win-x64');
        exeName = "SteamRichPresenceBridge.exe";
    } else if (process.platform === 'linux') {
        backendRoot = path.join(context.extensionPath, 'backend', 'linux-x64');
        exeName = "SteamRichPresenceBridge";
    } else {
        outputChannel.appendLine(`[System] 暂不支持的平台: ${process.platform}`);
        return;
    }

    const exePath = path.join(backendRoot, exeName);

    const args = [
        "-app", appId,
        "-template", template,
        "-key", dynamicKey,
        "-group", groupId,
        "-groupsize", groupSize
    ];

    if (staticArgsRaw && staticArgsRaw.trim() !== "") {
        const pairs = staticArgsRaw.split('&');
        for (const pair of pairs) {
            const cleanPair = pair.trim();
            if (cleanPair && cleanPair.includes('=')) {
                args.push("-static", cleanPair);
            }
        }
    }

    outputChannel.appendLine(`[启动] 参数: ${JSON.stringify(args)}`);

    try {
        if (process.platform === 'linux') {
            try {
                fs.chmodSync(exePath, '755');
            } catch {}
        }

        clientProcess = cp.spawn(exePath, args, {
            cwd: backendRoot,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (clientProcess.pid) {
            outputChannel.appendLine(`[System] 后端进程 PID: ${clientProcess.pid}`);
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

    // 过滤非真实文件文档，避免把 Output / Debug / Search 之类同步到 Steam
    if (editor && !isRealCodeDocument(editor.document)) {
        outputChannel.appendLine(
            `[Skip] 非真实文件文档: scheme=${editor.document.uri.scheme}, path=${editor.document.fileName}`
        );
        return;
    }

    let statusText = "";

    const config = vscode.workspace.getConfiguration('codeStatus');
    const statusTemplate = config.get<string>('statusTemplate', '[{projectName} | ]正在编写 {folderName}/{fileName}');
    const idleText = config.get<string>('idleText', '正在摸鱼🐟');
    const showEspIdfActivity = config.get<boolean>('showEspIdfActivity', true);

    if (manualOverrideText) {
        statusText = manualOverrideText;
    } else if (showEspIdfActivity && espIdfActivity !== 'none') {
        statusText = getEspIdfStatusText(editor);
    } else {
        if (editor) {
            const doc = editor.document;
            const fullPath = doc.fileName;

            const dirPath = path.dirname(fullPath);
            const folderName = path.basename(dirPath);

            const context = {
                fileName: path.basename(fullPath),
                projectName: vscode.workspace.name,
                language: doc.languageId,
                lineCount: doc.lineCount,
                folderName: folderName,
                filePath: vscode.workspace.asRelativePath(fullPath),
            };

            statusText = StatusFormatter.render(statusTemplate, context);
        } else {
            statusText = idleText;
        }
    }

    try {
        const cleanText = statusText.replace(/[\r\n]/g, ' ');
        clientProcess.stdin?.write(cleanText + "\n");
        outputChannel.appendLine(
            `[Sent]: ${cleanText} ${manualOverrideText ? '(Manual)' : (showEspIdfActivity && espIdfActivity !== 'none' ? '(ESP-IDF)' : '(Auto)')}`
        );
    } catch (e) {
        outputChannel.appendLine(`[Error] 发送状态失败: ${e}`);
    }
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

        let result = template.replace(/\[(.*?)\]/g, (match, content) => {
            const variables = content.match(/\{(\w+)\}/g) || [];

            for (const v of variables) {
                const key = v.replace(/\{|\}/g, '');
                if (this.isEmpty(data[key])) {
                    return '';
                }
            }

            return content;
        });

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
        myStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        if (manualOverrideText) {
            myStatusBarItem.text = "$(lock) Steam: Manual";
            myStatusBarItem.tooltip = `当前手动锁定: ${manualOverrideText}`;
        } else {
            myStatusBarItem.text = "$(megaphone) Steam: On";
            if (groupId) {
                myStatusBarItem.tooltip = `正在同步 | 组队 ID: ${groupId}`;
            } else {
                myStatusBarItem.tooltip = "点击打开设置菜单";
            }
        }
        myStatusBarItem.backgroundColor = undefined;
    }
}
